import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { headerDump, seedDoc, seedVersion } from "./helpers";

const BASE = "https://poof.5n7.me";

interface CreateResult {
	id: string;
	title: string;
	kind: string;
	version: number;
	created_at: number;
	updated_at: number;
	expires_at: number | null;
	url: string;
}

interface VersionResult {
	id: string;
	version: number;
	kind: string;
	title: string;
	updated_at: number;
	url: string;
}

interface VersionsList {
	current_version: number;
	versions: { version: number; kind: string; created_at: number }[];
}

interface ListRow {
	id: string;
	title: string;
	kind: string;
	created_at: number;
	updated_at: number;
	current_version: number;
	expires_at: number | null;
}

interface UploadOpts {
	kind?: "md" | "html";
	title?: string;
	ttl?: string;
	name?: string;
}

function uploadBody(source: string, opts: UploadOpts = {}): FormData {
	const kind = opts.kind ?? "md";
	const name = opts.name ?? (kind === "html" ? "test.html" : "test.md");
	const fd = new FormData();
	fd.set("file", new File([source], name), name);
	fd.set("kind", kind);
	if (opts.title) fd.set("title", opts.title);
	if (opts.ttl) fd.set("ttl", opts.ttl);
	return fd;
}

/** Create a document through the real API. */
async function createDoc(source: string, opts: UploadOpts = {}): Promise<CreateResult> {
	const res = await SELF.fetch(`${BASE}/api/documents`, { method: "POST", body: uploadBody(source, opts) });
	expect(res.status).toBe(201);
	return res.json<CreateResult>();
}

/** Add a version through the real API. */
async function addVersion(id: string, source: string, opts: UploadOpts = {}): Promise<VersionResult> {
	const res = await SELF.fetch(`${BASE}/api/documents/${id}/versions`, {
		method: "POST",
		body: uploadBody(source, opts),
	});
	expect(res.status).toBe(201);
	return res.json<VersionResult>();
}

async function getVersions(id: string): Promise<VersionsList> {
	const res = await SELF.fetch(`${BASE}/api/documents/${id}/versions`);
	expect(res.status).toBe(200);
	return res.json<VersionsList>();
}

async function rollback(id: string, version: number | string): Promise<Response> {
	return SELF.fetch(`${BASE}/api/documents/${id}/versions/${version}/rollback`, { method: "POST" });
}

async function issueShare(id: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/api/documents/${id}/shares`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	expect(res.status).toBe(201);
	return (await res.json<{ token: string }>()).token;
}

/** Body served for a token, asserting a 200 before checking its contents. */
async function rawText(token: string, query = ""): Promise<string> {
	const res = await SELF.fetch(`${BASE}/raw/${token}${query}`);
	expect(res.status).toBe(200);
	return res.text();
}

async function contentRes(id: string, query = ""): Promise<Response> {
	return SELF.fetch(`${BASE}/api/documents/${id}/content${query}`);
}

/** Stored HTML served for a document, asserting a 200 first (like rawText). */
async function contentText(id: string, query = ""): Promise<string> {
	const res = await contentRes(id, query);
	expect(res.status).toBe(200);
	return res.text();
}

async function listRow(id: string): Promise<ListRow> {
	const res = await SELF.fetch(`${BASE}/api/documents`);
	expect(res.status).toBe(200);
	const { documents } = await res.json<{ documents: ListRow[] }>();
	const row = documents.find((d) => d.id === id);
	expect(row).toBeDefined();
	return row!;
}

async function viewerPage(path: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}${path}`);
	expect(res.status).toBe(200);
	return res.text();
}

