import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { seedDoc, seedShare } from "./helpers";

const BASE = "https://poof.5n7.me";

// The global test env sets DEV_DISABLE_ACCESS="1" (auth skipped). To exercise
// the real Access-enforcement path we call the worker directly with the flag
// cleared, keeping the live DB/BLOBS bindings. An empty string is falsy for the
// `=== "1"` check, so `accessAuth` runs in full.
const accessEnv: Env = { ...env, DEV_DISABLE_ACCESS: "" };

async function fetchWith(path: string, init?: RequestInit) {
	const ctx = createExecutionContext();
	const res = await worker.fetch!(new Request(`${BASE}${path}`, init), accessEnv, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** A minimal valid "add version" multipart body. */
function versionBody() {
	const fd = new FormData();
	fd.set("file", new File(["# new version"], "v.md"), "v.md");
	fd.set("kind", "md");
	return fd;
}

/** Seed a document (+blob) and a live share directly. */
async function seed(id: string, token: string) {
	await seedDoc(id, { title: "access doc", body: "<html><body>access doc</body></html>" });
	await seedShare(token, id, { expiresAt: ((Date.now() / 1000) | 0) + 3600 });
}

describe("Access enforcement (DEV_DISABLE_ACCESS unset)", () => {
	it("rejects /api/documents without the Cf-Access-Jwt-Assertion header (403)", async () => {
		const res = await fetchWith("/api/documents");
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("rejects the library page GET / without the Access header (403)", async () => {
		const res = await fetchWith("/");
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("rejects the owner viewer GET /d/:id without the Access header (403)", async () => {
		const res = await fetchWith("/d/doc_someid");
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("rejects the pinned owner viewer GET /d/:id?v=1 without the Access header (403)", async () => {
		// The version pin must not be a hole in Access: only the owner may mint a
		// pinned o_ token, so this page has to stay behind it.
		const res = await fetchWith("/d/doc_someid?v=1");
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("rejects the version API routes without the Access header (403)", async () => {
		const requests: [string, RequestInit | undefined][] = [
			["/api/documents/doc_someid/versions", { method: "POST", body: versionBody() }],
			["/api/documents/doc_someid/versions", undefined],
			["/api/documents/doc_someid/versions/1/rollback", { method: "POST" }],
		];
		for (const [path, init] of requests) {
			const res = await fetchWith(path, init);
			expect(res.status).toBe(403);
			expect(await res.text()).toBe("Forbidden");
		}
	});

	it("keeps /v/* reachable (not behind Access)", async () => {
		const id = "access_v_doc";
		const token = "s_accessvshare0000000000";
		await seed(id, token);

		const ok = await fetchWith(`/v/${token}`);
		expect(ok.status).toBe(200);

		// A missing token resolves to 404 (route ran), never 403.
		const missing = await fetchWith("/v/s_nonexistent000000000");
		expect(missing.status).toBe(404);
	});

	it("keeps /raw/* reachable (not behind Access)", async () => {
		const id = "access_raw_doc";
		const token = "s_accessrawshare00000000";
		await seed(id, token);

		const ok = await fetchWith(`/raw/${token}`);
		expect(ok.status).toBe(200);

		const missing = await fetchWith("/raw/garbage-token");
		expect(missing.status).toBe(404);
	});
});

// CSRF guard runs under the default test env (DEV_DISABLE_ACCESS="1"), so auth
// is not the thing being exercised here — only the Sec-Fetch-Site check.
describe("CSRF protection on state-changing API routes", () => {
	async function seededDoc() {
		const id = `csrf_${crypto.randomUUID().slice(0, 8)}`;
		const token = `s_csrfseed${Math.random().toString(36).slice(2, 12)}`;
		await seed(id, token);
		return id;
	}

	it("rejects a cross-site POST even though auth passes (403)", async () => {
		const id = await seededDoc();
		const res = await SELF.fetch(`${BASE}/api/documents/${id}/shares`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
			body: JSON.stringify({ ttl: "1d" }),
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("allows a same-origin POST", async () => {
		const id = await seededDoc();
		const res = await SELF.fetch(`${BASE}/api/documents/${id}/shares`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
			body: JSON.stringify({ ttl: "1d" }),
		});
		expect(res.status).toBe(201);
	});

	it("allows a POST with no Sec-Fetch-Site header (non-browser clients)", async () => {
		const id = await seededDoc();
		const res = await SELF.fetch(`${BASE}/api/documents/${id}/shares`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: "1d" }),
		});
		expect(res.status).toBe(201);
	});

	it("guards POST /api/documents/:id/versions the same way", async () => {
		const id = await seededDoc();

		const cross = await SELF.fetch(`${BASE}/api/documents/${id}/versions`, {
			method: "POST",
			headers: { "Sec-Fetch-Site": "cross-site" },
			body: versionBody(),
		});
		expect(cross.status).toBe(403);
		expect(await cross.text()).toBe("Forbidden");

		const same = await SELF.fetch(`${BASE}/api/documents/${id}/versions`, {
			method: "POST",
			headers: { "Sec-Fetch-Site": "same-origin" },
			body: versionBody(),
		});
		expect(same.status).toBe(201);

		const bare = await SELF.fetch(`${BASE}/api/documents/${id}/versions`, {
			method: "POST",
			body: versionBody(),
		});
		expect(bare.status).toBe(201);
	});

	it("guards POST /api/documents/:id/versions/:version/rollback the same way", async () => {
		const id = await seededDoc();
		const url = `${BASE}/api/documents/${id}/versions/1/rollback`;

		const cross = await SELF.fetch(url, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } });
		expect(cross.status).toBe(403);
		expect(await cross.text()).toBe("Forbidden");

		// Version 1 is already current, so these are idempotent 200s.
		const same = await SELF.fetch(url, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } });
		expect(same.status).toBe(200);

		const bare = await SELF.fetch(url, { method: "POST" });
		expect(bare.status).toBe(200);
	});
});
