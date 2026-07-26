import type { Context } from "hono";
import type { Child, FC, PropsWithChildren } from "hono/jsx";

import type { ResolvedDocument } from "../lib/db";
import {
	getLiveDocument,
	getLiveDocumentAtVersion,
	getLiveShare,
	listDocumentsWithShares,
	listShares,
	listVersions,
} from "../lib/db";
import { applyHeaders, uniform404, VIEWER_HEADERS } from "../lib/http";
import { nowSeconds } from "../lib/time";
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

const PAGE_CSS = `
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
.brand-row { display: flex; align-items: baseline; gap: 10px; margin-bottom: 28px; }
.brand { font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
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
.hint { font-size: 12px; color: #b3b3bb; margin-top: 28px; text-align: center; cursor: pointer; }
.hint:hover { color: #8b8b94; }

.viewer { display: flex; flex-direction: column; flex: 1; min-height: 100vh; background: #fff; }
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
.frame { flex: 1; border: 0; width: 100%; }
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
// Mirror of server-side formatRemaining (pages.tsx) — keep the two in sync.
function fmtRemaining(sec) {
	if (sec >= 172800) return Math.floor(sec / 86400) + "d";
	if (sec >= 3600) return Math.floor(sec / 3600) + "h";
	return Math.max(0, Math.floor(sec / 60)) + "m";
}
// Local-timezone twin of the server-side fmtCreated (pages.tsx), which can only
// render UTC — keep the two in sync. Used by the [data-created] rewrite on the
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
function shareRow(s, highlight) {
	const full = location.origin + "/v/" + s.token;
	const display = location.host + "/v/" + s.token;
	const row = el("div", "share-row" + (highlight ? " hl" : ""));
	row.append(el("span", "share-url", display));
	const copy = el("span", "share-copy" + (highlight ? " copied" : ""), highlight ? "Copied \\u2713" : "copy");
	copy.addEventListener("click", async function () {
		try { await navigator.clipboard.writeText(full); } catch (e) {}
		copy.textContent = "Copied \\u2713";
		copy.classList.add("copied");
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
	try { await navigator.clipboard.writeText(location.origin + "/v/" + s.token); } catch (e) {}
	document.getElementById("modal-root").querySelector(".share-list").prepend(shareRow(s, true));
	updateShareCount();
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
// On the viewer the content sits in a sandboxed iframe — a separate document on
// an opaque origin — so its drag events never reach this document and a drop
// only registers over the topbar, banner or margins. ⌘V still works whenever
// focus is outside the iframe. The primary affordance there is therefore the
// explicit "Upload new version" button in the versions modal, not the drop zone.
const UPLOAD_JS = `
const dropEl = document.getElementById("drop");
const fileInput = document.getElementById("file");
let dragDepth = 0;
async function uploadFile(file) {
	const name = file.name || "pasted.md";
	// Extension → kind. Mirror of kindFromExtension (cli/index.ts) and the
	// server's kind check (api.ts) — keep the three in sync.
	const kind = /\\.html?$/i.test(name) ? "html" : "md";
	const fd = new FormData();
	fd.set("file", file, name);
	fd.set("kind", kind);
	if (dropEl.dataset.withTitle) fd.set("title", name);
	const res = await fetch(dropEl.dataset.endpoint, { method: "POST", body: fd });
	// Drop any ?v= pin so both pages land on the current version.
	if (res.ok) { toast("Uploaded \\u2014 " + name); setTimeout(function () { location.href = location.pathname; }, 600); }
	else toast(await res.text());
}
if (dropEl && fileInput) {
	window.addEventListener("dragenter", function (e) { e.preventDefault(); dragDepth++; dropEl.style.display = "grid"; });
	window.addEventListener("dragleave", function (e) { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.style.display = "none"; });
	window.addEventListener("dragover", function (e) { e.preventDefault(); });
	window.addEventListener("drop", function (e) {
		e.preventDefault(); dragDepth = 0; dropEl.style.display = "none";
		const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
		if (f) uploadFile(f);
	});
	window.addEventListener("paste", function (e) {
		const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
		if (f) { uploadFile(f); return; }
		const text = e.clipboardData && e.clipboardData.getData("text");
		if (text) uploadFile(new File([text], "pasted.md", { type: "text/markdown" }));
	});
	const hint = document.getElementById("hint");
	if (hint) hint.addEventListener("click", function () { fileInput.click(); });
	fileInput.addEventListener("change", function () { const f = fileInput.files[0]; if (f) uploadFile(f); fileInput.value = ""; });
}`;

const LIBRARY_JS = `
// Created timestamps are server-rendered in UTC and ship with a raw epoch;
// restate them in the viewer's own timezone.
document.querySelectorAll("[data-created]").forEach(function (node) {
	node.textContent = fmtCreated(Number(node.dataset.created));
});

