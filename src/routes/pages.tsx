import type { Context } from "hono";
import type { Child, FC, PropsWithChildren } from "hono/jsx";

import type { DocumentFileRow, ResolvedDocument } from "../lib/db";
import {
	getLiveDocument,
	getLiveDocumentAt,
	getLiveShare,
	listDocumentsWithShares,
	listShares,
	listVersions,
	listVersionFiles,
} from "../lib/db";
import { documentTitleState } from "../lib/documents";
import { rawFileUrl, viewerFileUrl } from "../lib/file-links";
import { MAX_BYTES, MAX_FILES } from "../lib/files";
import { applyHeaders, isVersionString, uniform404, VIEWER_HEADERS } from "../lib/http";
import { nowSeconds } from "../lib/time";
import { TITLE_EDITOR_CSS, TITLE_EDITOR_JS } from "../lib/title-editor";
import { mintOwnerToken } from "../lib/tokens";

type Ctx<P extends string = string> = Context<{ Bindings: Env }, P>;

const ACCENT = "oklch(0.68 0.17 52)";
const ACCENT_HOVER = "oklch(0.62 0.17 52)";

// Inlined as data URIs so the icon also loads on /v/* pages, where anonymous
// visitors could not fetch a favicon path sitting behind Cloudflare Access.
const FAVICON_SVG =
	"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2096%2096'%3E%3Crect%20width='96'%20height='96'%20rx='24'%20fill='%231a1a1e'/%3E%3Ctext%20x='26'%20y='60'%20font-family='ui-monospace,Menlo,SF%20Mono,Consolas,monospace'%20font-weight='650'%20font-size='54'%20fill='%23fff'%3Ep%3C/text%3E%3Ccircle%20cx='66'%20cy='52'%20r='8'%20fill='%23e8823f'/%3E%3C/svg%3E";
const FAVICON_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC40lEQVR4AcxWX0iTURT/bW3lwinZg6G2lQ/9eRBJe1IkB1pPQhhCkW+SRgQ99qC5jYGkoPXQW++BD5EJmj5tezQIIZfENrYoEYTY6GHNjbWvcy6fN76xzblvbY577j33nO/+fr97d74/RuT82tou9Le02FytrXYvjUolTMVy5VCJqUYAkbmy2ayXMk5FUfpprEhTsZyEzxvSCJECKMkJZ0UYi4OwEOYSVwkBVSQXpNRJEUIAB8iq3Zxcb0Z199UmF3xUb/1Gg8FwQ8xq0DG3Ua3QGtADzH1QAzURwKTHW4DFYsH29mdhy8vvMDs7g3D4K3Z2vmFraxO9vT28CV1W9ARMJhMaGxuFdXd3YXT0PlgUFQ+ampqwuPgGdrvt/wnIRU6n01hZ+YBMJiNSLMTjcQu/3K7oCeSCDg3dxvj4Q0xOPpOpzs5O6ZfjlCyAdx0IfBEcq6trYuSuocHKg8barAbcungCV88eDn/4FSo03bOqBySTSenz3yAn5IxcMcF7z4JXg6ewfKcOT66bKVq4lSzAbDbDZjsvkAYHB8TIXSKR4EHaVM9J6bPzuMsMe0NhmsIZXp1jS0tvMTHxAHNzz2UmGo1K/0ydAadNciqdc/UG6ec6RxLQ3NyM6ekpWK31EsfjmZF+fF9B4GdWztlJ03Rz7w+7ea1kAfF4HJFIRAMyP/8CGxsfNbGnvjQ+7RErRaO/FDxaTyFdmB8lC+Ai7OtzwOEYwNjYONrbL2Fh4SXRaFswlsXd9/u4/Po3bi4m4f9RhJ2WliyArhUtGAxhbW0dqVRKzAt1WaVQRhs/sgDtcv2zogL44ROLxcAWCoX1s+VBKCqAHzgdHdfANjw8kme5/hB/kvn0w5SHQE9RH3+S+ctbrn8V3Vl+I/1qdgK7u99dRvq6YQH6XurlHYbgFEXISghDBGisRnOrnP+ehGqgGiIkOe9UnAA7bCyCjF9dbq5Qjuk1Xq9iuaneHITv4tiB/QUAAP//NJmctQAAAAZJREFUAwAtzvtXfUxb5gAAAABJRU5ErkJggg==";

