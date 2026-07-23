import type { Context } from "hono";
import type { FC, PropsWithChildren } from "hono/jsx";

import { getLiveDocument, getLiveShare, listDocumentsWithShares, listShares } from "../lib/db";
import { applyHeaders, uniform404, VIEWER_HEADERS } from "../lib/http";
import { nowSeconds } from "../lib/time";
import { mintOwnerToken } from "../lib/tokens";

type Ctx<P extends string = string> = Context<{ Bindings: Env }, P>;

const ACCENT = "oklch(0.68 0.17 52)";
const ACCENT_HOVER = "oklch(0.62 0.17 52)";

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
.share-btn { background: ${ACCENT}; color: #fff; font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 7px; cursor: pointer; border: 0; font-family: inherit; }
.share-btn:hover { background: ${ACCENT_HOVER}; }
.frame { flex: 1; border: 0; width: 100%; }

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

const LIBRARY_JS = `
const dropEl = document.getElementById("drop");
const fileInput = document.getElementById("file");
let dragDepth = 0;
async function uploadFile(file) {
	const name = file.name || "pasted.md";
	const kind = /\\.html?$/i.test(name) ? "html" : "md";
	const fd = new FormData();
	fd.set("file", file, name);
	fd.set("kind", kind);
	fd.set("title", name);
	const res = await fetch("/api/documents", { method: "POST", body: fd });
	if (res.ok) { toast("Uploaded \\u2014 " + name); setTimeout(function () { location.reload(); }, 600); }
	else toast(await res.text());
}
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
document.getElementById("hint").addEventListener("click", function () { fileInput.click(); });
fileInput.addEventListener("change", function () { const f = fileInput.files[0]; if (f) uploadFile(f); fileInput.value = ""; });
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

const VIEWER_JS = `
const sc = document.getElementById("share-current");
if (sc) sc.addEventListener("click", function () { openModal(sc.dataset.id, sc.dataset.title); });`;

// Per-page bundles, concatenated once at module load rather than per request.
const LIBRARY_SCRIPT = CORE_JS + LIBRARY_JS;
const VIEWER_SCRIPT = CORE_JS + VIEWER_JS;

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<title>{title}</title>
			<style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
		</head>
		<body>{children}</body>
	</html>
);

// Shared viewer scaffold: topbar (contents vary per page) above the sandboxed
// iframe. The sandbox attribute is security-load-bearing (SPEC §6.1) and lives
// here once — never add `allow-same-origin`.
const ViewerShell: FC<PropsWithChildren<{ src: string }>> = ({ src, children }) => (
	<div class="viewer">
		<div class="topbar">{children}</div>
		<iframe class="frame" sandbox="allow-scripts allow-popups" src={src} />
	</div>
);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** created_at (epoch seconds) → "Jul 21, 14:02" (en-US short month, 24h, UTC). */
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
										<div class="row-meta">{fmtCreated(d.created_at)}</div>
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

			<div class="drop" id="drop" style="display:none">
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

/** GET /d/:id — private owner viewer; mints a short-lived o_ token (SPEC §6.2). */
export async function ownerViewerPage(c: Ctx<"/d/:id">) {
	const id = c.req.param("id");
	const now = nowSeconds();
	const doc = await getLiveDocument(c.env.DB, id, now);
	if (!doc) return uniform404(c);

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
				<button type="button" id="share-current" class="share-btn" data-id={id} data-title={doc.title}>
					Share
				</button>
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
