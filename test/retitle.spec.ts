import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getLiveDocument, getVersion, listVersionFiles, listVersions } from "../src/lib/db";
import {
	addVersion,
	createDocument,
	documentTitleState,
	normalizeDocumentTitle,
	renameDocument,
	rollbackDocument,
	suggestDocumentTitle,
} from "../src/lib/documents";
import * as time from "../src/lib/time";
import * as titleGenerator from "../src/lib/title";
import { mintOwnerToken } from "../src/lib/tokens";
import { fetchWorker, OWNER_BASE, seedShare } from "./helpers";

async function expectation(id: string) {
	return { expected_state: await documentTitleState({ id, title: "Original", current_version: 1 }) };
}
async function document(files = [{ path: "notes.md", kind: "md" as const, source: "# Original source" }]) {
	return createDocument(env, 100, { title: "Original", expires_at: null, files });
}
function titleRequest(body: unknown, method = "PATCH"): RequestInit {
	return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

afterEach(() => vi.restoreAllMocks());

describe("document title changes", () => {
	it("renames only live metadata, preserves source and historical titles, and keeps no-op timestamps", async () => {
		const id = await document();
		const expected = await expectation(id);
		const files = await listVersionFiles(env.DB, id, 1);
		const renamed = await renameDocument(env, id, "  New\n name  ", expected);
		expect(renamed.title).toBe("New name");
		expect(renamed.current_version).toBe(1);
		expect(await listVersionFiles(env.DB, id, 1)).toEqual(files);
		expect(await listVersions(env.DB, id)).toHaveLength(1);
		expect((await getVersion(env.DB, id, 1))?.title).toBe("Original");
		expect(await (await env.BLOBS.get(files[0]!.r2_key))!.text()).toBe("# Original source");
		const noOp = await renameDocument(env, id, "New name", { expected_state: renamed.state });
		expect(noOp.updated_at).toBe(renamed.updated_at);
	});

	it("allows only one of two simultaneous renames with the same snapshot", async () => {
		const id = await document();
		const expected = await expectation(id);
		const results = await Promise.allSettled([
			renameDocument(env, id, "First", expected),
			renameDocument(env, id, "Second", expected),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const failed = results.find((result) => result.status === "rejected");
		expect(failed).toMatchObject({ reason: { status: 409 } });
	});

	it("checks expiry atomically when it passes between the read and the write", async () => {
		const id = await createDocument(env, 0, { title: "Original", expires_at: 2, kind: "md", source: "body" });
		const expected = await expectation(id);
		vi.spyOn(time, "nowSeconds").mockReturnValueOnce(1).mockReturnValue(3);
		await expect(renameDocument(env, id, "Too late", expected)).rejects.toMatchObject({ status: 404 });
		expect((await getLiveDocument(env.DB, id, 1))?.title).toBe("Original");
	});

	it("normalizes whitespace and counts Unicode code points while rejecting hidden controls", () => {
		expect(normalizeDocumentTitle("  A\t\nB　 C  ")).toBe("A B C");
		expect(normalizeDocumentTitle("🌱".repeat(200))).toHaveLength(400);
		for (const value of [null, " ", "A\u0000B", "A\u202eB", "A\ud800B", "x".repeat(201)]) {
			expect(() => normalizeDocumentTitle(value)).toThrow();
		}
		expect(normalizeDocumentTitle("می\u200cروم")).toBe("می\u200cروم");
	});

	it("rejects stale rename and content upload snapshots without adding history", async () => {
		const id = await document();
		const expected = await expectation(id);
		const original = (await getLiveDocument(env.DB, id, 100))!;
		await renameDocument(env, id, "Manual", expected);
		await expect(renameDocument(env, id, "Stale", expected)).rejects.toMatchObject({ status: 409 });
		await expect(addVersion(env, original, 200, { kind: "md", source: "new", title: null })).rejects.toMatchObject({
			status: 409,
		});
		expect(await listVersions(env.DB, id)).toHaveLength(1);
	});

	it("uses the live name in Markdown viewers and keeps pinned version titles after rollback", async () => {
		const id = await document();
		const expected = await expectation(id);
		await renameDocument(env, id, "Live name", expected);
		const live = await mintOwnerToken(id, env.OWNER_TOKEN_SECRET);
		const pinned = await mintOwnerToken(id, env.OWNER_TOKEN_SECRET, 600, 1);
		expect(await (await SELF.fetch(`${OWNER_BASE}/raw/${live}`)).text()).toContain("<title>Live name</title>");
		expect(await (await SELF.fetch(`${OWNER_BASE}/raw/${pinned}`)).text()).toContain("<title>Original</title>");
		const doc = (await getLiveDocument(env.DB, id, 100))!;
		await addVersion(env, doc, 200, { kind: "md", source: "updated body", title: null });
		await rollbackDocument(env, (await getLiveDocument(env.DB, id, 200))!, 1, 300);
		expect((await getLiveDocument(env.DB, id, 300))?.title).toBe("Live name");
	});
});

describe("title suggestions", () => {
	it("uses bounded text from multiple files and removes HTML scripts without changing anything", async () => {
		const id = await createDocument(env, 100, {
			title: "Original",
			expires_at: null,
			files: [
				{ path: "photo.png", kind: "file", source: "binary-secret" },
				{ path: "one.md", kind: "md", source: "First readable note " + "a".repeat(10000) },
				{ path: "two.html", kind: "html", source: "<script>script-secret</script><p>Second readable note</p>" },
			],
		});
		const expected = await expectation(id);
		const ai = vi.spyOn(titleGenerator, "generateAiTitle").mockResolvedValue("Suggested");
		expect(await suggestDocumentTitle(env, id, expected)).toEqual({ title: "Suggested", ...expected });
		const source = ai.mock.calls[0]![1];
		expect(source.length).toBeLessThanOrEqual(2000);
		expect(source).toContain("First readable note");
		expect(source).toContain("Second readable note");
		expect(source).not.toContain("binary-secret");
		expect(source).not.toContain("script-secret");
		expect((await getLiveDocument(env.DB, id, 100))?.title).toBe("Original");
		expect((await getLiveDocument(env.DB, id, 100))?.updated_at).toBe(100);
	});

	it("rejects missing source blobs before inference", async () => {
		const id = await document();
		const expected = await expectation(id);
		const [file] = await listVersionFiles(env.DB, id, 1);
		await env.BLOBS.delete(file!.r2_key);
		const ai = vi.spyOn(titleGenerator, "generateAiTitle").mockResolvedValue("Suggested");
		await expect(suggestDocumentTitle(env, id, expected)).rejects.toMatchObject({ status: 404 });
		expect(ai).not.toHaveBeenCalled();
	});

	it("keeps language detection free of English filename labels and rejects unusable candidates", async () => {
		const id = await document([{ path: "english-filename.md", kind: "md", source: "明日の会議は十時から" }]);
		const expected = await expectation(id);
		const ai = vi.spyOn(titleGenerator, "generateAiTitle").mockResolvedValue("  会議の予定  ");
		expect((await suggestDocumentTitle(env, id, expected)).title).toBe("会議の予定");
		expect(ai.mock.calls[0]![2]).toBe("明日の会議は十時から");
		ai.mockResolvedValue("bad\ud800title");
		await expect(suggestDocumentTitle(env, id, expected)).rejects.toMatchObject({ status: 503 });
	});

	it("detects rename, content changes, deletion and expiry during inference", async () => {
		for (const change of ["rename", "content", "delete", "expire"] as const) {
			const id = await document();
			const expected = await expectation(id);
			vi.spyOn(titleGenerator, "generateAiTitle").mockImplementation(async () => {
				if (change === "rename") await renameDocument(env, id, "Another name", expected);
				if (change === "content")
					await addVersion(env, (await getLiveDocument(env.DB, id, 100))!, 200, {
						kind: "md",
						source: "updated",
						title: null,
					});
				if (change === "delete") await env.DB.prepare("DELETE FROM document WHERE id = ?").bind(id).run();
				if (change === "expire") await env.DB.prepare("UPDATE document SET expires_at = 1 WHERE id = ?").bind(id).run();
				return "Stale suggestion";
			});
			await expect(suggestDocumentTitle(env, id, expected)).rejects.toMatchObject({
				status: change === "rename" || change === "content" ? 409 : 404,
			});
			vi.restoreAllMocks();
		}
	});

	it("does not call AI for binary-only or empty documents and reports AI failure", async () => {
		const ai = vi.spyOn(titleGenerator, "generateAiTitle").mockResolvedValue(null);
		for (const kind of ["file", "html", "text"] as const) {
			const id = await createDocument(env, 100, {
				title: "Original",
				expires_at: null,
				files: [{ path: "file", kind, source: kind === "html" ? "<style>body{}</style>" : "" }],
			});
			const expected = await expectation(id);
			await expect(suggestDocumentTitle(env, id, expected)).rejects.toMatchObject({ status: 422 });
		}
		expect(ai).not.toHaveBeenCalled();
		const id = await document();
		await expect(suggestDocumentTitle(env, id, await expectation(id))).rejects.toMatchObject({ status: 503 });
	});
});

describe("title API", () => {
	it("shortens a long legacy title using a fixed-size state token", async () => {
		const legacyTitle = "L".repeat(17000);
		const form = new FormData();
		form.set("file", new File(["# Body"], "note.md"));
		form.set("title", legacyTitle);
		const created = await SELF.fetch(`${OWNER_BASE}/api/documents`, { method: "POST", body: form });
		expect(created.status).toBe(201);
		const { id } = await created.json<{ id: string }>();
		const metadata = await (
			await SELF.fetch(`${OWNER_BASE}/api/documents/${id}`)
		).json<{ title: string; state: string }>();
		expect(metadata.title).toBe(legacyTitle);
		expect(metadata.state).toMatch(/^[a-f0-9]{64}$/);
		const body = { title: "Short title", expected_state: metadata.state };
		expect(JSON.stringify(body).length).toBeLessThan(200);
		const renamed = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/title`, titleRequest(body));
		expect(renamed.status).toBe(200);
		expect(await renamed.json()).toMatchObject({ title: "Short title", current_version: 1 });
		expect((await getVersion(env.DB, id, 1))?.title).toBe(legacyTitle);
	});

	it("preserves joined Unicode titles in state tokens and binds tokens to the document", async () => {
		const id = await document();
		const renamed = await renameDocument(env, id, "می\u200cروم 👨\u200d👩\u200d👧", await expectation(id));
		const metadata = await (await SELF.fetch(`${OWNER_BASE}/api/documents/${id}`)).json<{ state: string }>();
		expect(metadata.state).toBe(renamed.state);
		const shortened = await SELF.fetch(
			`${OWNER_BASE}/api/documents/${id}/title`,
			titleRequest({ title: "Family", expected_state: metadata.state }),
		);
		expect(shortened.status).toBe(200);
		const otherId = await document();
		await expect(renameDocument(env, otherId, "Other", { expected_state: renamed.state })).rejects.toMatchObject({
			status: 409,
		});
		for (const expected_state of ["", "z".repeat(64), "a".repeat(63), null, 1]) {
			expect(
				(
					await SELF.fetch(
						`${OWNER_BASE}/api/documents/${id}/title`,
						titleRequest({ title: "Invalid", expected_state }),
					)
				).status,
			).toBe(400);
		}
	});

	it("returns a suggestion without persistence through the API adapter", async () => {
		const id = await document();
		const expected = await expectation(id);
		vi.spyOn(titleGenerator, "generateAiTitle").mockResolvedValue("API suggestion");
		const res = await fetchWorker(
			`${OWNER_BASE}/api/documents/${id}/title-suggestion`,
			{},
			titleRequest(expected, "POST"),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ title: "API suggestion", ...expected });
		expect((await getLiveDocument(env.DB, id, 100))?.title).toBe("Original");
	});

	it("bounds chunked and oversized JSON requests before parsing", async () => {
		const id = await document();
		const expected = await expectation(id);
		const bytes = new TextEncoder().encode(JSON.stringify({ ...expected, title: "x".repeat(20000) }));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, 10000));
				controller.enqueue(bytes.subarray(10000));
				controller.close();
			},
		});
		const res = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/title`, {
			method: "PATCH",
			body,
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: "Title request is too large." });
		expect((await getLiveDocument(env.DB, id, 100))?.title).toBe("Original");
	});

	it("returns narrow metadata, validates JSON and snapshots, escapes names and updates shared viewers", async () => {
		const id = await document();
		const expected = await expectation(id);
		const snapshot = await (await SELF.fetch(`${OWNER_BASE}/api/documents/${id}`)).json();
		expect(snapshot).toEqual({
			id,
			title: "Original",
			current_version: 1,
			updated_at: 100,
			state: expected.expected_state,
		});
		for (const body of [[], null, {}, { ...expected, title: 5 }, { ...expected, title: "" }]) {
			expect((await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/title`, titleRequest(body))).status).toBe(400);
		}
		const token = "s_retitle_share00000000000";
		await seedShare(token, id, { expiresAt: Math.floor(Date.now() / 1000) + 3600 });
		const res = await SELF.fetch(
			`${OWNER_BASE}/api/documents/${id}/title`,
			titleRequest({ ...expected, title: "<script>changed</script>" }),
		);
		expect(res.status).toBe(200);
		for (const path of [`/d/${id}`, `/v/${token}`, `/raw/${token}`, "/"]) {
			expect(await (await SELF.fetch(`${OWNER_BASE}${path}`)).text()).toContain("&lt;script&gt;changed&lt;/script&gt;");
		}
		expect(
			(await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/title`, titleRequest({ ...expected, title: "Stale" })))
				.status,
		).toBe(409);
	});

	it("keeps missing, expired and unauthorized documents unavailable and rejects cross-origin writes", async () => {
		const id = await document();
		const expected = await expectation(id);
		for (const method of ["PATCH", "POST"]) {
			const suffix = method === "PATCH" ? "title" : "title-suggestion";
			const init = titleRequest({ ...expected, title: "Name" }, method);
			expect((await SELF.fetch(`${OWNER_BASE}/api/documents/missing/${suffix}`, init)).status).toBe(404);
			expect(
				(await fetchWorker(`${OWNER_BASE}/api/documents/${id}/${suffix}`, { DEV_DISABLE_ACCESS: "" }, init)).status,
			).toBe(403);
			expect(
				(
					await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/${suffix}`, {
						...init,
						headers: { ...init.headers, "Sec-Fetch-Site": "cross-site" },
					})
				).status,
			).toBe(403);
		}
		await env.DB.prepare("UPDATE document SET expires_at = 1 WHERE id = ?").bind(id).run();
		expect(
			(await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/title`, titleRequest({ ...expected, title: "Name" })))
				.status,
		).toBe(404);
	});
});