const PAGE_CSS =
	TITLE_EDITOR_CSS +
	`
.file-tabs { display: flex; flex: 0 0 auto; overflow-x: auto; border-bottom: 1px solid #e6e6eb; padding: 0 16px; background: #fafafa; scrollbar-width: thin; }
.file-tab { flex: 0 0 auto; padding: 12px 14px; border-bottom: 2px solid transparent; color: #62626b; font-size: 12px; white-space: nowrap; }
.file-tab:hover { color: #1a1a1e; background: #f1f1f5; }
.file-tab[aria-current="page"] { color: #9a4a12; border-bottom-color: ${ACCENT}; background: #fff; font-weight: 600; }
.single-file-nav { display: none; }
.folder-link { display: block; margin: 12px auto 0; border: 0; background: none; color: #62626b; font: inherit; font-size: 12px; cursor: pointer; padding: 8px; text-decoration: underline; text-underline-offset: 3px; }
button:disabled { cursor: wait; opacity: .5; }
button:focus-visible, a:focus-visible { outline: 2px solid #b45309; outline-offset: 3px; }
@media (max-width: 640px) { .topbar { flex-wrap: wrap; } .tb-title { flex: 1; min-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .topbar .spacer { display: none; } .tb-chip { width: 100%; } .file-tabs { padding: 0 4px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; } }

html, body { height: 100%; }
body { margin: 0; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1a1a1e; }
a { color: #d97706; text-decoration: none; }
a:hover { color: #b45309; }
* { box-sizing: border-box; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes popIn { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes rowIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

.wrap { min-height: 100vh; display: flex; flex-direction: column; }
.spacer { flex: 1; }

.lib { max-width: 640px; width: 100%; margin: 0 auto; padding: 48px 24px 32px; flex: 1; display: flex; flex-direction: column; }
.brand-row { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
.brand { font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
a.gh { color: #8b8b94; display: inline-flex; align-items: center; padding: 4px; border-radius: 6px; line-height: 0; }
a.gh:hover { color: #1a1a1e; background: #e6e6eb; }
a.gh svg { width: 16px; height: 16px; display: block; }
.brand .dot { color: ${ACCENT}; }
.rows { display: flex; flex-direction: column; }
.row { position: relative; display: flex; align-items: center; gap: 14px; padding: 14px 10px; border-top: 1px solid #e6e6eb; margin: 0 -10px; border-radius: 8px; cursor: pointer; animation: rowIn .18s ease; }
.row:hover { background: #f1f1f5; }
.row-main { flex: 1; min-width: 0; }
.row-title { font-size: 14.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta { font-size: 12px; color: #9a9aa2; margin-top: 4px; }
.shared-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #6e6e76; white-space: nowrap; }
.shared-dot { width: 5px; height: 5px; border-radius: 99px; background: ${ACCENT}; }
.ttl-label { font-size: 12px; color: #9a9aa2; white-space: nowrap; }
.menu-btn { color: #8b8b94; font-size: 15px; letter-spacing: 2px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
.menu-btn:hover { background: #e6e6eb; color: #1a1a1e; }
.menu { position: absolute; right: 6px; top: calc(100% - 6px); z-index: 20; background: #fff; border: 1px solid #e0e0e6; border-radius: 10px; box-shadow: 0 8px 28px rgba(20,20,40,.16); padding: 5px; min-width: 150px; animation: popIn .12s ease; }
.menu-item { font-size: 13px; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
.menu-item:hover { background: #f1f1f5; }
.menu-item.del { color: #c2483f; }
.menu-item.del:hover { background: #fdf0ef; }
.line { border-top: 1px solid #e6e6eb; margin: 0 -10px; }
.hint { border: 0; background: none; font-family: inherit; padding: 8px; font-size: 12px; color: #62626b; margin-top: 28px; text-align: center; cursor: pointer; }
.hint:hover { color: #8b8b94; }

.viewer { display: flex; flex-direction: column; flex: 1; height: 100dvh; min-height: 0; background: #fff; }
.topbar { display: flex; align-items: center; gap: 10px; padding: 9px 16px; border-bottom: 1px solid #e6e6eb; background: #fafafa; position: sticky; top: 0; z-index: 10; }
.back { color: #8b8b94; font-size: 14px; padding: 2px 8px; border-radius: 6px; cursor: pointer; }
.back:hover { background: #e6e6eb; color: #1a1a1e; }
.tb-brand { font-size: 12px; color: #b3b3bb; }
.tb-title { font-size: 13px; font-weight: 600; }
.tb-chip { font-size: 12px; color: #8b8b94; white-space: nowrap; }
.tb-ver { background: #fff; border: 1px solid #e0e0e6; color: #6e6e76; font-size: 12px; font-weight: 500; font-family: inherit; padding: 5px 11px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
.tb-ver:hover { border-color: #c9c9d1; color: #1a1a1e; }
.share-btn { background: ${ACCENT}; color: #fff; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 7px; cursor: pointer; border: 0; font-family: inherit; }
.share-btn:hover { background: ${ACCENT_HOVER}; }
.frame { flex: 1; min-height: 0; border: 0; width: 100%; }
.banner { display: flex; align-items: center; gap: 12px; padding: 8px 16px; font-size: 12px; color: #6e6e76; background: oklch(0.68 0.17 52 / .08); border-bottom: 1px solid oklch(0.68 0.17 52 / .3); }
.banner-act { font-size: 12px; font-weight: 500; color: oklch(0.55 0.17 52); cursor: pointer; white-space: nowrap; }

.backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(24,24,32,.32); backdrop-filter: blur(2px); display: grid; place-items: center; animation: fadeIn .12s ease; }
.modal { width: 440px; max-width: calc(100vw - 40px); background: #fff; border: 1px solid #e0e0e6; border-radius: 12px; box-shadow: 0 12px 40px rgba(20,20,40,.22); padding: 22px 24px; animation: popIn .14s ease; }
.modal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 18px; }
.modal-title-main { font-size: 14px; font-weight: 650; }
.modal-title-doc { font-size: 12.5px; color: #8b8b94; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.modal-x { color: #8b8b94; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }
.modal-x:hover { background: #f1f1f5; color: #1a1a1e; }
.ttl-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 22px; }
.seg { display: flex; background: #f1f1f5; border-radius: 8px; padding: 3px; gap: 2px; font-size: 12.5px; font-weight: 500; }
.seg-opt { padding: 5px 14px; border-radius: 6px; cursor: pointer; color: #6e6e76; }
.seg-opt.active { background: #fff; box-shadow: 0 1px 3px rgba(20,20,40,.14); color: #1a1a1e; }
.create-btn { background: ${ACCENT}; color: #fff; font-size: 12.5px; font-weight: 600; padding: 7px 16px; border-radius: 8px; cursor: pointer; }
.create-btn:hover { background: ${ACCENT_HOVER}; }
.active-head { font-size: 12px; font-weight: 500; color: #8b8b94; margin-bottom: 8px; }
.empty { font-size: 12.5px; color: #8b8b94; border: 1px dashed #e0e0e6; border-radius: 8px; padding: 14px; text-align: center; }
.share-list { display: flex; flex-direction: column; gap: 6px; }
.share-row { display: flex; align-items: center; gap: 10px; border: 1px solid #e6e6eb; background: #fff; border-radius: 8px; padding: 8px 12px; animation: rowIn .16s ease; }
.share-row.hl { border-color: oklch(0.68 0.17 52 / .45); background: oklch(0.68 0.17 52 / .05); }
.share-url { font: 400 12px ui-monospace, Menlo, monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.share-copy { font-size: 12px; font-weight: 500; color: #8b8b94; cursor: pointer; white-space: nowrap; }
.share-copy.copied { color: oklch(0.55 0.17 52); }
.share-left { font-size: 12px; color: #8b8b94; white-space: nowrap; }
.share-revoke { font-size: 12px; color: #c2483f; cursor: pointer; }

.drop { position: fixed; inset: 14px; z-index: 80; border: 2px dashed oklch(0.68 0.17 52 / .7); border-radius: 14px; background: oklch(0.68 0.17 52 / .07); display: grid; place-items: center; animation: fadeIn .12s ease; pointer-events: none; }
.drop-icon { width: 44px; height: 44px; border-radius: 12px; background: ${ACCENT}; color: #fff; display: grid; place-items: center; font-size: 20px; margin: 0 auto 14px; }
.drop-title { font-size: 15px; font-weight: 650; }
.drop-sub { font-size: 12px; color: #8b8b94; margin-top: 6px; }

.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 90; background: #1a1a1e; color: #fff; font-size: 12.5px; padding: 8px 16px; border-radius: 8px; box-shadow: 0 6px 20px rgba(20,20,40,.25); animation: popIn .15s ease; white-space: nowrap; }`;

