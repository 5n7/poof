import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { resolveNewTitle } from "../src/lib/title";

const BASE = "https://poof.5n7.me";

interface CreateResult {
	id: string;
	title: string;
	kind: string;
	version: number;
	url: string;
}

interface VersionResult {
	id: string;
	version: number;
	kind: string;
	title: string;
}

interface ListRow {
	id: string;
	title: string;
	kind: string;
}

interface UploadOpts {
	kind?: "md" | "html";
	title?: string;
	name?: string;
}

function uploadBody(source: string, opts: UploadOpts = {}): FormData {
	const kind = opts.kind ?? "md";
	const name = opts.name ?? (kind === "html" ? "test.html" : "test.md");
	const fd = new FormData();
	fd.set("file", new File([source], name), name);
	fd.set("kind", kind);
	if (opts.title) fd.set("title", opts.title);
	return fd;
}

async function createDoc(body: FormData): Promise<CreateResult> {
	const res = await SELF.fetch(`${BASE}/api/documents`, { method: "POST", body });
	expect(res.status).toBe(201);
	return res.json<CreateResult>();
}

async function addVersion(id: string, body: FormData): Promise<VersionResult> {
	const res = await SELF.fetch(`${BASE}/api/documents/${id}/versions`, { method: "POST", body });
	expect(res.status).toBe(201);
	return res.json<VersionResult>();
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

/** The stored blob a share recipient is served, asserting a 200 first. */
async function rawText(token: string): Promise<string> {
	const res = await SELF.fetch(`${BASE}/raw/${token}`);
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

/**
 * Every fallback case below leans on Workers AI being unreachable under the test
 * pool, so it is asserted directly rather than assumed. `remoteBindings: false`
 * in vitest.config.ts is what makes `run()` reject; if a toolchain bump ever
 * makes the binding live in-pool, this test fails loudly and says why, instead
 * of the whole suite quietly turning slow, non-deterministic and billable.
 */
describe("the AI binding under the test pool", () => {
	it("exists but cannot be run", async () => {
		expect(env.AI).toBeDefined();
		await expect(
			env.AI.run("@cf/ibm-granite/granite-4.0-h-micro", { messages: [{ role: "user", content: "hi" }] }),
		).rejects.toThrow();
	});
});

describe("automatic titling on POST /api/documents", () => {
	it("tries Workers AI first, then falls back to the document's own heading", async () => {
		// The spy is what makes this discriminate. Without it, an implementation that
		// never calls Workers AI at all passes unchanged — the heading rung answers
		// identically — and the feature would be silently absent. `generateAiTitle`'s
		// catch is the only place the attempt leaves a trace.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// File name and heading differ so the two fallback rungs stay distinguishable.
			const doc = await createDoc(uploadBody("# Design Review\n\nbody", { name: "pasted.md" }));
			expect(warn).toHaveBeenCalledWith("ai title failed", expect.any(String));

			expect(doc.title).toBe("Design Review");
			expect((await listRow(doc.id)).title).toBe("Design Review");

			// The title is baked into the blob, so the recipient's tab reads it too.
			const token = await issueShare(doc.id);
			expect(await rawText(token)).toContain("<title>Design Review</title>");
		} finally {
			warn.mockRestore();
		}
	});

	it("falls back to the file name when the document has no heading", async () => {
		const doc = await createDoc(uploadBody("just some prose, no heading", { name: "pasted.md" }));
		expect(doc.title).toBe("pasted.md");
		expect((await listRow(doc.id)).title).toBe("pasted.md");

		const token = await issueShare(doc.id);
		expect(await rawText(token)).toContain("<title>pasted.md</title>");
	});

	it("skips the naming chain entirely for kind=html and stores the source verbatim", async () => {
		// The body carries a heading the chain WOULD find, and that is the whole point
		// of the fixture: with a plain `<p>hi</p>` body this test passes even with the
		// kind guard deleted, because the chain falls through the heading rung to the
		// same file name. Here, a chain that ran would name the document
		// "Not This Title" instead — no AI needed to tell the two apart.
		const source = "# Not This Title\n<p>hi</p>";
		const doc = await createDoc(uploadBody(source, { kind: "html", name: "report.html" }));
		expect(doc.title).toBe("report.html");
		expect((await listRow(doc.id)).title).toBe("report.html");

		// html is never wrapped, so nothing may be injected into the blob — least of
		// all a <title>.
		const token = await issueShare(doc.id);
		const stored = await rawText(token);
		expect(stored).toBe(source);
		expect(stored).not.toContain("<title>");
	});

	it("uses a supplied title verbatim, over both the heading and the file name", async () => {
		const doc = await createDoc(uploadBody("# Heading Not Used", { name: "file.md", title: "Explicit Title" }));
		expect(doc.title).toBe("Explicit Title");
		expect((await listRow(doc.id)).title).toBe("Explicit Title");

		const token = await issueShare(doc.id);
		const stored = await rawText(token);
		expect(stored).toContain("<title>Explicit Title</title>");
		expect(stored).not.toContain("<title>Heading Not Used</title>");
		expect(stored).not.toContain("<title>file.md</title>");
	});

	it("treats a blank title as absent and runs the naming chain", async () => {
		// Set directly rather than through uploadBody: the point is that the server
		// trims and discards a blank field, not that a client declined to send one.
		const fd = uploadBody("# Blank Title Heading\n\nbody", { name: "untitled.md" });
		fd.set("title", "   ");

		const doc = await createDoc(fd);
		expect(doc.title).toBe("Blank Title Heading");
		expect((await listRow(doc.id)).title).toBe("Blank Title Heading");
	});
});

/**
 * The chain's terminal, driven directly rather than over HTTP. Every rung of it
 * can decline, so the one property that has to hold unconditionally is that what
 * comes out is never blank — an empty title is an empty library row and an empty
 * browser tab.
 *
 * Not reachable through `POST /api/documents`: a multipart part sent with
 * `filename=""` does not arrive as a `File` at all under workerd, so `readUpload`
 * answers 400 "file is required" and `upload.file.name` is never the empty
 * string the guard is written for. It is still the invariant the chain promises,
 * and the MCP adapter reaches it with its own literal fallback, so it is pinned
 * at the level where it can actually be exercised.
 */
describe("the naming chain's terminal", () => {
	it("never yields a blank title, whatever the caller's fallback", async () => {
		for (const fallback of ["", "   "]) {
			expect(await resolveNewTitle(env, { fallback, kind: "md", source: "prose with no heading" })).toBe("untitled");
			// html short-circuits straight to the fallback, so it needs the guard too.
			expect(await resolveNewTitle(env, { fallback, kind: "html", source: "<p>x</p>" })).toBe("untitled");
		}
	});

	it("refuses a blank heading and falls through to the caller's fallback", async () => {
		// `#` followed by nothing but spaces is a heading as far as the scan goes (see
		// test/title.spec.ts), and it labels a document no better than an empty file
		// name does.
		expect(await resolveNewTitle(env, { fallback: "notes.md", kind: "md", source: "#   \n\nbody" })).toBe("notes.md");
		// With no usable fallback either, the chain still ends somewhere sayable.
		expect(await resolveNewTitle(env, { fallback: "", kind: "md", source: "#   \n\nbody" })).toBe("untitled");
	});

	it("trims both the fallback it ends on and the heading it accepts", async () => {
		expect(await resolveNewTitle(env, { fallback: "  notes.md  ", kind: "md", source: "no heading" })).toBe("notes.md");
		expect(
			await resolveNewTitle(env, { fallback: "notes.md", kind: "md", source: "#  Padded Heading  \n\nbody" }),
		).toBe("Padded Heading");
	});
});

describe("automatic titling is create-only", () => {
	it("keeps the original title on a new version whose heading says otherwise", async () => {
		const doc = await createDoc(uploadBody("# t1", { name: "orig.md", title: "Original" }));
		const token = await issueShare(doc.id);

		// A heading that could not plausibly be the document's title if auto-naming
		// leaked into the version route.
		const v2 = await addVersion(doc.id, uploadBody("# Completely Different Heading", { name: "v2.md" }));
		expect(v2.version).toBe(2);
		expect(v2.title).toBe("Original");
		expect((await listRow(doc.id)).title).toBe("Original");

		const stored = await rawText(token);
		expect(stored).toContain("<title>Original</title>");
		expect(stored).toContain("<h1>Completely Different Heading</h1>");
		expect(stored).not.toContain("<title>Completely Different Heading</title>");
		expect(stored).not.toContain("<title>v2.md</title>");
	});
});
