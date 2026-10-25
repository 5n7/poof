import { FONT_CSS, TOKENS_CSS } from "./theme";
import { TITLE_EDITOR_CSS } from "./title-editor";

// Chrome for every page. Components take their colors from TOKENS_CSS only, so
// the dark theme needs no rules of its own.
const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--mist); scrollbar-color: var(--line) transparent; -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; min-height: 100dvh; color: var(--ink); font: 400 15px/1.5 var(--font-body); -webkit-font-smoothing: antialiased; isolation: isolate; }
::selection { background: var(--dusk-wash); }
a { color: inherit; text-underline-offset: 0.2em; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--dusk); outline-offset: 2px; }
[hidden] { display: none !important; }
h1, h2, h3 { text-wrap: balance; }
kbd { font: 600 0.86em var(--font-body); padding: 1px 6px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); border-bottom-width: 2px; }
.sp { flex: 1; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* Smoke: the page's one atmospheric layer, drifting in from the top right. */
.smoky::before { content: ""; position: fixed; inset: -12vmax; z-index: -1; pointer-events: none; filter: blur(42px);
  background:
    radial-gradient(36vmax 24vmax at 88% 6%, var(--smoke-a), transparent 70%),
    radial-gradient(22vmax 16vmax at 97% 26%, var(--smoke-b), transparent 70%),
    radial-gradient(42vmax 24vmax at 2% 102%, var(--smoke-a), transparent 70%); }

/* Buttons and pills */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 15px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--ink); font: 600 13.5px/1 var(--font-body); white-space: nowrap; text-decoration: none; cursor: pointer; transition: background-color 0.15s, border-color 0.15s, color 0.15s; }
.btn:hover { border-color: color-mix(in srgb, var(--ink) 28%, var(--line)); }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn svg { width: 17px; height: 17px; flex: none; }
.btn.primary { background: var(--ink); border-color: var(--ink); color: var(--mist); }
.btn.primary:hover { background: var(--ink-soft); border-color: var(--ink-soft); }
.btn.danger { background: var(--danger); border-color: var(--danger); color: var(--mist); }
.btn.ghost { background: transparent; border-color: transparent; }
.btn.ghost:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); }
.btn.icon { width: 36px; padding: 0; }
.btn.small { min-height: 30px; padding: 0 11px; font-size: 12.5px; }
.btn.wide { width: 100%; min-height: 40px; }
.pill { display: inline-flex; align-items: center; gap: 7px; min-height: 28px; padding: 0 11px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font: 650 12.5px/1 var(--font-body); font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
button.pill { cursor: pointer; }
button.pill:hover { background: color-mix(in srgb, var(--ink) 7%, transparent); color: var(--ink); }
.pill.live { background: var(--dusk-wash); color: var(--dusk-ink); }
.pill.live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
button.pill.live:hover { background: color-mix(in srgb, var(--dusk) 22%, transparent); color: var(--dusk-ink); }

/* Wordmark */
.wordmark { margin: 0; font: 800 clamp(48px, 9vw, 68px)/0.86 var(--font-display); letter-spacing: -0.04em; font-variation-settings: "opsz" 96; }
.wordmark i, .mini i { font-style: normal; color: var(--dusk); }
.mini { flex: none; padding: 0 8px 0 10px; font: 800 20px/1 var(--font-display); letter-spacing: -0.04em; font-variation-settings: "opsz" 48; text-decoration: none; }

/* Popovers: menus and panels share one surface. */
.pop { position: fixed; inset: auto; z-index: 180; margin: 0; padding: 6px; min-width: 210px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow: auto; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); color: var(--ink); box-shadow: var(--shadow-lift); }
.pop:popover-open { animation: pop-in 0.2s var(--ease-out); }
@keyframes pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
.menu-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 0 12px; border: 0; border-radius: 12px; background: none; text-align: left; font: 500 14px var(--font-body); text-decoration: none; cursor: pointer; }
.menu-item svg { width: 17px; height: 17px; flex: none; color: var(--muted); }
.menu-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-item:hover { background: var(--mist); }
.menu-item:focus-visible { background: color-mix(in srgb, var(--ink) 10%, var(--surface)); outline: 2px solid var(--dusk); outline-offset: -2px; }
.menu-item.danger, .menu-item.danger svg { color: var(--danger); }
.menu-item.danger:hover, .menu-item.danger:focus-visible { background: var(--danger-wash); }
.panel-note[data-error] { color: var(--danger); }
.menu-sep { height: 1px; margin: 5px 8px; background: var(--line); }
.confirm { display: grid; gap: 12px; width: min(300px, calc(100vw - 48px)); padding: 10px 10px 6px; }
.confirm p { margin: 0; font-size: 14px; line-height: 1.45; color: var(--ink-soft); overflow-wrap: anywhere; }
.confirm div { display: flex; justify-content: flex-end; gap: 6px; }
.panel { width: min(380px, calc(100vw - 24px)); padding: 18px; border-radius: 26px; display: grid; gap: 14px; }
@media (max-width: 640px) {
  .panel { left: 8px !important; right: 8px; top: auto !important; bottom: max(8px, env(safe-area-inset-bottom)); width: auto; max-height: 82dvh; overflow: auto; }
  .panel:popover-open { animation-name: sheet-in; }
}
@keyframes sheet-in { from { transform: translateY(24px); opacity: 0; } }
.panel-head { display: flex; align-items: flex-start; gap: 8px; }
.panel-head div { flex: 1; min-width: 0; }
.panel-head h2 { margin: 0; font: 700 21px/1.15 var(--font-display); letter-spacing: -0.02em; }
.panel-head p { margin: 3px 0 0; font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.field-label { margin: 0 0 -6px; font-size: 12.5px; font-weight: 650; color: var(--muted); }
.choice { display: flex; gap: 6px; }
.choice button { flex: 1; min-height: 36px; border: 1px solid var(--line); border-radius: 999px; background: none; color: var(--ink-soft); font: 600 13px var(--font-body); cursor: pointer; }
.choice button:hover { border-color: color-mix(in srgb, var(--ink) 28%, var(--line)); }
.choice button[aria-checked="true"] { border-color: var(--dusk); background: var(--dusk-wash); color: var(--dusk-ink); }
.rows { display: grid; gap: 6px; max-height: min(300px, 40dvh); overflow: auto; margin: 0 -4px; padding: 0 4px; }
.rows:empty { display: none; }
.link, .ver { display: flex; align-items: center; gap: 10px; padding: 9px 8px 9px 14px; border-radius: 16px; background: var(--mist); }
.link > div, .ver > div { flex: 1; min-width: 0; display: grid; gap: 2px; }
.link-url { font: 12.5px var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: all; }
.link-left { font-size: 12.5px; font-weight: 650; color: var(--dusk-ink); font-variant-numeric: tabular-nums; }
.ver b { font: 700 15px var(--font-display); }
.ver span { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ver .pill { padding: 0 8px; }
.panel-note { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); }
.fresh { animation: fresh 1.6s var(--ease-out); }
@keyframes fresh { from { background-color: var(--dusk-wash); } }

/* Vanishing: the one authored motion. A row or link blurs out like smoke and
   sheds a few motes, then the space it held closes. */
.puff { animation: puff 0.5s var(--ease-out) forwards; pointer-events: none; }
@keyframes puff { 30% { filter: blur(1px); transform: scale(1.015); } 100% { opacity: 0; filter: blur(14px); transform: scale(1.07); } }
.mote { position: fixed; z-index: 300; width: var(--s); height: var(--s); border-radius: 50%; background: var(--muted); opacity: 0.45; pointer-events: none; animation: mote 0.8s var(--ease-out) forwards; }
@keyframes mote { to { transform: translate(var(--dx), var(--dy)) scale(0.2); opacity: 0; } }

/* Toast and drop overlay */
.toast { position: fixed; inset: auto auto max(20px, env(safe-area-inset-bottom)) 50%; margin: 0; border: 0; z-index: 250; display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 11px 18px; border-radius: 999px; background: var(--ink); color: var(--mist); font: 600 13.5px/1.3 var(--font-body); font-variant-numeric: tabular-nums; box-shadow: var(--shadow-lift); transform: translateX(-50%); animation: toast-in 0.26s var(--ease-out); }
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 8px); } }
/* Hide by popover state so the live region exists before its text arrives;
   without the Popover API the toast is a plain fixed element, hidden when idle. */