// Shared client logic: toast, the share modal (built with textContent only, no
// innerHTML with user data), remaining-time formatting, and Esc-to-close.
const CORE_JS = `
function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}
function nowSec() { return Math.floor(Date.now() / 1000); }
// Mirror server-side formatRemaining in this file. Keep both copies in sync.
function fmtRemaining(sec) {
	if (sec >= 172800) return Math.floor(sec / 86400) + "d";
	if (sec >= 3600) return Math.floor(sec / 3600) + "h";
	return Math.max(0, Math.floor(sec / 60)) + "m";
}
// Local-timezone twin of the server-side fmtCreated (pages.tsx), which can only
// render UTC. Keep both copies in sync. Used by the [data-created] rewrite on the
// library and by the version rows in the versions modal.
const CREATED_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function fmtCreated(sec) {
	const p = {};
	CREATED_FMT.formatToParts(new Date(sec * 1000)).forEach(function (x) { p[x.type] = x.value; });
	return p.month + " " + p.day + ", " + p.hour + ":" + p.minute;
}
let toastT;
function toast(msg) {
	const old = document.getElementById("toast");
	if (old) old.remove();
	const t = el("div", "toast", msg);
	t.id = "toast";
	document.body.append(t);
	clearTimeout(toastT);
	toastT = setTimeout(function () { t.remove(); }, 2200);
}
function closeModal() {
	const root = document.getElementById("modal-root");
	if (root) root.textContent = "";
}
function updateShareCount() {
	const root = document.getElementById("modal-root");
	const list = root.querySelector(".share-list");
	if (!list) return;
	const n = list.children.length;
	root.querySelector(".active-head").textContent = "Active links \\u00b7 " + n;
	root.querySelector(".empty").style.display = n ? "none" : "";
}
// writeText can hang instead of rejecting while Chrome waits for document focus or a
// pending permission prompt. Race it with a timeout so callers always get an
// answer, and never await it before an update that has to happen regardless.
function copyToClipboard(text) {
	if (!navigator.clipboard) return Promise.resolve(false);
	return Promise.race([
		navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }),
		new Promise(function (r) { setTimeout(function () { r(false); }, 1000); }),
	]);
}
// Never claim a copy that did not happen; the URL is on screen in .share-url,
// so a failure just points the user at it.
function reflectCopy(copy, ok) {
	if (!ok) { toast("Could not copy \\u2014 select the link instead"); return; }
	copy.textContent = "Copied \\u2713";
	copy.classList.add("copied");
}
function shareRow(s, highlight) {
	const full = location.origin + "/v/" + s.token;
	const display = location.host + "/v/" + s.token;
	const row = el("div", "share-row" + (highlight ? " hl" : ""));
	row.append(el("span", "share-url", display));
	const copy = el("span", "share-copy", "copy");
	copy.addEventListener("click", function () {
		copyToClipboard(full).then(function (ok) { reflectCopy(copy, ok); });
	});
	row.append(copy);
	row.append(el("span", "share-left", fmtRemaining(s.expires_at - nowSec()) + " left"));
	const revoke = el("span", "share-revoke", "Revoke");
	revoke.addEventListener("click", async function () {
		const r = await fetch("/api/shares/" + s.token, { method: "DELETE" });
		if (r.ok) { row.remove(); updateShareCount(); }
		else toast("Revoke failed");
	});
	row.append(revoke);
	return row;
}
let modalTtl = "1d";
async function createLink(docId) {
	const res = await fetch("/api/documents/" + docId + "/shares", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ttl: modalTtl }),
	});
	if (!res.ok) { toast("Could not create link"); return; }
	const s = await res.json();
	// The link is live server-side now, so render it before touching the
	// clipboard. A stalled copy must not leave the list looking empty.
	const row = shareRow(s, true);
	document.getElementById("modal-root").querySelector(".share-list").prepend(row);
	updateShareCount();
	const copy = row.querySelector(".share-copy");
	copyToClipboard(location.origin + "/v/" + s.token).then(function (ok) { reflectCopy(copy, ok); });
}
async function openModal(docId, docTitle) {
	modalTtl = "1d";
	const root = document.getElementById("modal-root");
	const backdrop = el("div", "backdrop");
	const modal = el("div", "modal");
	backdrop.addEventListener("click", closeModal);
	modal.addEventListener("click", function (e) { e.stopPropagation(); });
	backdrop.append(modal);

	const head = el("div", "modal-head");
	head.append(el("span", "modal-title-main", "Share"));
	head.append(el("span", "modal-title-doc", docTitle));
	head.append(el("span", "spacer"));
	const x = el("span", "modal-x", "\\u2715");
	x.addEventListener("click", closeModal);
	head.append(x);
	modal.append(head);

	const bar = el("div", "ttl-bar");
	const seg = el("div", "seg");
	const opts = {};
	["1h", "1d", "1w"].forEach(function (t) {
		const o = el("span", "seg-opt" + (t === modalTtl ? " active" : ""), t);
		o.addEventListener("click", function () {
			modalTtl = t;
			for (const k in opts) opts[k].className = "seg-opt" + (k === t ? " active" : "");
		});
		opts[t] = o;
		seg.append(o);
	});
	bar.append(seg);
	bar.append(el("span", "spacer"));
	const create = el("span", "create-btn", "Create link");
	create.addEventListener("click", function () { createLink(docId); });
	bar.append(create);
	modal.append(bar);

	modal.append(el("div", "active-head", "Active links \\u00b7 0"));
	modal.append(el("div", "empty", "No active links yet."));
	modal.append(el("div", "share-list"));

	root.textContent = "";
	root.append(backdrop);

	const res = await fetch("/api/documents/" + docId + "/shares");
	if (res.ok) {
		const data = await res.json();
		const list = root.querySelector(".share-list");
		(data.shares || []).forEach(function (s) { list.append(shareRow(s, false)); });
		updateShareCount();
	}
}
window.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });`;

