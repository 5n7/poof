import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { getLiveDocument } from "../src/lib/db";
import { addVersion, createDocument } from "../src/lib/documents";
import {
	fileNavigationScript,
	linkDocumentFiles,
	rawFileUrl,
	resolveFileLink,
	viewerFileUrl,
} from "../src/lib/file-links";
import { mintOwnerToken } from "../src/lib/tokens";
import { OWNER_BASE, seedShare } from "./helpers";

const now = () => Math.floor(Date.now() / 1000);

function clickFileLink(href: string) {
	const preventDefault = vi.fn();
	const postMessage = vi.fn();
	let click: (event: unknown) => void = () => {
		throw new Error("Click listener was not registered");
	};
	const script = fileNavigationScript("s_navigation", ["README.md", "adr/001.md"]);
	// Execute the emitted browser script with just its DOM boundary stubbed.
	new Function("document", "window", "location", script.slice("<script>".length, -"</script>".length))(
		{
			addEventListener: (_name: string, listener: typeof click) => {
				click = listener;
			},
		},
		{ parent: { postMessage } },
		new URL(`${OWNER_BASE}/raw/s_navigation/README.md?view=1`),
	);
	click({
		button: 0,
		target: { closest: () => ({ href, target: "", hasAttribute: () => false }) },
		preventDefault,
	});
	return { preventDefault, postMessage };
}

async function seedFiles() {
	const id = await createDocument(env, now(), {
		title: "Design decisions",
		expires_at: null,
		files: [
			{ path: "README.md", kind: "md", source: "# Overview\n[Decision](adr/001.md)\n![Diagram](assets/diagram.svg)" },
			{ path: "adr/001.md", kind: "md", source: "# Decision\n[Overview](../README.md)" },
			{
				path: "prototype/index.html",
				kind: "html",
				source:
					'<!doctype html><html><head><link rel="stylesheet" href="../assets/style.css"></head><body><a href="../adr/001.md">Decision</a><script type="module" src="../assets/app.js"></script></body></html>',
			},
			{
				path: "assets/style.css",
				kind: "text",
				media_type: "text/css",
				source: 'body { background-image: url("diagram.svg"); }',
			},
			{
				path: "assets/app.js",
				kind: "text",
				media_type: "text/javascript",
				source: 'document.body.dataset.loaded = "yes";',
			},
			{
				path: "assets/diagram.svg",
				kind: "text",
				media_type: "image/svg+xml",
				source: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" />',
			},
		],
	});
	const token = `s_${id}`;
	await seedShare(token, id, { expiresAt: now() + 3600 });
	return { id, token };
}

