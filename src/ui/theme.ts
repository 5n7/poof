import { FONT_FILES } from "./fonts.generated";

/** Where src/routes/assets.ts serves fonts, styles, and scripts. */
export const ASSET_PATH = "/v/assets/";

export const FONT_CSS = `
@font-face { font-family: "Bricolage Grotesque"; font-style: normal; font-weight: 200 800; font-stretch: 75% 100%; font-display: swap; src: url(${ASSET_PATH}${FONT_FILES["bricolage-grotesque"]}) format("woff2"); }
@font-face { font-family: "Hanken Grotesk"; font-style: normal; font-weight: 100 900; font-display: swap; src: url(${ASSET_PATH}${FONT_FILES["hanken-grotesk"]}) format("woff2"); }
@font-face { font-family: "Hanken Grotesk"; font-style: italic; font-weight: 100 900; font-display: swap; src: url(${ASSET_PATH}${FONT_FILES["hanken-grotesk-italic"]}) format("woff2"); }`;

/**
 * Design tokens shared by the app chrome and the rendered document inside the
 * iframe, so both sides of the frame change theme together.
 *
 * Mist is the ground, ink carries text and primary actions, and dusk is the one
 * accent: anything that is shared, live, or about to vanish. Danger is kept
 * apart from dusk so "about to expire" never reads as "error".
 */
export const TOKENS_CSS = `
:root {
  color-scheme: light dark;
  --mist: #eceef2;
  --mist-deep: #e1e4ea;
  --surface: #ffffff;
  --ink: #1c2230;
  --ink-soft: #3d4555;
  --muted: #5d6577;
  --line: #d9dde5;
  --dusk: #cf4f75;
  --dusk-ink: #ad3459;
  --dusk-wash: rgba(207, 79, 117, 0.12);
  --danger: #b42318;
  --danger-wash: rgba(180, 35, 24, 0.09);
  --smoke-a: rgba(206, 213, 227, 0.95);
  --smoke-b: rgba(255, 255, 255, 0.9);
  --code-wash: rgba(28, 34, 48, 0.06);
  --shadow-soft: 0 1px 2px rgba(28, 34, 48, 0.06), 0 8px 24px rgba(28, 34, 48, 0.08);
  --shadow-lift: 0 2px 6px rgba(28, 34, 48, 0.08), 0 22px 56px rgba(28, 34, 48, 0.18);
  --font-display: "Bricolage Grotesque", "Hanken Grotesk", ui-sans-serif, system-ui, sans-serif;
  --font-body: "Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --mist: #13161c;
    --mist-deep: #0e1015;
    --surface: #1b1f27;
    --ink: #e7e9ee;
    --ink-soft: #c5c9d3;
    --muted: #9aa1b0;
    --line: #2b313c;
    --dusk: #f07595;
    --dusk-ink: #f58aa6;
    --dusk-wash: rgba(240, 117, 149, 0.15);
    --danger: #ff8a7a;
    --danger-wash: rgba(255, 138, 122, 0.12);
    --smoke-a: rgba(46, 53, 68, 0.9);
    --smoke-b: rgba(62, 70, 88, 0.5);
    --code-wash: rgba(231, 233, 238, 0.07);
    --shadow-soft: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.25);
    --shadow-lift: 0 2px 6px rgba(0, 0, 0, 0.35), 0 22px 56px rgba(0, 0, 0, 0.5);
  }
}`;
