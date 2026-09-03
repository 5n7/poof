import MarkdownIt from "markdown-it";

/** Minimal HTML-escape for text placed inside an element. */
function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const md = new MarkdownIt({ html: true, linkify: true });

// Render ```mermaid fences as escaped content inside <pre class="mermaid">.
// The sandbox renders them in the browser. Other fences use the default
// renderer. Poof does not sanitize HTML (SPEC §6.4).
const defaultFence =
	md.renderer.rules.fence ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	if (token.info.trim() === "mermaid") {
		return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
	}
	return defaultFence(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
	return md.render(source);
}

// Pin CDN assets with SRI. Mermaid's UMD build is one file, while its ESM entry
// imports chunks that SRI cannot cover. The browser-global highlight.js build
// comes from @highlightjs/cdn-assets. Load both only when needed.
const MERMAID_JS = "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js";
const MERMAID_SRI = "sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E";
const HLJS_JS = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js";
const HLJS_SRI = "sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU";
const HLJS_CSS = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/styles/github.min.css";
const HLJS_CSS_SRI = "sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L";

// ~2KB GitHub-flavored markdown CSS (minimal subset).
const VIEWER_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; }
.markdown-body {
  box-sizing: border-box;
  max-width: 900px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: #1f2328;
  word-wrap: break-word;
}
.markdown-body h1, .markdown-body h2 { border-bottom: 1px solid #d1d9e0; padding-bottom: .3em; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { font-weight: 600; line-height: 1.25; margin: 1.5em 0 .6em; }
.markdown-body h1 { font-size: 2em; }
.markdown-body h2 { font-size: 1.5em; }
.markdown-body a { color: #0969da; text-decoration: none; }
.markdown-body a:hover { text-decoration: underline; }
.markdown-body code { background: rgba(129,139,152,.15); padding: .2em .4em; border-radius: 6px; font-size: 85%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.markdown-body pre { background: #f6f8fa; padding: 1rem; border-radius: 6px; overflow: auto; font-size: 85%; line-height: 1.45; }
.markdown-body pre code { background: none; padding: 0; font-size: 100%; }
.markdown-body blockquote { margin: 0; padding: 0 1em; color: #59636e; border-left: .25em solid #d1d9e0; }
.markdown-body table { border-collapse: collapse; display: block; overflow: auto; }
.markdown-body table th, .markdown-body table td { border: 1px solid #d1d9e0; padding: 6px 13px; }
.markdown-body table tr:nth-child(2n) { background: #f6f8fa; }
.markdown-body img { max-width: 100%; }
.markdown-body hr { border: 0; border-top: 1px solid #d1d9e0; margin: 1.5em 0; }
@media (prefers-color-scheme: dark) {
  .markdown-body { color: #e6edf3; }
  .markdown-body h1, .markdown-body h2 { border-color: #3d444d; }
  .markdown-body pre { background: #151b23; }
  .markdown-body a { color: #4493f8; }
  .markdown-body blockquote { color: #9198a1; border-color: #3d444d; }
  .markdown-body table th, .markdown-body table td, .markdown-body hr { border-color: #3d444d; }
  .markdown-body table tr:nth-child(2n) { background: #151b23; }
}`;

// Load libraries only when the rendered document uses them.
const LOADER = `
(function () {
  function load(src, integrity, cb) {
    var s = document.createElement("script");
    s.src = src; s.integrity = integrity; s.crossOrigin = "anonymous";
    s.onload = cb; document.head.appendChild(s);
  }
  if (document.querySelector(".mermaid")) {
    load(${JSON.stringify(MERMAID_JS)}, ${JSON.stringify(MERMAID_SRI)}, function () {
      window.mermaid.initialize({ startOnLoad: false });
      window.mermaid.run();
    });
  }
  if (document.querySelector("pre code")) {
    var l = document.createElement("link");
    l.rel = "stylesheet"; l.href = ${JSON.stringify(HLJS_CSS)};
    l.integrity = ${JSON.stringify(HLJS_CSS_SRI)}; l.crossOrigin = "anonymous";
    document.head.appendChild(l);
    load(${JSON.stringify(HLJS_JS)}, ${JSON.stringify(HLJS_SRI)}, function () {
      window.hljs.highlightAll();
    });
  }
})();`;

/** Wrap rendered markdown body HTML in a full standalone viewer document. */
export function wrapViewerHtml(title: string, bodyHtml: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${VIEWER_CSS}</style>
</head>
<body>
<article class="markdown-body">
${bodyHtml}
</article>
<script>${LOADER}</script>
</body>
</html>`;
}