// Drag/drop, paste and file-picker uploading, shared by the library and the
// owner viewer. `#drop` carries the target: `data-endpoint` is where the file is
// POSTed and `data-with-title` asks for a `title` field (the library names a new
// document after the file; a new version keeps the document's title). No `#drop`
// = a read-only page, so nothing is wired at all.
//
// Send `title` only for a dropped or selected file, which has a user-chosen
// name. Pasted text uses the synthetic name `pasted.md`, so omit the field and
// let the server choose a title (lib/title.ts).
//
// The viewer content sits in a sandboxed iframe on an opaque origin. Its drag
// events never reach this document, so a drop only registers over the topbar,
// banner, or margins. ⌘V still works whenever
// focus is outside the iframe. Use the "Add or update files" button in the
// versions modal instead.
const UPLOAD_JS = `
const dropEl = document.getElementById("drop");
const fileInput = document.getElementById("file");
const folderInput = document.getElementById("folder");
let dragDepth = 0;
let uploading = false;
function countFile(file, budget) {
	budget.count++; budget.bytes += file.size;
	if (budget.count > ${MAX_FILES}) throw new Error("Select at most ${MAX_FILES} files.");
	if (budget.bytes > ${MAX_BYTES}) throw new Error("Keep each upload under 10 MB.");
}
async function uploadFiles(files, named) {
	if (!files.length || uploading) return;
	uploading = true;
	const controls = document.querySelectorAll("[data-upload], [data-folder]");
	controls.forEach(function (control) { control.disabled = true; });
	toast("Uploading " + files.length + (files.length === 1 ? " file…" : " files…"));
	try {
		const budget = { count: 0, bytes: 0 };
		files.forEach(function (entry) { countFile(entry.file || entry, budget); });
		const fd = new FormData();
		files.forEach(function (entry) {
			const file = entry.file || entry;
			fd.append("file", file, file.name || "pasted.md");
			fd.append("path", entry.path || file.webkitRelativePath || file.name || "pasted.md");
		});
		if (named && dropEl.dataset.withTitle) fd.set("title", (files[0].file || files[0]).name);
		const res = await fetch(dropEl.dataset.endpoint, { method: "POST", body: fd });
		if (!res.ok) throw new Error(await res.text());
		const doc = await res.json();
		toast("Uploaded " + files.length + (files.length === 1 ? " file" : " files"));
		const url = new URL(location.href);
		url.searchParams.delete("v");
		if (dropEl.dataset.withTitle && doc.id) { url.pathname = "/d/" + doc.id; url.search = ""; }
		location.href = url.href;
	} catch (error) {
		toast(error.message || "Upload failed. Try again.");
	} finally {
		uploading = false;
		controls.forEach(function (control) { control.disabled = false; });
	}
}
async function readEntry(entry, prefix, budget) {
	if (entry.isFile) {
		const file = await new Promise(function (resolve, reject) { entry.file(resolve, reject); });
		countFile(file, budget);
		return [{ file: file, path: prefix + entry.name }];
	}
	if (!entry.isDirectory) return [];
	const reader = entry.createReader();
	let files = [];
	while (true) {
		const entries = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
		if (!entries.length) break;
		for (const child of entries) files = files.concat(await readEntry(child, prefix + entry.name + "/", budget));
	}
	return files;
}
if (dropEl && fileInput) {
	window.addEventListener("dragenter", function (e) { e.preventDefault(); dragDepth++; dropEl.style.display = "grid"; });
	window.addEventListener("dragleave", function (e) { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.style.display = "none"; });
	window.addEventListener("dragover", function (e) { e.preventDefault(); });
	window.addEventListener("drop", async function (e) {
		e.preventDefault(); dragDepth = 0; dropEl.style.display = "none";
		try {
			const items = Array.from(e.dataTransfer.items || []);
			const entries = items.map(function (item) { return item.webkitGetAsEntry && item.webkitGetAsEntry(); }).filter(Boolean);
			let files = [];
			const budget = { count: 0, bytes: 0 };
			for (const entry of entries) files = files.concat(await readEntry(entry, "", budget));
			if (!entries.length) files = Array.from(e.dataTransfer.files || []);
			if (entries.length === 1 && entries[0].isDirectory) files = files.map(function (entry) { return { file: entry.file, path: entry.path.slice(entries[0].name.length + 1) }; });
			await uploadFiles(files, true);
		} catch (error) { toast(error.message || "Could not read the dropped files. Try selecting them instead."); }
	});
	window.addEventListener("paste", function (e) {
		if (e.target.closest("input, textarea, [contenteditable]")) return;
		const files = Array.from(e.clipboardData.files || []);
		if (files.length) { e.preventDefault(); uploadFiles(files, true); return; }
		const text = e.clipboardData.getData("text");
		if (text) { e.preventDefault(); uploadFiles([new File([text], "pasted.md", { type: "text/markdown" })], false); }
	});
	const hint = document.getElementById("hint");
	if (hint) hint.addEventListener("click", function () { fileInput.click(); });
	document.querySelectorAll("[data-upload]").forEach(function (control) { control.addEventListener("click", function () { fileInput.click(); }); });
	document.querySelectorAll("[data-folder]").forEach(function (control) { control.addEventListener("click", function () { folderInput.click(); }); });
	fileInput.addEventListener("change", function () { uploadFiles(Array.from(fileInput.files), true); fileInput.value = ""; });
	if (folderInput) folderInput.addEventListener("change", function () { uploadFiles(Array.from(folderInput.files).map(function (file) { return { file: file, path: file.webkitRelativePath.split("/").slice(1).join("/") }; }), true); folderInput.value = ""; });
}`;