describe("document file navigation", () => {
	it("encodes nested Unicode paths and preserves file/version selection", () => {
		expect(rawFileUrl("s_token", "adr/日本 語.md")).toBe("/raw/s_token/adr/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md");
		expect(viewerFileUrl("/d/doc", "adr/001.md", 2)).toBe("/d/doc?file=adr%2F001.md&v=2");
		expect(resolveFileLink("../README.md#summary", "adr/001.md")).toEqual({
			path: "README.md",
			search: "",
			hash: "#summary",
		});
		for (const href of [
			"https://example.com/file.md",
			" https://example.com/file.md",
			"\nhttps://cdn.example.com/file.md",
			"\tht\ntps://cdn.example.com/file.md",
			"//example.com/x",
			"mailto:a@example.com",
			"#section",
			"%ZZ.md",
			"..\\secret.md",
		]) {
			expect(resolveFileLink(href, "adr/001.md")).toBeNull();
		}
	});

	it("keeps query-bearing navigation native while bridging ordinary file links and fragments", () => {
		for (const query of ["?mode=print#details", "?format=raw", "?file=other.md&v=2#details"]) {
			const { preventDefault, postMessage } = clickFileLink(`${OWNER_BASE}/raw/s_navigation/adr/001.md${query}`);
			expect(preventDefault).not.toHaveBeenCalled();
			expect(postMessage).not.toHaveBeenCalled();
		}
		const { preventDefault, postMessage } = clickFileLink(`${OWNER_BASE}/raw/s_navigation/adr/001.md#details`);
		expect(preventDefault).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({ type: "poof:file", path: "adr/001.md", hash: "#details" }, "*");
	});

	it("leaves whitespace-prefixed external URLs and external base descendants unchanged", async () => {
		const source =
			'<html><head><base href="\nhttps://cdn.example.com/docs/"><link rel="stylesheet" href="style.css"></head><body><a href="next.html">Next</a><img src=" image.svg"></body></html>';
		const html = await linkDocumentFiles(new Response(source), "s_external", "index.html", ["index.html"]).text();
		expect(html).toContain('href="\nhttps://cdn.example.com/docs/"');
		expect(html).toContain('href="style.css"');
		expect(html).toContain('href="next.html"');
		expect(html).toContain('src=" image.svg"');
		const links = await linkDocumentFiles(
			new Response('<a href=" https://example.com/docs">Docs</a>'),
			"s_external",
			"index.html",
			["index.html"],
		).text();
		expect(links).toContain('href=" https://example.com/docs"');
	});

	it("rebases a local root base element and preserves relative asset references", async () => {
		for (const base of ["../", "/"]) {
			const response = linkDocumentFiles(
				new Response(
					`<html><head><base href="${base}"><link rel="stylesheet" href="assets/style.css"></head><body><img src="assets/mark.svg"></body></html>`,
				),
				"s_base",
				"preview/index.html",
				["preview/index.html"],
			);
			const html = await response.text();
			expect(html).toContain('href="/raw/s_base/"');
			expect(html).toContain('href="/raw/s_base/assets/style.css"');
			expect(html).toContain('src="/raw/s_base/assets/mark.svg"');
		}
	});

	it("shows shared tabs, marks the selected file, and downloads that file", async () => {
		const { token } = await seedFiles();
		const res = await SELF.fetch(`${OWNER_BASE}/v/${token}?file=adr%2F001.md`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('aria-label="Document files"');
		expect(html).toMatch(/data-file-path="adr\/001.md" aria-current="page"/);
		expect(html).toContain(`/raw/${token}/adr/001.md?format=raw`);
		expect(html).toContain(`/raw/${token}/adr/001.md?view=1`);
		expect(html).not.toContain('id="remove-file"');
		expect(html).not.toContain('id="file"');
		expect(html).toContain("event.source !== frame.contentWindow");
	});

	it("scopes Markdown links and images to the same bearer token", async () => {
		const { token } = await seedFiles();
		const res = await SELF.fetch(`${OWNER_BASE}/raw/${token}/README.md?view=1`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(`href="/raw/${token}/adr/001.md"`);
		expect(html).toContain(`src="/raw/${token}/assets/diagram.svg"`);
		expect(html).toContain('type: "poof:file"');
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-popups");
	});

	it("serves CSS and module scripts as source with CORS for opaque frames", async () => {
		const { token } = await seedFiles();
		const html = await (await SELF.fetch(`${OWNER_BASE}/raw/${token}/prototype/index.html?view=1`)).text();
		expect(html).toContain(`href="/raw/${token}/assets/style.css"`);
		expect(html).toContain(`src="/raw/${token}/assets/app.js"`);
		for (const [path, type, body] of [
			["assets/style.css", "text/css", 'body { background-image: url("diagram.svg"); }'],
			["assets/app.js", "text/javascript", 'document.body.dataset.loaded = "yes";'],
		]) {
			const res = await SELF.fetch(`${OWNER_BASE}/raw/${token}/${path}`);
			expect(res.headers.get("Content-Type")).toBe(type);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
			expect(await res.text()).toBe(body);
		}
		const preview = await (await SELF.fetch(`${OWNER_BASE}/raw/${token}/assets/style.css?view=1`)).text();
		expect(preview).toContain("<pre><code>body");
	});

	it("keeps owner file history pinned while share paths follow current snapshots", async () => {
		const { id, token } = await seedFiles();
		const owner = await mintOwnerToken(id, env.OWNER_TOKEN_SECRET, 600, 1);
		const doc = await getLiveDocument(env.DB, id, now());
		await addVersion(env, doc!, now(), {
			title: null,
			files: [{ path: "adr/001.md", kind: "md", source: "# Revised decision" }],
		});
		const old = await (await SELF.fetch(`${OWNER_BASE}/raw/${owner}/adr/001.md`)).text();
		const current = await (await SELF.fetch(`${OWNER_BASE}/raw/${token}/adr/001.md?v=1`)).text();
		expect(old).toContain("<h1>Decision</h1>");
		expect(current).toContain("<h1>Revised decision</h1>");
		const pinned = await (await SELF.fetch(`${OWNER_BASE}/d/${id}?file=adr%2F001.md&v=1`)).text();
		expect(pinned).toContain(`file=README.md&amp;v=1`);
		expect(pinned).not.toContain('id="remove-file"');
	});

	it("returns uniform 404 for missing files, invalid encodings, and revoked shares", async () => {
		const { id, token } = await seedFiles();
		for (const path of [
			`/v/${token}?file=missing.md`,
			`/d/${id}?file=missing.md`,
			`/raw/${token}/missing.md`,
			`/raw/${token}/%ZZ.md`,
			`/raw/${token}/adr%2F..%2FREADME.md`,
		]) {
			const res = await SELF.fetch(OWNER_BASE + path);
			expect(res.status).toBe(404);
			expect(await res.text()).toBe("Not Found");
		}
		await env.DB.prepare("UPDATE share SET revoked = 1 WHERE token = ?").bind(token).run();
		const res = await SELF.fetch(`${OWNER_BASE}/raw/${token}/assets/style.css`);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("Not Found");
	});
});
