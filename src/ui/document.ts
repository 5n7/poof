import { escapeHtml } from "../lib/render";
import { FONT_CSS, TOKENS_CSS } from "./theme";

// The standalone page a rendered Markdown or text file becomes inside the
// sandboxed iframe: typography plus a loader for Mermaid and highlight.js.

// Pin CDN assets with SRI. Mermaid's UMD build is one file, while its ESM entry
// imports chunks that SRI cannot cover. The browser-global highlight.js build
// comes from @highlightjs/cdn-assets. Load both only when needed.
const MERMAID_JS = "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js";
const MERMAID_SRI = "sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E";
const HLJS_JS = "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js";
const HLJS_SRI = "sha384-RH2xi4eIQ/gjtbs9fUXM68sLSi99C7ZWBRX1vDrVv6GQXRibxXLbwO2NGZB74MbU";
// One stylesheet per color scheme; the `media` attribute picks the live one.
const HLJS_THEMES = [
  {
    href: "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/styles/github.min.css",
    integrity: "sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L",
    media: "(prefers-color-scheme: light)",
  },
  {
    href: "https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/styles/github-dark.min.css",
    integrity: "sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH",
    media: "(prefers-color-scheme: dark)",
  },
];

// Document typography inside the sandboxed iframe. It shares the chrome's
// tokens and fonts, so a page and its frame always switch theme together.
const DOCUMENT_CSS = `${FONT_CSS}
${TOKENS_CSS}
html { background: var(--surface); }
body { margin: 0; }
::selection { background: var(--dusk-wash); }
.markdown-body {
  box-sizing: border-box;
  max-width: 46rem;
  margin: 0 auto;
  padding: clamp(1.5rem, 4vw, 3rem) clamp(1.25rem, 4vw, 2.5rem) 4rem;
  font-family: var(--font-body);
  font-size: 16.5px;
  line-height: 1.65;
  color: var(--ink);
  overflow-wrap: break-word;
  font-variant-numeric: proportional-nums;
  -webkit-font-smoothing: antialiased;
}
.markdown-body > :nth-child(1) { margin-top: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { font-family: var(--font-display); line-height: 1.15; margin: 2em 0 0.55em; text-wrap: balance; }
.markdown-body h1 { font-size: 2.15em; font-weight: 750; letter-spacing: -0.035em; }
.markdown-body h2 { font-size: 1.45em; font-weight: 700; letter-spacing: -0.02em; }
.markdown-body h3 { font-size: 1.15em; font-weight: 650; letter-spacing: -0.01em; }
.markdown-body h4 { font-size: 1em; font-weight: 650; }
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body pre, .markdown-body table, .markdown-body blockquote { margin: 0 0 1.05em; }
.markdown-body li + li { margin-top: 0.25em; }
.markdown-body a { color: var(--dusk-ink); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
.markdown-body a:hover { text-decoration-thickness: 2px; }
.markdown-body strong { font-weight: 650; }
.markdown-body code { background: var(--code-wash); padding: 0.15em 0.4em; border-radius: 6px; font-size: 0.86em; font-family: var(--font-mono); }
.markdown-body pre { background: var(--code-wash); padding: 1rem 1.15rem; border-radius: 14px; overflow: auto; font-size: 0.84em; line-height: 1.55; }
.markdown-body pre code, .markdown-body pre code.hljs { background: none; padding: 0; font-size: 100%; }
.markdown-body pre.mermaid { background: none; text-align: center; }
.markdown-body blockquote { padding: 0.8em 1.1em; border-radius: 14px; background: var(--mist); color: var(--ink-soft); }
.markdown-body blockquote > :last-child { margin-bottom: 0; }
.markdown-body table { border-collapse: collapse; display: block; overflow: auto; font-variant-numeric: tabular-nums; }
.markdown-body th, .markdown-body td { border-bottom: 1px solid var(--line); padding: 0.5em 0.9em; text-align: left; vertical-align: top; }
.markdown-body th { font-size: 0.86em; font-weight: 650; color: var(--muted); }
.markdown-body img { max-width: 100%; border-radius: 10px; }
.markdown-body hr { border: 0; height: 1px; background: var(--line); margin: 2.2em 0; }
.markdown-body input[type="checkbox"] { accent-color: var(--dusk); }
html { scrollbar-color: var(--line) transparent; }`;

// Leave large blocks as readable text. Auto-detecting every bundled language
// can monopolize the browser thread even for prose in a code block.
const MAX_HIGHLIGHT_CHARS = 10_000;

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
      var dark = !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      window.mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral" });
      window.mermaid.run();
    });
  }
  var plain = /(^|\\s)(no-?highlight|(?:lang(?:uage)?-)?(?:text|plaintext|txt))(?=\\s|$)/i;
  var blocks = Array.from(document.querySelectorAll("pre code")).filter(function (block) {
    var classes = block.className + " " + block.parentElement.className;
    if (plain.test(classes) || block.dataset.highlighted) return false;
    var length = block.textContent.length;
    return length > 0 && length <= ${MAX_HIGHLIGHT_CHARS};
  });
  if (blocks.length) {
    ${JSON.stringify(HLJS_THEMES)}.forEach(function (theme) {
      var l = document.createElement("link");
      l.rel = "stylesheet"; l.href = theme.href; l.media = theme.media;
      l.integrity = theme.integrity; l.crossOrigin = "anonymous";
      document.head.appendChild(l);
    });
    load(${JSON.stringify(HLJS_JS)}, ${JSON.stringify(HLJS_SRI)}, function () {
      var index = 0;
      function highlightNext() {
        window.hljs.highlightElement(blocks[index++]);
        if (index < blocks.length) setTimeout(highlightNext, 0);
      }
      setTimeout(highlightNext, 0);
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
<style>${DOCUMENT_CSS}</style>
</head>
<body>
<article class="markdown-body">
${bodyHtml}
</article>
<script>${LOADER}</script>
</body>
</html>`;
}