function closeMenus() { document.querySelectorAll("[data-menu-pop]").forEach(function (m) { m.style.display = "none"; }); }
window.addEventListener("click", closeMenus);
window.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });
document.querySelectorAll(".row").forEach(function (row) {
	const id = row.dataset.id, title = row.dataset.title;
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
	});
	pop.addEventListener("click", function (e) { e.stopPropagation(); });
	row.querySelector("[data-share]").addEventListener("click", function () { closeMenus(); openModal(id, title); });
	row.querySelector("[data-delete]").addEventListener("click", async function () {
		closeMenus();
		const res = await fetch("/api/documents/" + id, { method: "DELETE" });
		if (res.ok) { toast("Deleted \\u2014 poof"); setTimeout(function () { location.reload(); }, 600); }
		else toast("Delete failed");
	});
});`;

// The versions modal: history list, "View" (pinned read-only page), "Restore"
// (rollback) and, in the header, the viewer's primary upload affordance. Built
// with el()/textContent only — no user data ever reaches innerHTML.
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
	// Dropping onto the viewer barely works over a sandboxed iframe (see
	// UPLOAD_JS), so this button is how a new version usually gets uploaded.
	if (fileInput) {
		const up = el("span", "create-btn", "Upload new version");
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
const sc = document.getElementById("share-current");
if (sc) sc.addEventListener("click", function () { openModal(sc.dataset.id, sc.dataset.title); });
const vb = document.getElementById("ver-btn");
if (vb) vb.addEventListener("click", function () { openVersions(vb.dataset.id); });
const vr = document.getElementById("ver-restore");
if (vr) vr.addEventListener("click", function () { restoreVersion(vr.dataset.id, Number(vr.dataset.version)); });`;