const LIBRARY_JS = `
// Created timestamps are server-rendered in UTC and ship with a raw epoch;
// restate them in the viewer's own timezone.
document.querySelectorAll("[data-created]").forEach(function (node) {
	node.textContent = fmtCreated(Number(node.dataset.created));
});

function closeMenus() {
	document.querySelectorAll("[data-menu-pop]").forEach(function (m) { m.style.display = "none"; });
	document.querySelectorAll("[data-menu]").forEach(function (m) { m.setAttribute("aria-expanded", "false"); });
}
window.addEventListener("click", closeMenus);
window.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });
document.querySelectorAll(".row").forEach(function (row) {
	const id = row.dataset.id;
	const pop = row.querySelector("[data-menu-pop]");
	row.addEventListener("click", function (e) {
		if (e.target.closest("[data-menu]") || e.target.closest("[data-menu-pop]")) return;
		location.href = "/d/" + id;
	});
	row.querySelector("[data-menu]").addEventListener("click", function (e) {
		e.stopPropagation();
		const open = pop.style.display !== "none";
		closeMenus();
		pop.style.display = open ? "none" : "block";
		e.currentTarget.setAttribute("aria-expanded", String(!open));
	});
	pop.addEventListener("click", function (e) { e.stopPropagation(); });
	row.querySelector("[data-share]").addEventListener("click", function () { closeMenus(); openModal(id, row.dataset.title); });
	row.querySelector("[data-rename]").addEventListener("click", function () {
		closeMenus();
		openTitleEditor(row, row.querySelector("[data-menu]"));
	});
	row.querySelector("[data-delete]").addEventListener("click", async function () {
		closeMenus();
		const res = await fetch("/api/documents/" + id, { method: "DELETE" });
		if (res.ok) { toast("Deleted \\u2014 poof"); setTimeout(function () { location.reload(); }, 600); }
		else toast("Delete failed");
	});
});`;

