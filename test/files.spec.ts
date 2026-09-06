import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { runCleanup } from "../src/cron";
import { getLiveDocument, getLiveDocumentAtVersion, getVersion, listVersionFiles, listVersions } from "../src/lib/db";
import { MAX_BYTES, addVersion, createDocument, rollbackDocument } from "../src/lib/documents";
import { MAX_FILES, MAX_PATH_BYTES, validateFilePath } from "../src/lib/files";
import { OWNER_BASE } from "./helpers";

const now = () => Math.floor(Date.now() / 1000);
const file = (path: string, source = path) => ({ path, kind: "md" as const, source });

async function create() {
	return createDocument(env, now(), {
		title: "Design",
		expires_at: null,
		files: [file("overview.md", "# Overview"), file("adr/001.md", "# Decision\r\n")],
	});
}

async function current(id: string) {
	const doc = await getLiveDocument(env.DB, id, now());
	expect(doc).not.toBeNull();
	return doc!;
}

function upload(files: [string, string][], deleted: string[] = []) {
	const body = new FormData();
	for (const [path, source] of files) {
		body.append("file", new Blob([source]), path.split("/").at(-1)!);
		body.append("path", path);
	}
	for (const path of deleted) body.append("delete", path);
	body.append("title", "Design");
	return body;
}

