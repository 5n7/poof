import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { seedShare } from "./helpers";

const BASE = "https://poof.5n7.me";

async function upload(source: string, kind = "md", title?: string, ttl?: string) {
	const fd = new FormData();
	fd.set("file", new File([source], "test.md"), "test.md");
	fd.set("kind", kind);
	if (title) fd.set("title", title);
	if (ttl) fd.set("ttl", ttl);
	return SELF.fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
}

async function issueShare(id: string, ttl?: string) {
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
		const shRes = await issueShare(doc.id);
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
		const reRes = await issueShare(doc.id, "1h");
		expect(reRes.status).toBe(201);
		const reShare = await reRes.json<{ token: string }>();
		const reView = await SELF.fetch(`${BASE}/raw/${reShare.token}`);
		expect(reView.status).toBe(200);
	});

	it("lists only active shares (excludes revoked and expired)", async () => {
		const up = await upload("# List test", "md");
		const doc = await up.json<{ id: string }>();

		const active = await (await issueShare(doc.id, "1d")).json<{ token: string }>();
		const revoked = await (await issueShare(doc.id, "1d")).json<{ token: string }>();
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
		const doc = await up.json<{ id: string }>();
		const share = await (await issueShare(doc.id)).json<{ token: string }>();
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