// The versions modal: history list, "View" (pinned read-only page), "Restore"
// (rollback) and the viewer's upload button. Built
// with el()/textContent only. User data never reaches innerHTML.
const VERSIONS_JS = `
async function restoreVersion(docId, n) {
	const res = await fetch("/api/documents/" + docId + "/versions/" + n + "/rollback", { method: "POST" });
	if (!res.ok) { toast("Restore failed"); return; }
	toast("Restored \\u2014 v" + n);
	setTimeout(function () { location.href = "/d/" + docId; }, 600);
}
function versionRow(docId, v, current) {
	const isCurrent = v.version === current;
	const row = el("div", "share-row" + (isCurrent ? " hl" : ""));
	row.append(el("span", "share-url", "v" + v.version + " \\u00b7 " + v.kind));
	row.append(el("span", "share-left", fmtCreated(v.created_at)));
	if (isCurrent) {
		row.append(el("span", "share-left", "current"));
		return row;
	}
	const view = el("span", "share-copy", "View");
	view.addEventListener("click", function () { location.href = "/d/" + docId + "?v=" + v.version; });
	row.append(view);
	const restore = el("span", "share-revoke", "Restore");
	restore.addEventListener("click", function () { restoreVersion(docId, v.version); });
	row.append(restore);
	return row;
}
async function openVersions(docId) {
	const root = document.getElementById("modal-root");
	const backdrop = el("div", "backdrop");
	const modal = el("div", "modal");
	backdrop.addEventListener("click", closeModal);
	modal.addEventListener("click", function (e) { e.stopPropagation(); });
	backdrop.append(modal);

	const head = el("div", "modal-head");
	head.append(el("span", "modal-title-main", "Versions"));
	head.append(el("span", "spacer"));
	if (fileInput) {
		const up = el("button", "create-btn", "Add or update files");
		up.type = "button";
		up.addEventListener("click", function () { fileInput.click(); });
		head.append(up);
	}
	const x = el("span", "modal-x", "\\u2715");
	x.addEventListener("click", closeModal);
	head.append(x);
	modal.append(head);

	modal.append(el("div", "active-head", "History"));
	modal.append(el("div", "share-list"));

	root.textContent = "";
	root.append(backdrop);

	const res = await fetch("/api/documents/" + docId + "/versions");
	if (!res.ok) { toast("Could not load versions"); return; }
	const data = await res.json();
	const versions = data.versions || [];
	const list = root.querySelector(".share-list");
	versions.forEach(function (v) { list.append(versionRow(docId, v, data.current_version)); });
	root.querySelector(".active-head").textContent = "History \\u00b7 " + versions.length;
}`;

const VIEWER_JS = `
const rename = document.getElementById("rename-current");
if (rename) rename.addEventListener("click", function () { openTitleEditor(rename, rename); });
const sc = document.getElementById("share-current");
if (sc) sc.addEventListener("click", function () { openModal(sc.dataset.id, sc.dataset.title); });
const vb = document.getElementById("ver-btn");
if (vb) vb.addEventListener("click", function () { openVersions(vb.dataset.id); });
const vr = document.getElementById("ver-restore");
if (vr) vr.addEventListener("click", function () { restoreVersion(vr.dataset.id, Number(vr.dataset.version)); });`;

const LIBRARY_SCRIPT = CORE_JS + TITLE_EDITOR_JS + UPLOAD_JS + LIBRARY_JS;
const FILES_JS = `
const frame = document.getElementById("document-frame");
if (frame) {
	function revealSelectedFile() {
		const selected = document.querySelector(".file-tab[aria-current=page]");
		if (selected) selected.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
	revealSelectedFile();
	window.addEventListener("resize", revealSelectedFile);
	if (location.hash) frame.src += location.hash;
	window.addEventListener("message", function (event) {
		if (event.source !== frame.contentWindow || !event.data || event.data.type !== "poof:file") return;
		const links = Array.from(document.querySelectorAll("[data-file-path]"));
		const link = links.find(function (item) { return item.dataset.filePath === event.data.path; });
		if (!link) return;
		const url = new URL(link.href);
		if (typeof event.data.hash === "string" && event.data.hash.startsWith("#")) url.hash = event.data.hash;
		location.href = url.href;
	});
}
const removeFile = document.getElementById("remove-file");
if (removeFile) removeFile.addEventListener("click", async function () {
	if (!confirm("Remove " + removeFile.dataset.path + " from this document? Earlier versions keep the file.")) return;
	removeFile.disabled = true;
	try {
		const body = new FormData(); body.append("delete", removeFile.dataset.path);
		const res = await fetch("/api/documents/" + removeFile.dataset.id + "/versions", { method: "POST", body: body });
		if (!res.ok) throw new Error(await res.text());
		location.href = location.pathname;
	} catch (error) { toast(error.message || "Could not remove the file. Try again."); removeFile.disabled = false; }
});`;

const VIEWER_SCRIPT = CORE_JS + TITLE_EDITOR_JS + UPLOAD_JS + VERSIONS_JS + VIEWER_JS + FILES_JS;

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<link rel="icon" type="image/png" sizes="32x32" href={FAVICON_PNG} />
			<link rel="icon" type="image/svg+xml" href={FAVICON_SVG} />
			<title>{title}</title>
			<style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
		</head>
		<body>{children}</body>
	</html>
);

// Shared viewer scaffold: topbar (contents vary per page) above the sandboxed
// iframe. The sandbox attribute enforces the security boundary (SPEC §6.1).
// Never add `allow-same-origin`.
const ViewerShell: FC<
	PropsWithChildren<{
		src: string;
		banner?: Child;
		files: DocumentFileRow[];
		selected: DocumentFileRow;
		base: string;
		version?: number;
	}>
> = ({ src, banner, files, selected, base, version, children }) => (
	<div class="viewer">
		<div class="topbar">
			{children}
			<a class="tb-ver" href={`${src}?format=raw`} download>
				Download
			</a>
		</div>
		{banner}
		<nav class={files.length > 1 ? "file-tabs" : "single-file-nav"} aria-label="Document files">
			{files.map((file) => (
				<a
					class="file-tab"
					href={viewerFileUrl(base, file.path, version)}
					data-file-path={file.path}
					aria-current={file.path === selected.path ? "page" : undefined}
					title={file.path}
				>
					{file.path}
				</a>
			))}
		</nav>
		<iframe
			id="document-frame"
			title={selected.path}
			class="frame"
			sandbox="allow-scripts allow-popups"
			src={`${src}?view=1`}
		/>
	</div>
);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * created_at (epoch seconds) → "Jul 21, 14:02" (en-US short month, 24h, UTC).
 * The worker has no viewer timezone, so this is the no-JS fallback: LIBRARY_JS
 * rewrites `[data-created]` to the browser's local zone on load.
 */