// Per-page bundles, concatenated once at module load rather than per request.
const LIBRARY_SCRIPT = CORE_JS + UPLOAD_JS + LIBRARY_JS;
const VIEWER_SCRIPT = CORE_JS + UPLOAD_JS + VERSIONS_JS + VIEWER_JS;

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
// iframe. The sandbox attribute is security-load-bearing (SPEC §6.1) and lives
// here once — never add `allow-same-origin`.
const ViewerShell: FC<PropsWithChildren<{ src: string; banner?: Child }>> = ({ src, banner, children }) => (
	<div class="viewer">
		<div class="topbar">{children}</div>
		{banner}
		<iframe class="frame" sandbox="allow-scripts allow-popups" src={src} />
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
 * Mirror of the client-side `fmtRemaining` in CORE_JS — keep the two in sync.
 */
function formatRemaining(secondsUntil: number): string {
	if (secondsUntil >= 172800) return `${Math.floor(secondsUntil / 86400)}d`;
	if (secondsUntil >= 3600) return `${Math.floor(secondsUntil / 3600)}h`;
	return `${Math.max(0, Math.floor(secondsUntil / 60))}m`;
}

/** GET / — library list, drag/drop/paste upload, per-row menu + share modal. */
export async function libraryPage(c: Ctx) {
	const now = nowSeconds();
	const docs = await listDocumentsWithShares(c.env.DB, now);
	return c.html(
		<Layout title="poof">
			<div class="wrap">
				<div class="lib">
					<div class="brand-row">
						<span class="brand">
							poof<span class="dot">.</span>
						</span>
						<span class="spacer" />
					</div>
					<div class="rows">
						{docs.map((d) => {
							const shared = d.active_share_count > 0 && d.next_share_expires_at !== null;
							const hasTtl = !shared && d.expires_at !== null;
							return (
								<div class="row" data-id={d.id} data-title={d.title}>
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
									<span class="menu-btn" data-menu>
										···
									</span>
									<div class="menu" data-menu-pop style="display:none">
										<div class="menu-item" data-share>
											Share…
										</div>
										<div class="menu-item del" data-delete>
											Delete
										</div>
									</div>
								</div>
							);
						})}
						<div class="line" />
					</div>
					<div class="hint" id="hint">
						Drop a file anywhere, paste with ⌘V — or click here
					</div>
				</div>
			</div>

			<div class="drop" id="drop" style="display:none" data-endpoint="/api/documents" data-with-title="1">
				<div style="text-align:center">
					<div class="drop-icon">↓</div>
					<div class="drop-title">Drop it — poof</div>
					<div class="drop-sub">.md / .html · up to 10 MB · title from filename</div>
				</div>
			</div>

			<div id="modal-root" />
			<input type="file" id="file" accept=".md,.markdown,.html,.htm" style="display:none" />
			<script dangerouslySetInnerHTML={{ __html: LIBRARY_SCRIPT }} />
		</Layout>,
	);
}

/**
 * GET /d/:id (+ optional `?v=N`) — private owner viewer; mints a short-lived o_
 * token (SPEC §6.2), pinned to the version when one is asked for.
 */
export async function ownerViewerPage(c: Ctx<"/d/:id">) {
	const id = c.req.param("id");
	const now = nowSeconds();

	// This is a page, not the API: a malformed `?v=` is not a 400, it is simply
	// not a page. Unknown versions fold into the same uniform 404 downstream.
	const rawVersion = c.req.query("v");
	if (rawVersion !== undefined && !/^[1-9][0-9]*$/.test(rawVersion)) return uniform404(c);
	const asked = rawVersion === undefined ? null : Number(rawVersion);

	const doc =
		asked === null
			? await getLiveDocument(c.env.DB, id, now)
			: await getLiveDocumentAtVersion(c.env.DB, id, asked, now);
	if (!doc) return uniform404(c);
	// `?v=` naming the live version is the normal page — never render the current
	// content as a read-only dead end.
	if (asked !== null && asked !== doc.current_version) return pinnedViewerPage(c, doc);

	// Independent of each other once the document is known — run concurrently.
	const [shares, oToken] = await Promise.all([
		listShares(c.env.DB, id, now),
		mintOwnerToken(id, c.env.OWNER_TOKEN_SECRET),
	]);
	let chip: string | null = null;
	if (shares.length) {
		const soonest = Math.min(...shares.map((s) => s.expires_at));
		chip = `shared · ${formatRemaining(soonest - now)} left`;
	}
	applyHeaders(c, VIEWER_HEADERS);
	return c.html(
		<Layout title={doc.title}>
			<ViewerShell src={`/raw/${oToken}`}>
				<a href="/" class="back">
					←
				</a>
				<span class="tb-brand">poof</span>
				<span class="tb-title">{doc.title}</span>
				<span class="spacer" />
				{chip ? <span class="tb-chip">{chip}</span> : null}
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
					<div class="drop-title">Drop it — new version</div>
					<div class="drop-sub">.md / .html · up to 10 MB · replaces the live content</div>
				</div>
			</div>
			<div id="modal-root" />
			<input type="file" id="file" accept=".md,.markdown,.html,.htm" style="display:none" />
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
	const [versions, oToken] = await Promise.all([
		listVersions(c.env.DB, doc.id),
		mintOwnerToken(doc.id, c.env.OWNER_TOKEN_SECRET, 600, doc.version),
	]);
	applyHeaders(c, VIEWER_HEADERS);
	return c.html(
		<Layout title={doc.title}>
			<ViewerShell
				src={`/raw/${oToken}`}
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
				<span class="tb-title">{doc.title}</span>
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

/** GET /v/:token — public shared viewer; validates the share (SPEC §11.4). */
export async function publicViewerPage(c: Ctx<"/v/:token">) {
	const token = c.req.param("token");
	const now = nowSeconds();
	const share = await getLiveShare(c.env.DB, token, now);
	if (!share) return uniform404(c);
	const doc = await getLiveDocument(c.env.DB, share.document_id, now);
	if (!doc) return uniform404(c);

	applyHeaders(c, VIEWER_HEADERS);
	return c.html(
		<Layout title={doc.title}>
			<ViewerShell src={`/raw/${token}`}>
				<span class="tb-brand">poof</span>
				<span class="tb-title">{doc.title}</span>
				<span class="spacer" />
				<span class="tb-chip">expires in {formatRemaining(share.expires_at - now)}</span>
			</ViewerShell>
		</Layout>,
	);
}