describe("document file snapshots", () => {
	it("migrates old filenames to safe paths without rewriting source keys or names", async () => {
		await env.DB.prepare(`CREATE TABLE migration_document_version (
			document_id TEXT, version INTEGER, filename TEXT, kind TEXT, media_type TEXT, r2_key TEXT,
			PRIMARY KEY (document_id, version))`).run();
		const names = ["report.md", "../secret.md", "a%2fb.md", "a?b.md", "a#b.md", "a\\b.md", "a\u0000.md", "日本語.md"];
		for (let i = 0; i < names.length; i++)
			await env.DB.prepare("INSERT INTO migration_document_version VALUES (?, 1, ?, 'md', 'text/markdown', ?)")
				.bind(`old-${i}`, names[i], `doc/old-${i}.html`)
				.run();
		const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0004"))!;
		await env.DB.batch(
			migration.queries.map((query) =>
				env.DB.prepare(
					query
						.replaceAll("document_version", "migration_document_version")
						.replaceAll("document_file", "migration_document_file"),
				),
			),
		);
		const { results } = await env.DB.prepare("SELECT * FROM migration_document_file ORDER BY document_id").all<{
			path: string;
			filename: string;
			r2_key: string;
		}>();
		for (let i = 0; i < results.length; i++) {
			expect(() => validateFilePath(results[i]!.path)).not.toThrow();
			expect(results[i]!.filename).toBe(names[i]);
			expect(results[i]!.r2_key).toBe(`doc/old-${i}.html`);
		}
		expect(results[0]!.path).toBe("report.md");
	});

	it("merges paths, preserves original bytes, deletes explicitly, and restores the whole set", async () => {
		const id = await create();
		const original = await listVersionFiles(env.DB, id, 1);
		await addVersion(env, await current(id), now(), {
			title: null,
			files: [file("overview.md", "# Revised"), file("adr/002.md")],
		});
		const second = await listVersionFiles(env.DB, id, 2);
		expect(second.map((entry) => entry.path)).toEqual(["overview.md", "adr/001.md", "adr/002.md"]);
		expect(second[1]!.r2_key).toBe(original[1]!.r2_key);
		expect(await (await env.BLOBS.get(second[1]!.r2_key))!.text()).toBe("# Decision\r\n");
		await addVersion(env, await current(id), now(), { title: null, files: [], delete_paths: ["adr/001.md"] });
		expect((await listVersionFiles(env.DB, id, 3)).map((entry) => entry.path)).toEqual(["overview.md", "adr/002.md"]);
		await rollbackDocument(env, await current(id), 1, now());
		expect((await current(id)).version).toBe(1);
		expect((await listVersionFiles(env.DB, id, 1)).map((entry) => entry.path)).toEqual(["overview.md", "adr/001.md"]);
	});

	it("keeps other files when a legacy client updates one source", async () => {
		const id = await create();
		await addVersion(env, await current(id), now(), {
			title: null,
			filename: "overview.md",
			kind: "md",
			source: "new",
		});
		expect((await listVersionFiles(env.DB, id, 2)).map((entry) => entry.path)).toEqual(["overview.md", "adr/001.md"]);
	});

	it("keeps reused and historical blobs during cleanup", async () => {
		const id = await create();
		const original = await listVersionFiles(env.DB, id, 1);
		await addVersion(env, await current(id), now(), { title: null, files: [file("overview.md", "new")] });
		await runCleanup(env, now());
		for (const entry of original) expect(await env.BLOBS.head(entry.r2_key)).not.toBeNull();
	});

	it("rejects stale writers without changing the published snapshot", async () => {
		const id = await create();
		const stale = await current(id);
		await addVersion(env, stale, now(), { title: null, files: [file("new.md")] });
		await expect(addVersion(env, stale, now(), { title: null, files: [file("lost.md")] })).rejects.toMatchObject({
			status: 409,
		});
		expect((await current(id)).version).toBe(2);
		expect((await listVersionFiles(env.DB, id, 2)).map((entry) => entry.path)).toContain("new.md");
		expect(await getVersion(env.DB, id, 3)).toBeNull();
	});

	it("hides staged versions and preserves the current snapshot when a blob write fails", async () => {
		const id = await create();
		const originalPut = env.BLOBS.put.bind(env.BLOBS);
		let calls = 0;
		const put = vi.spyOn(env.BLOBS, "put").mockImplementation(async (...args) => {
			calls++;
			expect((await listVersions(env.DB, id)).map((version) => version.version)).toEqual([1]);
			expect(await getLiveDocumentAtVersion(env.DB, id, 2, now())).toBeNull();
			expect(await rollbackDocument(env, await current(id), 2, now())).toBeNull();
			if (calls === 2) throw new Error("injected upload failure");
			return originalPut(...args);
		});
		try {
			await expect(
				addVersion(env, await current(id), now(), {
					title: null,
					files: [file("overview.md", "new"), file("other.md")],
				}),
			).rejects.toThrow("injected upload failure");
		} finally {
			put.mockRestore();
		}
		expect((await current(id)).version).toBe(1);
		expect(await getVersion(env.DB, id, 2)).toBeNull();
		expect(await env.BLOBS.head(`doc/${id}/v2.html`)).toBeNull();
	});

	it("rejects empty snapshots, duplicate paths, and aggregate oversized uploads", async () => {
		const id = await create();
		const doc = await current(id);
		await expect(
			addVersion(env, doc, now(), { title: null, files: [], delete_paths: ["overview.md", "adr/001.md"] }),
		).rejects.toThrow("at least one file");
		await expect(addVersion(env, doc, now(), { title: null, files: [file("x.md"), file("x.md")] })).rejects.toThrow(
			"Duplicate",
		);
		await expect(
			addVersion(env, doc, now(), {
				title: null,
				files: [file("x.md", "x".repeat(MAX_BYTES / 2 + 1)), file("y.md", "y".repeat(MAX_BYTES / 2))],
			}),
		).rejects.toMatchObject({ status: 413 });
	});

	it.each([
		"/a.md",
		"../a.md",
		"a/../b.md",
		"a//b.md",
		"a\\b.md",
		"%2e%2e/a.md",
		"a%2fb.md",
		"a?b.md",
		"a#b.md",
		"https:foo",
		"a\u0000.md",
	])("rejects ambiguous path %j", (path) => {
		expect(() => validateFilePath(path)).toThrow("Invalid file path");
	});

	it("accepts relative nested Unicode paths", () => {
		expect(validateFilePath("ADR/決定 001.md")).toBe("ADR/決定 001.md");
	});

	it("accepts the aggregate byte limit with the maximum count of long multipart paths", async () => {
		const entries: [string, string][] = Array.from({ length: MAX_FILES }, (_, index) => {
			const name = `${index}.txt`;
			const path = `${"a".repeat(250)}/${"b".repeat(MAX_PATH_BYTES - 252 - name.length)}/${name}`;
			return [path, index === 0 ? "x".repeat(MAX_BYTES) : ""];
		});
		const response = await SELF.fetch(`${OWNER_BASE}/api/documents`, { method: "POST", body: upload(entries) });
		expect(response.status).toBe(201);
		const { id } = await response.json<{ id: string }>();
		expect((await listVersionFiles(env.DB, id, 1)).length).toBe(MAX_FILES);
	});

	it("supports mixed multipart files, path-specific content, and delete-only updates", async () => {
		const response = await SELF.fetch(`${OWNER_BASE}/api/documents`, {
			method: "POST",
			body: upload([
				["design.md", "# Design"],
				["site/index.html", "<h1>Page</h1>"],
			]),
		});
		expect(response.status).toBe(201);
		const { id } = await response.json<{ id: string }>();
		const content = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/content?file=site%2Findex.html&format=raw`);
		expect(await content.text()).toBe("<h1>Page</h1>");
		const listed = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/files`);
		const body = await listed.json<{ files: { path: string; kind: string }[] }>();
		expect(body.files.map(({ path, kind }) => ({ path, kind }))).toEqual([
			{ path: "design.md", kind: "md" },
			{ path: "site/index.html", kind: "html" },
		]);
		expect(JSON.stringify(body)).not.toContain("r2_key");
		const update = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/versions`, {
			method: "POST",
			body: upload([], ["site/index.html"]),
		});
		expect(update.status).toBe(201);
		expect((await listVersionFiles(env.DB, id, 2)).map((entry) => entry.path)).toEqual(["design.md"]);
	});
});
