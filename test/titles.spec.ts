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
 * Fallback tests require Workers AI to reject under the test pool.
 * `remoteBindings: false` in vitest.config.ts causes that rejection. This test
 * catches toolchain changes that would enable remote, billable calls.
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
		// The warning proves that the code attempted Workers AI before using the
		// heading. Without this assertion, skipping Workers AI would also pass.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Different heading and file names identify which fallback ran.
			const doc = await createDoc(uploadBody("# Design Review\n\nbody", { name: "pasted.md" }));
			expect(warn).toHaveBeenCalledWith("ai title failed", expect.any(String));

			expect(doc.title).toBe("Design Review");
			expect((await listRow(doc.id)).title).toBe("Design Review");

			// The rendered blob includes the title for the recipient's browser tab.
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
		// The heading differs from the file name. If HTML incorrectly used automatic
		// titling, this fixture would produce "Not This Title" instead of report.html.
		const source = "# Not This Title\n<p>hi</p>";
		const doc = await createDoc(uploadBody(source, { kind: "html", name: "report.html" }));
		expect(doc.title).toBe("report.html");
		expect((await listRow(doc.id)).title).toBe("report.html");

		// HTML is stored without a wrapper or injected <title>.
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
		// Set the field directly to test server-side trimming of a value that was sent.
		const fd = uploadBody("# Blank Title Heading\n\nbody", { name: "untitled.md" });
		fd.set("title", "   ");

		const doc = await createDoc(fd);
		expect(doc.title).toBe("Blank Title Heading");
		expect((await listRow(doc.id)).title).toBe("Blank Title Heading");
	});
});

/**
 * Test the final fallback directly. `resolveNewTitle` must return a nonblank
 * title when every earlier source is empty.
 *
 * Not reachable through `POST /api/documents`: a multipart part sent with
 * `filename=""` does not arrive as a `File` at all under workerd, so `readUpload`
 * answers 400 "file is required" and `upload.file.name` is never the empty
 * string handled by this branch. The MCP adapter can reach it, so the function
 * still needs direct coverage.
 */
describe("the final title fallback", () => {
	it("never yields a blank title, whatever the caller's fallback", async () => {
		for (const fallback of ["", "   "]) {
			expect(await resolveNewTitle(env, { fallback, kind: "md", source: "prose with no heading" })).toBe("untitled");
			// HTML uses the caller fallback directly and needs the same blank check.
			expect(await resolveNewTitle(env, { fallback, kind: "html", source: "<p>x</p>" })).toBe("untitled");
		}
	});

	it("refuses a blank heading and uses the caller's fallback", async () => {
		// `#` followed by nothing but spaces is a heading as far as the scan goes (see
		// test/title.spec.ts), and it labels a document no better than an empty file
		// name does.
		expect(await resolveNewTitle(env, { fallback: "notes.md", kind: "md", source: "#   \n\nbody" })).toBe("notes.md");
		// With no usable fallback, use the literal "untitled".
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
