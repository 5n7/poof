import { describe, expect, it, vi } from "vitest";

import { renderMarkdown, wrapViewerHtml } from "../src/lib/render";

describe("renderMarkdown", () => {
	it("renders headings", () => {
		expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
	});

	it("renders GFM tables", () => {
		const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>a</th>");
		expect(html).toContain("<td>1</td>");
	});

	it("renders strikethrough", () => {
		expect(renderMarkdown("~~gone~~")).toContain("<s>gone</s>");
	});

	it("passes raw HTML through unsanitized (script survives)", () => {
		const html = renderMarkdown("<script>alert('xss')</script>");
		expect(html).toContain("<script>alert('xss')</script>");
	});

	it('escapes mermaid fence content into <pre class="mermaid">', () => {
		const html = renderMarkdown('```mermaid\ngraph TD; A["<b>"] --> B\n```');
		expect(html).toContain('<pre class="mermaid">');
		// HTML escaping must remove the raw angle brackets.
		expect(html).toContain("&lt;b&gt;");
		expect(html).not.toContain('A["<b>"]');
	});

	it("renders non-mermaid fences with the default renderer", () => {
		const html = renderMarkdown("```js\nconst x = 1;\n```");
		expect(html).toContain('<code class="language-js">');
		expect(html).not.toContain('class="mermaid"');
	});
});

describe("wrapViewerHtml", () => {
	it("produces a full HTML document with an escaped title", () => {
		const html = wrapViewerHtml('A <b>& "quote"', "<p>body</p>");
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("<title>A &lt;b&gt;&amp; &quot;quote&quot;</title>");
		expect(html).toContain("<p>body</p>");
	});

	it("embeds the lazy-loader script", () => {
		const html = wrapViewerHtml("t", "<p>x</p>");
		expect(html).toContain('document.querySelector(".mermaid")');
		expect(html).toContain("hljs");
		expect(html).toContain("<script>");
	});

	it("never contains allow-same-origin", () => {
		const html = wrapViewerHtml("t", "<p>x</p>");
		expect(html).not.toContain("allow-same-origin");
	});
});

interface CodeBlock {
	className: string;
	parentElement: { className: string };
	dataset: { highlighted?: string };
	textContent: string;
}

function codeBlock(textContent: string, className = "", parentClass = ""): CodeBlock {
	return { className, parentElement: { className: parentClass }, dataset: {}, textContent };
}

function runLoader(blocks: CodeBlock[], hasMermaid = false) {
	const assets: { src?: string; href?: string; integrity?: string; crossOrigin?: string; onload?: () => void }[] = [];
	const tasks: (() => void)[] = [];
	const highlightElement = vi.fn();
	const mermaid = { initialize: vi.fn(), run: vi.fn() };
	const html = wrapViewerHtml("Loader fixture", "");
	const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
	new Function("document", "window", "setTimeout", script)(
		{
			createElement: () => ({}),
			head: { appendChild: (asset: (typeof assets)[number]) => assets.push(asset) },
			querySelector: () => (hasMermaid ? {} : null),
			querySelectorAll: () => blocks,
		},
		{ hljs: { highlightElement }, mermaid },
		(task: () => void) => tasks.push(task),
	);
	return { assets, tasks, highlightElement, mermaid };
}

describe("viewer highlighting", () => {
	it("does not request highlighting assets for plain, empty, or oversized blocks", () => {
		const blocks = [
			codeBlock(""),
			codeBlock("notes", "nohighlight"),
			codeBlock("notes", "", "no-highlight"),
			codeBlock("notes", "language-text"),
			codeBlock("notes", "lang-plaintext"),
			codeBlock("notes", "text"),
			codeBlock("notes", "plaintext"),
			codeBlock("notes", "language-txt"),
			codeBlock("x".repeat(10_001), "language-js"),
		];
		const loader = runLoader(blocks);
		expect(loader.assets).toEqual([]);
		expect(loader.tasks).toEqual([]);
	});

	it("preserves automatic detection and yields between eligible blocks", () => {
		const detected = codeBlock("const value = 1;");
		const explicit = codeBlock("x".repeat(10_000), "language-js");
		const alreadyHighlighted = codeBlock("const value = 2;");
		alreadyHighlighted.dataset.highlighted = "yes";
		const loader = runLoader([detected, codeBlock("notes", "nohighlight"), explicit, alreadyHighlighted]);
		expect(loader.assets).toHaveLength(2);
		for (const asset of loader.assets) {
			expect(asset.integrity).toMatch(/^sha384-/);
			expect(asset.crossOrigin).toBe("anonymous");
		}
		loader.assets.find((asset) => asset.src?.includes("highlight.min.js"))!.onload!();
		expect(loader.highlightElement).not.toHaveBeenCalled();
		loader.tasks.shift()!();
		expect(loader.highlightElement.mock.calls).toEqual([[detected]]);
		expect(loader.tasks).toHaveLength(1);
		loader.tasks.shift()!();
		expect(loader.highlightElement.mock.calls).toEqual([[detected], [explicit]]);
		expect(loader.tasks).toEqual([]);
	});

	it("keeps Mermaid rendering independent from syntax highlighting", () => {
		const loader = runLoader([codeBlock("notes", "language-text")], true);
		expect(loader.assets).toHaveLength(1);
		expect(loader.assets[0].src).toContain("mermaid.min.js");
		loader.assets[0].onload!();
		expect(loader.mermaid.initialize).toHaveBeenCalledWith({ startOnLoad: false });
		expect(loader.mermaid.run).toHaveBeenCalledOnce();
		expect(loader.tasks).toEqual([]);
	});
});