/** The o_ token the owner viewer minted into its iframe src. */
function ownerTokenIn(html: string): string {
	const match = html.match(/\/raw\/(o_[^"]+)/);
	expect(match).not.toBeNull();
	return match![1];
}

describe("share links follow the latest version", () => {
	it("serves the new content on a token issued before the update, with the token unchanged", async () => {
		const doc = await createDoc("# v1 content", { title: "Follow latest" });
		const token = await issueShare(doc.id);

		expect(await rawText(token)).toContain("<h1>v1 content</h1>");

		const v2 = await addVersion(doc.id, "# v2 content");
		expect(v2.version).toBe(2);

		// The original token now returns v2 and no longer returns v1.
		const after = await rawText(token);
		expect(after).toContain("<h1>v2 content</h1>");
		expect(after).not.toContain("v1 content");

		// The public viewer page still resolves too.
		const vRes = await SELF.fetch(`${BASE}/v/${token}`);
		expect(vRes.status).toBe(200);
		expect(await vRes.text()).toContain(`/raw/${token}`);

		// The update did not create another share row.
		const sharesRes = await SELF.fetch(`${BASE}/api/documents/${doc.id}/shares`);
		const { shares } = await sharesRes.json<{ shares: { token: string }[] }>();
		expect(shares.map((s) => s.token)).toEqual([token]);
	});

	it("keeps serving the current version when a ?v= query is appended to a share token", async () => {
		const doc = await createDoc("# first", { title: "No pinning" });
		const token = await issueShare(doc.id);
		await addVersion(doc.id, "# second");

		// Only signed o_ payloads can select a version. Share holders cannot select
		// past versions through the query string.
		const pinned = await rawText(token, "?v=1");
		expect(pinned).toContain("<h1>second</h1>");
		expect(pinned).not.toContain("first");
	});
});

describe("GET /api/documents/:id/versions", () => {
	it("lists versions newest first with current_version and without r2_key", async () => {
		const doc = await createDoc("# one", { title: "History" });
		await addVersion(doc.id, "# two");

		const body = await getVersions(doc.id);
		expect(body.current_version).toBe(2);
		expect(body.versions.map((v) => v.version)).toEqual([2, 1]);
		expect(body.versions.map((v) => v.kind)).toEqual(["md", "md"]);
		for (const v of body.versions) {
			expect(Object.keys(v).sort()).toEqual(["created_at", "kind", "version"]);
			expect(typeof v.created_at).toBe("number");
		}
		expect(JSON.stringify(body)).not.toContain("r2_key");
	});

	it("404s for an unknown document and for an owner-expired one", async () => {
		const now = (Date.now() / 1000) | 0;
		await seedDoc("ver_get_expired", { expiresAt: now - 10 });

		for (const id of ["ver_get_missing", "ver_get_expired"]) {
			const res = await SELF.fetch(`${BASE}/api/documents/${id}/versions`);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("Not Found");
		}
	});
});

describe("GET /api/documents/:id/content", () => {
	it("serves exactly what a share link serves, following the pointer through updates and rollbacks", async () => {
		const doc = await createDoc("# v1 content", { title: "Cat" });
		const token = await issueShare(doc.id);
		expect(await contentText(doc.id)).toBe(await rawText(token));

		await addVersion(doc.id, "# v2 content");
		const after = await contentText(doc.id);
		expect(after).toBe(await rawText(token));
		expect(after).toContain("<h1>v2 content</h1>");

		expect((await rollback(doc.id, 1)).status).toBe(200);
		const rolled = await contentText(doc.id);
		expect(rolled).toBe(await rawText(token));
		expect(rolled).toContain("<h1>v1 content</h1>");
	});

	it("pins a past version with ?v=N while the default stays on the current one", async () => {
		const doc = await createDoc("# first", { title: "Cat pin" });
		await addVersion(doc.id, "# second");

		const pinned = await contentText(doc.id, "?v=1");
		expect(pinned).toContain("<h1>first</h1>");
		expect(pinned).not.toContain("second");
		expect(await contentText(doc.id)).toContain("<h1>second</h1>");
	});

	it("serves the same bytes with and without a ?v= naming the current version", async () => {
		const doc = await createDoc("# first", { title: "Cat current pin" });
		await addVersion(doc.id, "# second");

		const pinned = await contentText(doc.id, "?v=2");
		expect(pinned).toBe(await contentText(doc.id));
		expect(pinned).toContain("<h1>second</h1>");
	});

	it("still serves a version above current_version after a rollback", async () => {
		const doc = await createDoc("# first", { title: "Cat rolled back" });
		await addVersion(doc.id, "# second");
		expect((await rollback(doc.id, 1)).status).toBe(200);

		expect(await contentText(doc.id)).toContain("<h1>first</h1>");
		// A rollback moves only the pointer, so versions above it remain readable.
		expect(await contentText(doc.id, "?v=2")).toContain("<h1>second</h1>");
	});

	it("returns the md wrapper for an md version and the html verbatim for an html one", async () => {
		const doc = await createDoc("# md one", { title: "Cat kinds" });
		const md = await contentText(doc.id);
		expect(md).toContain("<h1>md one</h1>");
		expect(md).toContain("markdown-body");

		await addVersion(doc.id, "<p>raw</p>", { kind: "html" });
		expect(await contentText(doc.id)).toBe("<p>raw</p>");
		// The md version is still reachable behind the pin, wrapper and all.
		expect(await contentText(doc.id, "?v=1")).toContain("markdown-body");
	});

	it("400s for a malformed ?v=", async () => {
		const doc = await createDoc("# a", { title: "Cat 400" });
		for (const v of ["abc", "0", "-1", "1.5"]) {
			const res = await contentRes(doc.id, `?v=${v}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid version" });
		}
	});

	it("404s for a well-formed but unknown version", async () => {
		const doc = await createDoc("# a", { title: "Cat 404" });
		const res = await contentRes(doc.id, "?v=9");
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not Found");
	});

	it("404s for an unknown document and for an owner-expired one, pinned or not", async () => {
		const now = (Date.now() / 1000) | 0;
		await seedDoc("ver_content_expired", { expiresAt: now - 10 });

		for (const id of ["ver_content_missing", "ver_content_expired"]) {
			// "?v=1" names a version that does exist on the expired document, so it
			// covers the pinned lookup rather than falling out as an unknown version.
			for (const query of ["", "?v=1"]) {
				const res = await contentRes(id, query);
				expect(res.status).toBe(404);
				expect(await res.text()).toBe("Not Found");
			}
		}
	});

	it("404s for a staged version whose blob is missing", async () => {
		const id = "ver_content_blobless";
		await seedDoc(id);
		// Exactly what a crash between phase 1 and phase 2 of an upload leaves behind.
		await seedVersion(id, 2, { body: null, setCurrent: false });

		const res = await contentRes(id, "?v=2");
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not Found");
		// The current version still returns its original bytes.
		expect(await contentText(id)).toBe("<html><body>doc</body></html>");
	});

	it("serves untrusted HTML as inert text, never as markup", async () => {
		const source = "<p>hi</p><script>alert(1)</script>";
		const doc = await createDoc(source, { kind: "html", title: "Cat headers" });
		const res = await contentRes(doc.id);
		expect(res.status).toBe(200);
		// The response body stays unchanged. Its headers make the script inert.
		expect(await res.text()).toBe(source);
		expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");

		const all = headerDump(res);
		expect(all).not.toContain("allow-scripts");
		expect(all).not.toContain("allow-same-origin");
	});

	it("carries the same inert headers on a 404 as on a 200", async () => {
		const res = await contentRes("ver_content_headers_missing");
		expect(res.status).toBe(404);
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Cache-Control")).toBe("no-store");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
	});
});

describe("GET /d/:id?v=N read-only viewer", () => {
	it("serves the past version through a minted o_ token, read-only", async () => {
		const doc = await createDoc("# one", { title: "Pinned" });
		await addVersion(doc.id, "# two");

		const html = await viewerPage(`/d/${doc.id}?v=1`);
		expect(html).toContain('class="banner"');
		expect(html).toContain("read-only");
		expect(html).toContain('id="ver-restore"');
		// No Share button and no uploader wiring on a past version.
		expect(html).not.toContain('id="share-current"');
		expect(html).not.toContain('id="drop"');

		const body = await rawText(ownerTokenIn(html));
		expect(body).toContain("<h1>one</h1>");
		expect(body).not.toContain("<h1>two</h1>");
	});

	it("renders the normal viewer when ?v= names the current version", async () => {
		const doc = await createDoc("# only", { title: "Current pin" });
		const html = await viewerPage(`/d/${doc.id}?v=1`);
		expect(html).toContain('id="share-current"');
		expect(html).toContain('id="drop"');
		expect(html).not.toContain('class="banner"');
	});

	it("404s on a malformed or unknown ?v=", async () => {
		const doc = await createDoc("# only", { title: "Bad pin" });
		for (const v of ["0", "abc", "1.5", "-1", "2"]) {
			const res = await SELF.fetch(`${BASE}/d/${doc.id}?v=${v}`);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("Not Found");
		}
	});
});

describe("rollback", () => {
	it("moves the pointer back and still numbers the next upload MAX(version) + 1", async () => {
		const doc = await createDoc("# a", { title: "Rollback" });
		await addVersion(doc.id, "# b");
		const v3 = await addVersion(doc.id, "# c");
		expect(v3.version).toBe(3);

		const token = await issueShare(doc.id);
		expect(await rawText(token)).toContain("<h1>c</h1>");

		const res = await rollback(doc.id, 1);
		expect(res.status).toBe(200);
		const body = await res.json<{ current_version: number; updated_at: number }>();
		expect(body.current_version).toBe(1);
		expect(typeof body.updated_at).toBe("number");

		// Shares follow the pointer, and history is untouched by a rollback.
		expect(await rawText(token)).toContain("<h1>a</h1>");
		const after = await getVersions(doc.id);
		expect(after.current_version).toBe(1);
		expect(after.versions.map((v) => v.version)).toEqual([3, 2, 1]);

		// The regression guard: MAX(version) + 1 = 4, never current_version + 1 = 2.
		const v4 = await addVersion(doc.id, "# d");
		expect(v4.version).toBe(4);
		const final = await getVersions(doc.id);
		expect(final.current_version).toBe(4);
		expect(final.versions.map((v) => v.version)).toEqual([4, 3, 2, 1]);
		expect(await rawText(token)).toContain("<h1>d</h1>");
	});

	it("404s for a well-formed but unknown version", async () => {
		const doc = await createDoc("# a", { title: "Rollback 404" });
		const res = await rollback(doc.id, 9);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not Found");
	});

	it("404s for a version whose blob is missing and leaves current_version where it was", async () => {
		const id = "ver_rollback_blobless";
		await seedDoc(id);
		// Exactly what a crash between phase 1 and phase 2 of an upload leaves behind.
		await seedVersion(id, 2, { body: null, setCurrent: false });

		const res = await rollback(id, 2);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not Found");
		expect((await getVersions(id)).current_version).toBe(1);

		// A version with a stored blob can still be restored.
		await seedVersion(id, 3);
		expect((await rollback(id, 1)).status).toBe(200);
		expect((await getVersions(id)).current_version).toBe(1);
	});

	it("400s for a malformed :version", async () => {
		const doc = await createDoc("# a", { title: "Rollback 400" });
		for (const raw of ["abc", "0", "-1", "1.5"]) {
			const res = await rollback(doc.id, raw);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid version" });
		}
	});

	it("is an idempotent no-op on the current version and does not bump updated_at", async () => {
		const doc = await createDoc("# a", { title: "Rollback noop" });
		const v2 = await addVersion(doc.id, "# b");

		const res = await rollback(doc.id, 2);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ current_version: 2, updated_at: v2.updated_at });
		expect((await listRow(doc.id)).updated_at).toBe(v2.updated_at);
	});

	it("404s for an unknown document and for an owner-expired one", async () => {
		const now = (Date.now() / 1000) | 0;
		await seedDoc("ver_rollback_expired", { expiresAt: now - 10 });

		for (const id of ["ver_rollback_missing", "ver_rollback_expired"]) {
			const res = await rollback(id, 1);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("Not Found");
		}
	});
});

describe("kind across versions", () => {
	it("switches from md to html and back while preserving raw html bytes", async () => {
		const doc = await createDoc("# md one", { title: "Kind" });
		const token = await issueShare(doc.id);
		const first = await rawText(token);
		expect(first).toContain("<h1>md one</h1>");
		expect(first).toContain("markdown-body");
		expect((await listRow(doc.id)).kind).toBe("md");

		// Store an HTML version without a wrapViewerHtml wrapper.
		const v2 = await addVersion(doc.id, "<p>raw</p>", { kind: "html" });
		expect(v2.kind).toBe("html");
		expect(await rawText(token)).toBe("<p>raw</p>");
		expect((await listRow(doc.id)).kind).toBe("html");

		// Back to md: the wrapper returns.
		await addVersion(doc.id, "# md three");
		const third = await rawText(token);
		expect(third).toContain("<h1>md three</h1>");
		expect(third).toContain("markdown-body");
		expect((await listRow(doc.id)).kind).toBe("md");
	});
});

describe("title on a new version", () => {
	it("keeps the current title when none is sent and replaces it when one is", async () => {
		const doc = await createDoc("# t1", { title: "Original" });
		const token = await issueShare(doc.id);

		const kept = await addVersion(doc.id, "# t2");
		expect(kept.title).toBe("Original");
		expect((await listRow(doc.id)).title).toBe("Original");
		expect(await viewerPage(`/d/${doc.id}`)).toContain("<title>Original</title>");
		expect(await rawText(token)).toContain("<title>Original</title>");

		const renamed = await addVersion(doc.id, "# t3", { title: "Renamed" });
		expect(renamed.title).toBe("Renamed");
		expect((await listRow(doc.id)).title).toBe("Renamed");
		expect(await viewerPage(`/d/${doc.id}`)).toContain("<title>Renamed</title>");
		// The new blob was rendered with the new title.
		expect(await rawText(token)).toContain("<title>Renamed</title>");
	});
});

describe("POST /api/documents/:id/versions", () => {
	it("404s for an unknown document and for an owner-expired one", async () => {
		const now = (Date.now() / 1000) | 0;
		await seedDoc("ver_post_expired", { expiresAt: now - 10 });

		for (const id of ["ver_post_missing", "ver_post_expired"]) {
			const res = await SELF.fetch(`${BASE}/api/documents/${id}/versions`, {
				method: "POST",
				body: uploadBody("# nope"),
			});
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("Not Found");
		}
	});

	it("rejects bad uploads with the same status and body as POST /api/documents", async () => {
		const doc = await createDoc("# parity", { title: "Parity" });
		const versionsUrl = `${BASE}/api/documents/${doc.id}/versions`;
		const createUrl = `${BASE}/api/documents`;

		const missingFile = () => {
			const fd = new FormData();
			fd.set("kind", "md");
			return fd;
		};
		const badKind = () => {
			const fd = new FormData();
			fd.set("file", new File(["x"], "x.md"), "x.md");
			fd.set("kind", "pdf");
			return fd;
		};
		const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
		const oversize = () => {
			const fd = new FormData();
			fd.set("file", new File([tooBig], "big.md"), "big.md");
			fd.set("kind", "md");
			return fd;
		};

		const cases: [() => FormData, number, string][] = [
			[missingFile, 400, JSON.stringify({ error: "file is required" })],
			[badKind, 400, JSON.stringify({ error: "kind must be 'md' or 'html'" })],
			[oversize, 413, "Payload Too Large"],
		];

		for (const [body, status, expected] of cases) {
			const create = await SELF.fetch(createUrl, { method: "POST", body: body() });
			const version = await SELF.fetch(versionsUrl, { method: "POST", body: body() });
			expect(create.status).toBe(status);
			expect(version.status).toBe(status);
			expect(await create.text()).toBe(expected);
			expect(await version.text()).toBe(expected);
		}
	});
});

describe("DELETE /api/documents/:id", () => {
	it("removes the blob of every version", async () => {
		const doc = await createDoc("# a", { title: "Delete all" });
		await addVersion(doc.id, "# b");
		await addVersion(doc.id, "# c");
		const token = await issueShare(doc.id);
		const keys = [1, 2, 3].map((n) => `doc/${doc.id}/v${n}.html`);
		for (const key of keys) expect(await env.BLOBS.get(key)).not.toBeNull();

		const res = await SELF.fetch(`${BASE}/api/documents/${doc.id}`, { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: true });

		for (const key of keys) expect(await env.BLOBS.get(key)).toBeNull();
		const raw = await SELF.fetch(`${BASE}/raw/${token}`);
		expect(raw.status).toBe(404);
	});
});

describe("GET /api/documents", () => {
	it("reports current_version and updated_at and never exposes r2_key", async () => {
		const doc = await createDoc("# a", { title: "List fields" });
		expect(doc.version).toBe(1);
		expect(doc.updated_at).toBe(doc.created_at);

		const fresh = await listRow(doc.id);
		expect(Object.keys(fresh).sort()).toEqual([
			"created_at",
			"current_version",
			"expires_at",
			"id",
			"kind",
			"title",
			"updated_at",
		]);
		expect(fresh.current_version).toBe(1);
		expect(fresh.updated_at).toBe(fresh.created_at);

		const v2 = await addVersion(doc.id, "# b", { kind: "html", name: "b.html" });
		const updated = await listRow(doc.id);
		expect(updated.current_version).toBe(2);
		expect(updated.updated_at).toBe(v2.updated_at);
		expect(updated.created_at).toBe(doc.created_at);
		expect(updated.kind).toBe("html");

		// A rollback is reflected as a pointer move, not as a new version.
		expect((await rollback(doc.id, 1)).status).toBe(200);
		const rolled = await listRow(doc.id);
		expect(rolled.current_version).toBe(1);
		expect(rolled.kind).toBe("md");
	});
});
