import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { attachmentDisposition, inferFileBytes } from "../src/lib/content";
import { getLiveDocument } from "../src/lib/db";
import { MAX_BYTES, createDocument } from "../src/lib/documents";
import { MAX_UPLOAD_BYTES } from "../src/lib/files";
import { mintOwnerToken } from "../src/lib/tokens";
import { OWNER_BASE, fetchWorker } from "./helpers";

const now = () => Math.floor(Date.now() / 1000);

async function upload(bytes: Uint8Array, filename: string, type = "", id?: string, title?: string) {
	const body = new FormData();
	body.set("file", new Blob([bytes], { type }), filename);
	if (title) body.set("title", title);
	const res = await SELF.fetch(`${OWNER_BASE}/api/documents${id ? `/${id}/versions` : ""}`, { method: "POST", body });
	expect(res.status).toBe(201);
	return res.json<{ id: string; kind: string }>();
}

async function content(id: string, query = "") {
	const res = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/content${query}`);
	expect(res.status).toBe(200);
	return res;
}

async function viewer(id: string, version?: number) {
	const token = await mintOwnerToken(id, env.OWNER_TOKEN_SECRET, undefined, version);
	return SELF.fetch(`${OWNER_BASE}/raw/${token}`);
}

describe("original file storage and readable content", () => {
	it("preserves Markdown BOM, CRLF, Unicode, and trailing whitespace in R2 and source reads", async () => {
		const bytes = new TextEncoder().encode("\ufeff# 日本語\r\n\r\ntext  \r\n");
		const { id } = await upload(bytes, "notes.md");
		const doc = await getLiveDocument(env.DB, id, now());
		expect(doc).toMatchObject({
			kind: "md",
			filename: "notes.md",
			media_type: "text/markdown",
		});
		const blob = await env.BLOBS.get(doc!.r2_key);
		expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
		for (const query of ["", "?format=raw"]) {
			expect(new Uint8Array(await (await content(id, query)).arrayBuffer())).toEqual(bytes);
		}
		expect(await (await viewer(id)).text()).toContain("<h1>日本語</h1>");
	});

	it("keeps HTML exact for raw reads while removing executable and decorative content from cat", async () => {
		const source =
			"<!doctype html><style>large stylesheet</style><h1>Report</h1><p><a href='https://example.com'>Reference</a></p><script>secretCode()</script>";
		const { id } = await upload(new TextEncoder().encode(source), "report.html");
		const readable = await (await content(id)).text();
		expect(readable).toContain("# Report");
		expect(readable).toContain("[Reference](https://example.com)");
		expect(readable).not.toContain("stylesheet");
		expect(readable).not.toContain("secretCode");
		expect(await (await content(id, "?format=raw")).text()).toBe(source);
		expect(await (await viewer(id)).text()).toBe(source);
	});

	it("preserves binary bytes and returns a useful summary instead of decoding them", async () => {
		const bytes = new Uint8Array([0, 255, 128, 10, 13, 42]);
		const { id, kind } = await upload(bytes, "資料.bin");
		expect(kind).toBe("file");
		const readable = await (await content(id)).text();
		expect(readable).toContain("資料.bin");
		expect(readable).toContain("6 bytes");
		expect(readable).toContain(`poof cat ${id} --raw`);
		expect(readable).not.toContain("\u0000");
		const raw = await content(id, "?format=raw");
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
		expect(raw.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(raw.headers.get("Content-Disposition")).toContain("filename*=UTF-8''%E8%B3%87%E6%96%99.bin");
		expect(raw.headers.get("Content-Security-Policy")).toBe("sandbox");
		expect(await (await viewer(id)).text()).toContain("no browser preview");
	});

	it("recognizes extensionless UTF-8 text but retains known binary types", async () => {
		const bytes = new TextEncoder().encode("FROM alpine\nRUN echo '<script>'\n");
		const { id, kind } = await upload(bytes, "Dockerfile");
		expect(kind).toBe("text");
		expect(new Uint8Array(await (await content(id)).arrayBuffer())).toEqual(bytes);
		const html = await (await viewer(id)).text();
		expect(html).toContain("&lt;script&gt;");
		expect(inferFileBytes("image.pdf", "", bytes.buffer).kind).toBe("file");
		expect(inferFileBytes("unknown", "", new Uint8Array([0]).buffer).kind).toBe("file");
	});

	it("serves uploaded mjs modules with executable JavaScript MIME and exact source bytes", async () => {
		const source = 'export const title = "Design";\n';
		const { id, kind } = await upload(new TextEncoder().encode(source), "app.mjs");
		expect(kind).toBe("text");
		const token = await mintOwnerToken(id, env.OWNER_TOKEN_SECRET);
		const response = await SELF.fetch(`${OWNER_BASE}/raw/${token}/app.mjs`);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/javascript");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(await response.text()).toBe(source);
	});

	it("accepts filenames whose extensions match object prototype properties", async () => {
		const bytes = new Uint8Array([0, 255, 128, 10]);
		for (const filename of ["file.constructor", "file.__proto__", "file.toString"]) {
			const { id, kind } = await upload(bytes, filename);
			expect(kind).toBe("file");
			expect(new Uint8Array(await (await content(id, "?format=raw")).arrayBuffer())).toEqual(bytes);
		}
	});

	it("shows PDF download metadata within the sandbox and keeps original bytes available", async () => {
		const bytes = new TextEncoder().encode("%PDF-1.7\noriginal PDF bytes\n%%EOF");
		const { id, kind } = await upload(bytes, "report.pdf");
		expect(kind).toBe("file");
		const preview = await viewer(id);
		expect(preview.status).toBe(200);
		expect(preview.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(preview.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-popups");
		const html = await preview.text();
		expect(html).toContain("report.pdf");
		expect(html).toContain("application/pdf");
		expect(html).toContain("Use the download button");
		expect(new Uint8Array(await (await content(id, "?format=raw")).arrayBuffer())).toEqual(bytes);
	});

	it("restores versioned files while keeping the live title and historical title snapshots", async () => {
		const { id } = await upload(new TextEncoder().encode("# One"), "one.md", "", undefined, "Original");
		await upload(new TextEncoder().encode("# Two"), "two.md", "", id, "Renamed");
		expect(await (await viewer(id, 1)).text()).toContain("<title>Original</title>");
		expect(await (await viewer(id, 2)).text()).toContain("<title>Renamed</title>");
		const rollback = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/versions/1/rollback`, { method: "POST" });
		expect(rollback.status).toBe(200);
		expect(await (await viewer(id)).text()).toContain("<title>Renamed</title>");
		const raw = await content(id, "?format=raw");
		expect(raw.headers.get("Content-Disposition")).toContain('filename="one.md"');
		expect(await raw.text()).toBe("# One");
	});

	it("serves supported binary previews with their media type and the same sandbox", async () => {
		const { id } = await upload(new Uint8Array([137, 80, 78, 71]), "picture.png");
		const res = await viewer(id);
		expect(res.headers.get("Content-Type")).toBe("image/png");
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-popups");
		expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
	});

	it("coalesces one-byte upload chunks into bounded buffers and preserves the file", async () => {
		const bytes = new Uint8Array(128 * 1024 + 17);
		bytes[0] = 255;
		bytes[bytes.length - 1] = 42;
		const form = new FormData();
		form.set("file", new Blob([bytes]), "tiny-chunks.zip");
		const encoded = new Response(form);
		const multipart = new Uint8Array(await encoded.arrayBuffer());
		let offset = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === multipart.byteLength) controller.close();
				else controller.enqueue(Uint8Array.of(multipart[offset++]));
			},
		});
		const OriginalBlob = Blob;
		const observedParts: number[][] = [];
		vi.stubGlobal(
			"Blob",
			class extends OriginalBlob {
				constructor(...args: ConstructorParameters<typeof OriginalBlob>) {
					super(...args);
					const parts = args[0] ?? [];
					if (parts.every((part) => part instanceof Uint8Array)) {
						observedParts.push((parts as Uint8Array[]).map((part) => part.byteLength));
					}
				}
			},
		);
		let result: Response;
		try {
			result = await fetchWorker(
				`${OWNER_BASE}/api/documents`,
				{},
				{
					method: "POST",
					headers: encoded.headers,
					body: stream,
				},
			);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(result.status).toBe(201);
		expect(observedParts).toEqual([[64 * 1024, 64 * 1024, multipart.byteLength - 128 * 1024]]);
		const { id } = await result.json<{ id: string }>();
		expect(new Uint8Array(await (await content(id, "?format=raw")).arrayBuffer())).toEqual(bytes);
	});

	it("accepts exactly 10 MiB of source bytes despite multipart overhead", async () => {
		const bytes = new Uint8Array(MAX_BYTES);
		bytes[0] = 255;
		bytes[MAX_BYTES - 1] = 42;
		const { id } = await upload(bytes, "limit.zip");
		const returned = new Uint8Array(await (await content(id, "?format=raw")).arrayBuffer());
		expect(returned.byteLength).toBe(MAX_BYTES);
		expect(returned[0]).toBe(255);
		expect(returned[MAX_BYTES - 1]).toBe(42);
	});

	it("rejects a source over 10 MiB even without a Content-Length header", async () => {
		const body = new FormData();
		body.set("file", new Blob([new Uint8Array(MAX_BYTES + 1)]), "large.zip");
		const encoded = new Response(body);
		expect(encoded.headers.has("Content-Length")).toBe(false);
		const res = await fetchWorker(
			`${OWNER_BASE}/api/documents`,
			{},
			{
				method: "POST",
				headers: encoded.headers,
				body: encoded.body,
			},
		);
		expect(res.status).toBe(413);
		expect(await res.text()).toBe("Payload Too Large");
	});

	it("rejects an oversized declared request before parsing its body", async () => {
		const res = await fetchWorker(
			`${OWNER_BASE}/api/documents`,
			{},
			{
				method: "POST",
				headers: { "Content-Length": String(MAX_UPLOAD_BYTES + 1) },
				body: "small",
			},
		);
		expect(res.status).toBe(413);
		expect(await res.text()).toBe("Payload Too Large");
	});

	it("bounds the entire multipart request even when source data is small", async () => {
		const body = new FormData();
		body.set("file", new Blob(["small"]), "small.txt");
		body.set("extra", "x".repeat(MAX_UPLOAD_BYTES));
		const encoded = new Response(body);
		const res = await fetchWorker(
			`${OWNER_BASE}/api/documents`,
			{},
			{
				method: "POST",
				headers: encoded.headers,
				body: encoded.body,
			},
		);
		expect(res.status).toBe(413);
		expect(await res.text()).toBe("Payload Too Large");
	});

	it("rejects oversized original bytes before writing and safely encodes download names", async () => {
		await expect(
			createDocument(env, now(), {
				source: new ArrayBuffer(MAX_BYTES + 1),
				kind: "file",
				title: "Big",
				expires_at: null,
			}),
		).rejects.toThrow("over the");
		expect(attachmentDisposition('bad\r\n"name.txt')).not.toMatch(/[\r\n]/);
		const res = await SELF.fetch(`${OWNER_BASE}/api/documents/missing/content?format=html`);
		expect(res.status).toBe(400);
	});
});