function fmtCreated(sec: number): string {
	const d = new Date(sec * 1000);
	const hh = String(d.getUTCHours()).padStart(2, "0");
	const mm = String(d.getUTCMinutes()).padStart(2, "0");
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm}`;
}

/**
 * seconds-until → "Nd" (>=48h), "Nh" (>=1h), else "Nm" (floored, min 0m).
 * Mirror the client-side `fmtRemaining` in CORE_JS. Keep both copies in sync.
 */
function formatRemaining(secondsUntil: number): string {
	if (secondsUntil >= 172800) return `${Math.floor(secondsUntil / 86400)}d`;
	if (secondsUntil >= 3600) return `${Math.floor(secondsUntil / 3600)}h`;
	return `${Math.max(0, Math.floor(secondsUntil / 60))}m`;
}

/** Render the library page for `GET /`. */
export async function libraryPage(c: Ctx) {
	const now = nowSeconds();
	const docs = await listDocumentsWithShares(c.env.DB, now);
	const titleStates = await Promise.all(docs.map(documentTitleState));
	return c.html(
		<Layout title="poof">
			<div class="wrap">
				<div class="lib">
					<div class="brand-row">
						<span class="brand">
							poof<span class="dot">.</span>
						</span>
						<span class="spacer" />
						<a
							class="gh"
							href="https://github.com/5n7/poof"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="GitHub"
						>
							<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
								<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
							</svg>
						</a>
					</div>
					<div class="rows">
						{docs.map((d, index) => {
							const shared = d.active_share_count > 0 && d.next_share_expires_at !== null;
							const hasTtl = !shared && d.expires_at !== null;
							return (
								<div class="row" data-id={d.id} data-title={d.title} data-state={titleStates[index]}>
									<div class="row-main">
										<div class="row-title">{d.title}</div>
										<div class="row-meta">
											{/* The timestamp sits in its own node: LIBRARY_JS replaces the
											    text content of [data-created] wholesale. */}
											<span data-created={String(d.created_at)}>{fmtCreated(d.created_at)}</span>
											{d.current_version > 1 ? <span>{` · v${d.current_version}`}</span> : null}
										</div>
									</div>
									{shared ? (
										<span class="shared-label">
											<span class="shared-dot" />
											{formatRemaining(d.next_share_expires_at! - now)}
										</span>
									) : null}
									{hasTtl ? <span class="ttl-label">expires {formatRemaining(d.expires_at! - now)}</span> : null}
									<button type="button" class="menu-btn" data-menu aria-label="Document actions" aria-expanded="false">
										···
									</button>
									<div class="menu" data-menu-pop style="display:none">
										<button type="button" class="menu-item" data-rename>
											Rename…
										</button>
										<button type="button" class="menu-item" data-share>
											Share…
										</button>
										<button type="button" class="menu-item del" data-delete>
											Delete
										</button>
									</div>
								</div>
							);
						})}
						<div class="line" />
					</div>
					<button type="button" class="hint" id="hint">
						Drop files anywhere, paste with ⌘V, or select files
					</button>
					<button type="button" class="folder-link" data-folder>
						Upload a folder
					</button>
				</div>
			</div>

			<div class="drop" id="drop" style="display:none" data-endpoint="/api/documents" data-with-title="1">
				<div style="text-align:center">
					<div class="drop-icon">↓</div>
					<div class="drop-title">Drop it into poof</div>
					<div class="drop-sub">Any format · up to 10 MB per upload · one document</div>
				</div>
			</div>

			<div id="modal-root" />
			<input type="file" id="file" multiple style="display:none" />
			<input type="file" id="folder" multiple webkitdirectory="" style="display:none" />
			<script dangerouslySetInnerHTML={{ __html: LIBRARY_SCRIPT }} />
		</Layout>,
	);
}

/**
 * Render the private owner viewer for GET /d/:id with an optional `?v=N`. Mint
 * a short-lived o_ token pinned to the requested version (SPEC §6.2).
 */
export async function ownerViewerPage(c: Ctx<"/d/:id">) {
	const id = c.req.param("id");
	const now = nowSeconds();

	// A malformed `?v=` is a missing page, not an API error. Unknown versions use
	// the same uniform 404 below.
	const rawVersion = c.req.query("v");
	if (rawVersion !== undefined && !isVersionString(rawVersion)) return uniform404(c);
	const asked = rawVersion === undefined ? null : Number(rawVersion);

	const doc = await getLiveDocumentAt(c.env.DB, id, asked, now);
	if (!doc) return uniform404(c);
	// `?v=` naming the live version is the normal page. Never render the current
	// content as a read-only dead end.
	if (asked !== null && asked !== doc.current_version) return pinnedViewerPage(c, doc);

	const [shares, oToken, files, titleState] = await Promise.all([
		listShares(c.env.DB, id, now),
		mintOwnerToken(id, c.env.OWNER_TOKEN_SECRET),
		listVersionFiles(c.env.DB, id, doc.version),
		documentTitleState(doc),
	]);
	const selected =
		c.req.query("file") === undefined ? files[0] : files.find((file) => file.path === c.req.query("file"));
	if (!selected) return uniform404(c);
	let chip: string | null = null;
	if (shares.length) {
		const soonest = Math.min(...shares.map((s) => s.expires_at));
		chip = `shared · ${formatRemaining(soonest - now)} left`;
	}
	applyHeaders(c, VIEWER_HEADERS);
	return c.html(
		<Layout title={doc.title}>
			<ViewerShell src={rawFileUrl(oToken, selected.path)} files={files} selected={selected} base={`/d/${id}`}>
				<a href="/" class="back">
					←
				</a>
				<span class="tb-brand">poof</span>
				<button
					type="button"
					class="tb-rename"
					id="rename-current"
					data-id={id}
					data-title={doc.title}
					data-state={titleState}
					aria-label="Rename document"
				>
					<span class="tb-title">{doc.title}</span>
					<span class="tb-rename-label">Rename</span>
				</button>
				<span class="spacer" />
				{chip ? <span class="tb-chip">{chip}</span> : null}
				<button type="button" class="tb-ver" data-upload>
					Add files
				</button>
				<button type="button" class="tb-ver" data-folder>
					Upload folder
				</button>
				{files.length > 1 ? (
					<button type="button" class="tb-ver remove-file" id="remove-file" data-id={id} data-path={selected.path}>
						Remove file
					</button>
				) : null}
				{/* Shown even at v1: it is how the history and "you can add a version" are discoverable. */}
				<button type="button" id="ver-btn" class="tb-ver" data-id={id}>
					v{doc.current_version}
				</button>
				<button type="button" id="share-current" class="share-btn" data-id={id} data-title={doc.title}>
					Share
				</button>
			</ViewerShell>
			<div class="drop" id="drop" style="display:none" data-endpoint={`/api/documents/${id}/versions`}>
				<div style="text-align:center">
					<div class="drop-icon">↓</div>
					<div class="drop-title">Add or update files</div>
					<div class="drop-sub">Files with the same path are updated. Other files stay.</div>
				</div>
			</div>
			<div id="modal-root" />
			<input type="file" id="file" multiple style="display:none" />
			<input type="file" id="folder" multiple webkitdirectory="" style="display:none" />
			<script dangerouslySetInnerHTML={{ __html: VIEWER_SCRIPT }} />
		</Layout>,
	);
}

/**
 * The `?v=N` branch of the owner viewer: a past version, read-only. No Share
 * button (shares always serve the current version, so offering one here would
 * read as "they can see v2") and no uploader (there is no branching model, so
 * "drop a file while looking at v2" has no meaning).
 */
async function pinnedViewerPage(c: Ctx<"/d/:id">, doc: ResolvedDocument) {
	const [versions, oToken, files] = await Promise.all([
		listVersions(c.env.DB, doc.id),
		mintOwnerToken(doc.id, c.env.OWNER_TOKEN_SECRET, 600, doc.version),
		listVersionFiles(c.env.DB, doc.id, doc.version),
	]);
	const selected =
		c.req.query("file") === undefined ? files[0] : files.find((file) => file.path === c.req.query("file"));
	if (!selected) return uniform404(c);
	applyHeaders(c, VIEWER_HEADERS);
	return c.html(
		<Layout title={doc.version_title ?? doc.title}>
			<ViewerShell
				src={rawFileUrl(oToken, selected.path)}
				files={files}
				selected={selected}
				base={`/d/${doc.id}`}
				version={doc.version}
				banner={
					<div class="banner">
						<span>Viewing version {doc.version} · read-only</span>
						<span class="spacer" />
						<span class="banner-act" id="ver-restore" data-id={doc.id} data-version={String(doc.version)}>
							Restore this version
						</span>
						<a class="banner-act" href={`/d/${doc.id}`}>
							Back to current
						</a>
					</div>
				}
			>
				<a href="/" class="back">
					←
				</a>
				<span class="tb-brand">poof</span>
				<span class="tb-title">{doc.version_title ?? doc.title}</span>
				<span class="spacer" />
				<span class="tb-chip">
					v{doc.version} of {versions.length}
				</span>
			</ViewerShell>
			<div id="modal-root" />
			<script dangerouslySetInnerHTML={{ __html: VIEWER_SCRIPT }} />
		</Layout>,
	);
}

/** Render the public shared viewer for `GET /v/:token` (SPEC §12.4). */
export async function publicViewerPage(c: Ctx<"/v/:token">) {
	const token = c.req.param("token");
	const now = nowSeconds();
	const share = await getLiveShare(c.env.DB, token, now);
	if (!share) return uniform404(c);
	const doc = await getLiveDocument(c.env.DB, share.document_id, now);
	if (!doc) return uniform404(c);
	const files = await listVersionFiles(c.env.DB, doc.id, doc.version);
	const selected =
		c.req.query("file") === undefined ? files[0] : files.find((file) => file.path === c.req.query("file"));
	if (!selected) return uniform404(c);

	applyHeaders(c, VIEWER_HEADERS);
	return c.html(
		<Layout title={doc.title}>
			<ViewerShell src={rawFileUrl(token, selected.path)} files={files} selected={selected} base={`/v/${token}`}>
				<span class="tb-brand">poof</span>
				<span class="tb-title">{doc.title}</span>
				<span class="spacer" />
				<span class="tb-chip">expires in {formatRemaining(share.expires_at - now)}</span>
			</ViewerShell>
			<script dangerouslySetInnerHTML={{ __html: FILES_JS }} />
		</Layout>,
	);
}
