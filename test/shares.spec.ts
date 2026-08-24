import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getLiveShare } from "../src/lib/db";
import { issueShare } from "../src/lib/documents";
import { seedDoc, seedShare } from "./helpers";

const BASE = "https://poof.5n7.me";

async function upload(source: string, kind = "md", title?: string, ttl?: string) {
	const fd = new FormData();
	fd.set("file", new File([source], "test.md"), "test.md");
	fd.set("kind", kind);
	if (title) fd.set("title", title);
	if (ttl) fd.set("ttl", ttl);
	return SELF.fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
}

/** The API adapter — named apart from the core `issueShare` this file also exercises. */
async function postShare(id: string, ttl?: string) {
	return SELF.fetch(`${BASE}/api/documents/${id}/shares`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(ttl ? { ttl } : {}),
	});
}

describe("share lifecycle through the API", () => {
	it("uploads, shares (default 1d TTL), views, revokes, and re-issues", async () => {
		const upRes = await upload("# Hello\n\nbody text", "md", "My Doc");
		expect(upRes.status).toBe(201);
		const doc = await upRes.json<{ id: string; url: string; title: string }>();
		expect(doc.title).toBe("My Doc");
		expect(doc.url).toBe(`/d/${doc.id}`);

		// Issue a share with the default TTL (1 day).
		const before = (Date.now() / 1000) | 0;
		const shRes = await postShare(doc.id);
		expect(shRes.status).toBe(201);
		const share = await shRes.json<{ token: string; expires_at: number; url: string }>();
		expect(share.token.startsWith("s_")).toBe(true);
		expect(share.url).toBe(`/v/${share.token}`);
		// Default TTL = now + 86400 (allow a couple seconds of clock drift).
		expect(share.expires_at).toBeGreaterThanOrEqual(before + 86400);
		expect(share.expires_at).toBeLessThanOrEqual(before + 86400 + 5);

		// Public viewer renders a sandboxed iframe pointing at the raw share URL.
		const vRes = await SELF.fetch(`${BASE}/v/${share.token}`);
		expect(vRes.status).toBe(200);
		const vHtml = await vRes.text();
		expect(vHtml).toContain('sandbox="allow-scripts allow-popups"');
		expect(vHtml).toContain(`/raw/${share.token}`);
		expect(vHtml).not.toContain("allow-same-origin");

		// Raw share endpoint serves the rendered document.
		const rawRes = await SELF.fetch(`${BASE}/raw/${share.token}`);
		expect(rawRes.status).toBe(200);
		expect(await rawRes.text()).toContain("<h1>Hello</h1>");

		// Revoke → both /v and /raw 404 immediately.
		const revRes = await SELF.fetch(`${BASE}/api/shares/${share.token}`, { method: "DELETE" });
		expect(revRes.status).toBe(200);
		expect(await revRes.json()).toEqual({ revoked: true });

		const vAfter = await SELF.fetch(`${BASE}/v/${share.token}`);
		expect(vAfter.status).toBe(404);
		expect(await vAfter.text()).toBe("Not Found");
		const rawAfter = await SELF.fetch(`${BASE}/raw/${share.token}`);
		expect(rawAfter.status).toBe(404);

		// Re-issuing a new share for the same document works.
		const reRes = await postShare(doc.id, "1h");
		expect(reRes.status).toBe(201);
		const reShare = await reRes.json<{ token: string }>();
		const reView = await SELF.fetch(`${BASE}/raw/${reShare.token}`);
		expect(reView.status).toBe(200);
	});

	it("lists only active shares (excludes revoked and expired)", async () => {
		const up = await upload("# List test", "md");
		const doc = await up.json<{ id: string; title: string }>();
		// Untitled: the naming chain fell back from AI to the document's own heading.
		expect(doc.title).toBe("List test");

		const active = await (await postShare(doc.id, "1d")).json<{ token: string }>();
		const revoked = await (await postShare(doc.id, "1d")).json<{ token: string }>();
		await SELF.fetch(`${BASE}/api/shares/${revoked.token}`, { method: "DELETE" });

		// Seed an already-expired share directly.
		const t = (Date.now() / 1000) | 0;
		await seedShare("s_expiredlisttest0000000", doc.id, { createdAt: t, expiresAt: t - 10 });

		const listRes = await SELF.fetch(`${BASE}/api/documents/${doc.id}/shares`);
		const { shares } = await listRes.json<{ shares: { token: string }[] }>();
		const tokens = shares.map((s) => s.token);
		expect(tokens).toContain(active.token);
		expect(tokens).not.toContain(revoked.token);
		expect(tokens).not.toContain("s_expiredlisttest0000000");
	});

	it("cascades deletion: share token 404s and R2 blob is gone", async () => {
		const up = await upload("# Cascade", "md");
		const doc = await up.json<{ id: string; title: string }>();
		// Untitled: the naming chain fell back from AI to the document's own heading.
		expect(doc.title).toBe("Cascade");
		const share = await (await postShare(doc.id)).json<{ token: string }>();
		const r2Key = `doc/${doc.id}/v1.html`;

		expect(await env.BLOBS.get(r2Key)).not.toBeNull();

		const delRes = await SELF.fetch(`${BASE}/api/documents/${doc.id}`, { method: "DELETE" });
		expect(delRes.status).toBe(200);
		expect(await delRes.json()).toEqual({ deleted: true });

		// Blob removed and share token no longer resolves.
		expect(await env.BLOBS.get(r2Key)).toBeNull();
		const rawRes = await SELF.fetch(`${BASE}/raw/${share.token}`);
		expect(rawRes.status).toBe(404);

		// Second delete of the same id is a 404.
		const delAgain = await SELF.fetch(`${BASE}/api/documents/${doc.id}`, { method: "DELETE" });
		expect(delAgain.status).toBe(404);
	});

	it("rejects uploads over 10 MiB with 413", async () => {
		const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
		const fd = new FormData();
		fd.set("file", new File([tooBig], "big.md"), "big.md");
		fd.set("kind", "md");
		const res = await SELF.fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
		expect(res.status).toBe(413);
	});

	it("embeds a working o_ raw URL in the owner viewer page", async () => {
		const up = await upload("# Owner view\n\ncontent here", "md", "Owner Doc");
		const doc = await up.json<{ id: string }>();

		const dRes = await SELF.fetch(`${BASE}/d/${doc.id}`);
		expect(dRes.status).toBe(200);
		const dHtml = await dRes.text();
		expect(dHtml).toContain('sandbox="allow-scripts allow-popups"');

		// Extract the minted o_ token from the iframe src and fetch it.
		const match = dHtml.match(/\/raw\/(o_[^"]+)/);
		expect(match).not.toBeNull();
		const oToken = match![1];
		const rawRes = await SELF.fetch(`${BASE}/raw/${oToken}`);
		expect(rawRes.status).toBe(200);
		expect(await rawRes.text()).toContain("<h1>Owner view</h1>");
	});
});

// Precedence, not merely outcome. When both preconditions fail the 404 has to
// win, or a 400 becomes a way for anyone to ask whether an id exists. The order
// lives in the core now (see `issueShare`); this pins what it looks like from
// outside, so the next attempt to move it cannot pass silently.
describe("refusing to issue a share through the API", () => {
	it("answers 404 for an unknown id even when the ttl is invalid too", async () => {
		const res = await postShare("no_such_document", "1y");
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not Found");
	});

	it("answers 404 for an unknown id with a valid ttl", async () => {
		expect((await postShare("no_such_document", "1d")).status).toBe(404);
	});

	it("answers 400 for an invalid ttl on a live document", async () => {
		const doc = await (await upload("# Bad ttl", "md")).json<{ id: string }>();

		const res = await postShare(doc.id, "1y");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid ttl" });
	});

	it("treats a body that is not JSON as no ttl at all, i.e. the 1d default", async () => {
		const doc = await (await upload("# No body", "md")).json<{ id: string }>();

		const before = (Date.now() / 1000) | 0;
		const res = await SELF.fetch(`${BASE}/api/documents/${doc.id}/shares`, { method: "POST" });
		expect(res.status).toBe(201);
		const share = await res.json<{ expires_at: number }>();
		expect(share.expires_at).toBeGreaterThanOrEqual(before + 86400);
		expect(share.expires_at).toBeLessThanOrEqual(before + 86400 + 5);
	});
});

// Straight at the core, not through an adapter. "Live documents only" is the
// core's rule (SPEC §11.5), and verifying it only via `/api` and `/mcp` is what
// let it be a comment copied into two route files in the first place.
describe("issueShare", () => {
	const now = (Date.now() / 1000) | 0;

	it("refuses an owner-expired document and inserts nothing", async () => {
		await seedDoc("core_share_expired", { createdAt: now - 7200, expiresAt: now - 3600 });

		expect(await issueShare(env, "core_share_expired", now, "1d")).toEqual({ ok: false, reason: "not-found" });

		const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM share WHERE document_id = ?")
			.bind("core_share_expired")
			.first<{ n: number }>();
		expect(rows!.n).toBe(0);
	});

	it("resolves the document before it parses the ttl", async () => {
		await seedDoc("core_share_live", { createdAt: now });

		// Unknown id + bad ttl is "not there", never "bad ttl" — the order the API's
		// 404-over-400 comes from. The second call is what makes that a real choice
		// rather than a function that only ever says not-found.
		expect(await issueShare(env, "core_share_missing", now, "1y")).toEqual({ ok: false, reason: "not-found" });
		expect(await issueShare(env, "core_share_live", now, "1y")).toEqual({ ok: false, reason: "invalid-ttl" });
	});

	it("inserts the row it hands back", async () => {
		await seedDoc("core_share_ok", { createdAt: now });

		const issued = await issueShare(env, "core_share_ok", now, "1h");
		if (!issued.ok) throw new Error(`expected a share, got ${issued.reason}`);

		expect(issued.share.document_id).toBe("core_share_ok");
		expect(issued.share.expires_at).toBe(now + 3600);
		expect(await getLiveShare(env.DB, issued.share.token, now)).toEqual(issued.share);
	});
});
