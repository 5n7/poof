import { describe, expect, it } from "vitest";

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
		// Content is HTML-escaped: the angle brackets must not survive raw.
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