@supports selector(:popover-open) { .toast:not(:popover-open) { display: none; } }
@supports not selector(:popover-open) { .toast:empty { display: none; } }
.drop { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, var(--mist) 80%, transparent); backdrop-filter: blur(10px); pointer-events: none; }
.drop-card { display: grid; justify-items: center; gap: 6px; text-align: center; }
.drop-card svg { width: 132px; height: auto; margin-bottom: 6px; }
.drop-card b { font: 750 clamp(28px, 5vw, 40px)/1.05 var(--font-display); letter-spacing: -0.03em; }
.drop-card span { color: var(--ink-soft); }
.puffmark .a { fill: var(--smoke-a); }
.puffmark .b { fill: var(--surface); }
.puffmark .c { fill: var(--dusk); }

@media (pointer: coarse) { .btn, .pill, .menu-item { min-height: 44px; } .btn.icon { width: 44px; } }
@media (forced-colors: active) {
  .choice button[aria-checked="true"], .file[aria-current="page"], .pill.live { outline: 2px solid CanvasText; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}`;

const LIBRARY_CSS = `
.lib { max-width: 50rem; margin: 0 auto; padding: clamp(28px, 7vw, 72px) max(20px, env(safe-area-inset-right)) 96px max(20px, env(safe-area-inset-left)); display: grid; gap: 26px; }
.lib-head { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.lib-links { display: flex; align-items: center; gap: 2px; margin-bottom: 4px; }
.lib-links .btn { color: var(--ink-soft); }
.intake { display: flex; align-items: center; gap: 10px 12px; flex-wrap: wrap; padding: 12px 12px 12px 14px; border: 1px dashed color-mix(in srgb, var(--ink) 20%, transparent); border-radius: 24px; background: color-mix(in srgb, var(--surface) 55%, transparent); }
.intake svg.puffmark { width: 44px; height: auto; flex: none; }
.intake p { flex: 1 1 15rem; margin: 0; color: var(--ink-soft); }
.intake div { display: flex; gap: 6px; flex-wrap: wrap; }
.docs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.doc { position: relative; display: flex; align-items: center; gap: 6px; padding: 5px 6px 5px 5px; border-radius: 22px; background: color-mix(in srgb, var(--surface) 72%, transparent); transition: background-color 0.2s, box-shadow 0.2s; }
.doc:hover, .doc:focus-within { background: var(--surface); box-shadow: var(--shadow-soft); }
.doc-open { flex: 1; min-width: 0; display: grid; gap: 3px; padding: 10px 12px; border-radius: 17px; text-decoration: none; }
.doc-open:focus-visible { outline-offset: -2px; }
.doc-title { font-size: 15.5px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: color-mix(in srgb, var(--ink) calc(100% - var(--fade, 0) * 34%), var(--surface)); }
.doc-meta { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.empty { display: grid; justify-items: start; gap: 10px; padding: 40px 6px 8px; }
.empty svg { width: 150px; height: auto; margin-left: -8px; }
.empty h2 { margin: 0; font: 750 30px/1.1 var(--font-display); letter-spacing: -0.03em; }
.empty p { margin: 0; max-width: 34rem; color: var(--ink-soft); }
@media (max-width: 560px) { .lib-links .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; } .lib-links .btn:has(.label) { width: 36px; padding: 0; } .doc .pill { padding: 0 9px; } }`;

const VIEWER_CSS = `
.viewer { display: flex; flex-direction: column; gap: 8px; height: 100vh; height: 100dvh; padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(10px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left)); }
.viewer > * { width: 100%; max-width: 76rem; margin: 0 auto; }
.bar { flex: none; display: flex; align-items: center; gap: 2px; padding: 5px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--surface) 90%, transparent); box-shadow: var(--shadow-soft); }
.bar .title, .title-btn { min-width: 0; padding: 7px 10px; font: 650 14.5px/1.2 var(--font-body); }
.bar .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title-btn { display: flex; align-items: center; gap: 6px; border: 0; border-radius: 999px; background: none; cursor: pointer; }
.title-btn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.title-btn svg { width: 15px; height: 15px; flex: none; color: var(--muted); opacity: 0; transition: opacity 0.15s; }
.title-btn:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
.title-btn:hover svg, .title-btn:focus-visible svg { opacity: 1; }
@media (hover: none) { .title-btn svg { opacity: 0.7; } }
.files { flex: none; display: flex; gap: 6px; overflow-x: auto; scrollbar-width: thin; padding: 0 2px 2px; }
.file { flex: none; max-width: 22rem; padding: 7px 13px; border-radius: 999px; background: color-mix(in srgb, var(--surface) 55%, transparent); color: var(--ink-soft); font: 550 13px/1.2 var(--font-body); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file:hover { background: var(--surface); color: var(--ink); }
.file[aria-current="page"] { background: var(--ink); color: var(--mist); }
.notice { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 7px 7px 7px 16px; border-radius: 22px; background: var(--dusk-wash); font-size: 14px; }
.notice p { flex: 1 1 18rem; margin: 0; }
.sheet { position: relative; flex: 1; min-height: 0; border-radius: 24px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow-soft); }
.frame { display: block; width: 100%; height: 100%; border: 0; }
.gone { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 8px; padding: 24px; text-align: center; background: var(--surface); }
.gone svg { width: 140px; height: auto; margin-bottom: 4px; }
.gone h1 { margin: 0; font: 750 32px/1.1 var(--font-display); letter-spacing: -0.03em; }
.gone p { margin: 0; color: var(--ink-soft); }
.gone h1:focus { outline: none; }
.sheet.vanishing .frame { animation: puff 0.9s var(--ease-out) forwards; }
@media (max-width: 640px) {
  .bar #ver-btn, .bar .pill { display: none; }
  .bar .pill.keep { display: inline-flex; }
  .sheet { border-radius: 18px; }
}`;

const GUIDE_CSS = `
.guide { max-width: 44rem; margin: 0 auto; padding: clamp(28px, 6vw, 64px) max(20px, env(safe-area-inset-right)) 96px max(20px, env(safe-area-inset-left)); }
.guide-top { display: flex; align-items: center; gap: 6px; margin-bottom: 36px; }
.guide h1 { margin: 0 0 12px; font: 750 clamp(34px, 6vw, 46px)/1.04 var(--font-display); letter-spacing: -0.035em; }
.guide-lede { max-width: 36rem; margin: 0 0 40px; color: var(--ink-soft); font-size: 17px; line-height: 1.55; }
.guide section { display: grid; gap: 4px; padding-block: 28px 4px; }
.guide h2 { margin: 0 0 6px; font: 700 22px/1.2 var(--font-display); letter-spacing: -0.02em; }
.guide h3 { margin: 18px 0 2px; font: 650 16px var(--font-body); }
.guide p, .guide li { color: var(--ink-soft); line-height: 1.6; }
.guide p { margin: 0 0 8px; }
.guide ul { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; }
.guide p a, .guide li a { color: var(--dusk-ink); }
.guide code { padding: 1px 6px; border-radius: 6px; background: var(--code-wash); color: var(--ink); font: 0.88em var(--font-mono); }
.steps { list-style: none; counter-reset: step; margin: 0; padding: 0; display: grid; gap: 14px; }
.steps > li { counter-increment: step; position: relative; padding-left: 38px; }
.steps > li::before { content: counter(step); position: absolute; left: 0; top: 0; width: 26px; height: 26px; border-radius: 50%; background: var(--surface); color: var(--ink); font: 700 13px/26px var(--font-display); text-align: center; box-shadow: var(--shadow-soft); }
.step-note { font-size: 13.5px; }
.cmd { position: relative; margin: 8px 0 10px; border-radius: 18px; background: var(--surface); box-shadow: var(--shadow-soft); }
.cmd-text { margin: 0; padding: 14px 56px 14px 18px; color: var(--ink); font: 13px/1.7 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.cmd-line { display: block; }
.cmd-word { white-space: nowrap; }
.cmd.prompt .cmd-line:first-child::before { content: "$ "; content: "$ " / ""; color: var(--muted); }
.cmd-copy { position: absolute; top: 8px; right: 8px; }
.cmd-copy .icon-done, .cmd-copy.copied .icon-copy { display: none; }
.cmd-copy.copied .icon-done { display: block; color: var(--dusk-ink); }`;

/** A share recipient's page: the viewer and nothing an owner needs. */
export const PUBLIC_CSS = FONT_CSS + TOKENS_CSS + BASE_CSS + VIEWER_CSS;

/** Every owner page: library, viewers, guide, and the rename dialog. */
export const OWNER_CSS = PUBLIC_CSS + LIBRARY_CSS + GUIDE_CSS + TITLE_EDITOR_CSS;
