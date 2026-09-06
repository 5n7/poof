import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "../src/lib/html-to-markdown";

describe("htmlToMarkdown", () => {
	it("keeps document structure and decodes entities without page scaffolding", () => {
		const source = `<!doctype html><html><head><title>Unused</title><style>body { color: red }</style></head>
<body><!-- unused --><h1>A &amp; B</h1><p>Hello <strong>world</strong> &copy; &#x1F600;.</p>
<h2>Resources</h2><p><a href="https://example.com/?a=1&amp;b=2" title="a > b">Read more</a></p>
<img src="/diagram.png" alt="System diagram"><script>alert('unused')</script></body></html>`;
		expect(htmlToMarkdown(source)).toBe(
			"# A & B\n\nHello **world** © 😀.\n\n## Resources\n\n[Read more](https://example.com/?a=1&b=2)\n\n![System diagram](/diagram.png)",
		);
	});

	it("removes explicitly hidden markup and templates", () => {
		expect(
			htmlToMarkdown(`<p>Visible</p><div hidden>secret</div><span aria-hidden="TRUE">secret</span>
<div style="color: red; display: none !important">secret</div><div style="visibility: hidden">secret</div>
<template>secret</template><p>Still visible</p>`),
		).toBe("Visible\n\nStill visible");
	});

	it("preserves nested lists, ordered numbering, and blockquotes", () => {
		expect(
			htmlToMarkdown(`<ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul>
<ol start="3"><li>Third</li><li value="7">Seventh</li></ol><blockquote><p>Quoted</p></blockquote>`),
		).toBe("- First\n  \n  - Nested\n- Second\n\n3. Third\n7. Seventh\n\n> Quoted");
	});

	it("preserves tables and escapes cell pipes", () => {
		expect(
			htmlToMarkdown(`<table><caption>Results</caption><thead><tr><th>Name</th><th>Value</th></tr></thead>
<tbody><tr><td>A | B</td><td><strong>2</strong><br>items</td></tr></tbody></table>`),
		).toBe("Results\n\n| Name | Value |\n| --- | --- |\n| A \\| B | **2**<br>items |");
		expect(htmlToMarkdown("<table><tr><td>first row</td></tr><tr><td>second row</td></tr></table>")).toBe(
			"|  |\n| --- |\n| first row |\n| second row |",
		);
	});

	it("preserves preformatted whitespace and chooses safe code fences", () => {
		const code = "const value = `quoted`;\n\n\n  ```\n&lt;tag&gt;\n";
		expect(htmlToMarkdown(`<pre><code class="language-ts">${code}</code></pre>`)).toBe(
			"````ts\nconst value = `quoted`;\n\n\n  ```\n<tag>\n````",
		);
		expect(htmlToMarkdown('<pre class="mermaid">graph TD\n  A --&gt; B</pre>')).toBe(
			"```mermaid\ngraph TD\n  A --> B\n```",
		);
		expect(htmlToMarkdown("<p>Run <code>`echo`</code> now.</p>")).toBe("Run `` `echo` `` now.");
	});

	it.each([50, 1_500])("keeps all cells in a jagged table of width %i without rectangular padding", (width) => {
		const headings = Array.from({ length: width }, (_, index) => `Column ${index}`);
		const values = Array.from({ length: width }, (_, index) => `Value ${index}`);
		const source =
			`<table><caption>Results</caption><tr>${headings.map((heading) => `<th>${heading}</th>`).join("")}</tr>` +
			`${values.map((value) => `<tr><td>${value}</td></tr>`).join("")}</table>`;
		const result = htmlToMarkdown(source);
		expect(result.length).toBeLessThan(source.length);
		expect(result.split("\n")).toEqual(["Results", "", headings.join(" | "), ...values]);
	});

	it("parses malformed HTML and safely encodes link destinations", () => {
		expect(htmlToMarkdown('<h1>Title</h1><p>One<p>Two <a href="/a(b) c" title="x > y">link</a>')).toBe(
			"# Title\n\nOne\n\nTwo [link](/a%28b%29%20c)",
		);
	});

	it("keeps code inside lists, blockquotes, and table cells valid", () => {
		expect(htmlToMarkdown("<ul><li>Example<pre><code>one\n\n\n  two</code></pre></li></ul>")).toBe(
			"- Example\n  \n  ```\n  one\n  \n  \n    two\n  ```",
		);
		expect(htmlToMarkdown("<blockquote><pre>one\n  two</pre></blockquote>")).toBe("> ```\n> one\n>   two\n> ```");
		expect(htmlToMarkdown("<table><tr><th>Expression</th></tr><tr><td><code>a | b</code></td></tr></table>")).toBe(
			"| Expression |\n| --- |\n| `a \\| b` |",
		);
	});

	it("omits embedded image payloads while keeping their descriptions", () => {
		expect(htmlToMarkdown('<p><img src="data:image/png;base64,verylongpayload" alt="Chart"></p>')).toBe("Chart");
		expect(htmlToMarkdown('<a href="data:text/plain;base64,verylongpayload">Attachment</a>')).toBe("Attachment");
	});

	it.each([" data:", "\tDaTa:", "da\nta:", "da&#x9;ta:", "bl\rob:", "java\tscript:"])(
		"filters image and link schemes using URL normalization: %s",
		(scheme) => {
			const payload = "x".repeat(20_000);
			expect(
				htmlToMarkdown(
					`<p><img src="${scheme}${payload}" alt="Chart"></p><p><a href="${scheme}${payload}">Attachment</a></p>`,
				),
			).toBe("Chart\n\nAttachment");
		},
	);

	it("keeps external and relative destinations after filtering embedded URLs", () => {
		expect(
			htmlToMarkdown(
				'<p><a href="https://example.com/data:report">External</a> <a href="../data/report">Relative</a> <a href="#chart">Jump</a></p><img src="/images/chart.png" alt="Chart">',
			),
		).toBe(
			"[External](https://example.com/data:report) [Relative](../data/report) [Jump](#chart)\n\n![Chart](/images/chart.png)",
		);
	});

	it("normalizes surrounding URL whitespace and embedded controls before emitting destinations", () => {
		expect(
			htmlToMarkdown(
				'<p><a href=" https://example.com/x ">External</a> <a href="ht\ntps://example.com/a\tb">Controls</a> <a href="\u001f ../some file\r/path \u001f">Relative</a></p><img src=" /images/char\nt.png " alt="Chart">',
			),
		).toBe(
			"[External](https://example.com/x) [Controls](https://example.com/ab) [Relative](../some%20file/path)\n\n![Chart](/images/chart.png)",
		);
	});

	it("handles deeply nested content and many backtick runs without overflowing", () => {
		expect(htmlToMarkdown(`${"<div>".repeat(2_000)}Visible<span hidden>secret</span>${"</div>".repeat(2_000)}`)).toBe(
			"Visible",
		);
		const code = "` ".repeat(150_000);
		expect(htmlToMarkdown(`<pre>${code}</pre>`)).toBe(`\`\`\`\n${code}\n\`\`\``);
	});

	it("preserves paragraph boundaries across many sibling elements", () => {
		const count = 30_000;
		expect(htmlToMarkdown("<p>x</p>".repeat(count))).toBe(Array<string>(count).fill("x").join("\n\n"));
	});

	it("retains newline state across omitted elements and empty whitespace segments", () => {
		expect(
			htmlToMarkdown(
				'<p>First</p> <!-- ignored --><span hidden>ignored</span> <img src="/chart.png" alt="Chart"><p>Last</p>',
			),
		).toBe("First\n\n![Chart](/chart.png)\n\nLast");
	});
});
