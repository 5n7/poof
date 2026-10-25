import { MAX_BYTES, MAX_FILES } from "../lib/files";
import { ENDS_HEADER } from "../lib/http";
import { iconSvg, type IconName } from "./icons";
import { TITLE_EDITOR_JS } from "./title-editor";

// Browser scripts, served as two cached bundles by src/routes/assets.ts: one for
// the owner's pages and one for a share recipient's page. Each fragment below is
// plain ES2020 that shares one function scope inside its bundle, and every part
// that touches the page first checks that its elements exist.
//
// User data reaches the DOM through textContent and attributes only. The one
// innerHTML sink takes the static icon markup below.

const ICONS: IconName[] = [
  "close",
  "download",
  "fileMinus",
  "folder",
  "history",
  "link",
  "pencil",
  "trash",
  "upload",
];
const ICON_JSON = JSON.stringify(Object.fromEntries(ICONS.map((name) => [name, iconSvg(name)])));

const MAX_MB = Math.floor(MAX_BYTES / (1024 * 1024));

/** Time helpers both bundles need. Exported for the parity test. */
export const CLIENT_TIME = String.raw`
function nowSec() { return Math.floor(Date.now() / 1000); }
// Mirror formatRemaining in src/ui/format.ts; test/ui-client.spec.ts checks both.
function fmtLeft(sec) {
	if (sec >= 172800) return Math.floor(sec / 86400) + "d";
	if (sec >= 3600) return Math.floor(sec / 3600) + "h";
	return Math.max(0, Math.floor(sec / 60)) + "m";
}
// Mirror documentState in src/ui/format.ts; test/ui-client.spec.ts checks both.
function stateOf(shareExpires, docExpires, now) {
	if (docExpires && (!shareExpires || docExpires <= shareExpires)) return { text: "Expires in " + fmtLeft(docExpires - now), live: true, fade: fadeOf(docExpires, now) };
	if (shareExpires) return { text: "Shared · " + fmtLeft(shareExpires - now), live: true, fade: fadeOf(shareExpires, now) };
	return { text: "Only you", live: false, fade: 0 };
}
function fadeOf(end, now) { return Math.round(Math.max(0, Math.min(1, 1 - (end - now) / 86400)) * 100) / 100; }
const calm = matchMedia("(prefers-reduced-motion: reduce)");
// The client clock can run ahead of the server's, so what looks ended here is
// the server's call. Each key asks at most once a minute, one request at a time.
const nextAsk = new Map();
async function askServer(key, request) {
	if ((nextAsk.get(key) || 0) > Date.now()) return null;
	const next = Date.now() + 60000;
	nextAsk.set(key, Infinity);
	try { return await request(); } finally { nextAsk.set(key, next); }
}
`;

/** Owner-only helpers: DOM, toast, puff, popovers, state pills. */
export const CLIENT_OWNER_CORE = String.raw`
const ICONS = ${ICON_JSON};
function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
}
function iconButton(name, cls, label) {
	const b = el("button", cls);
	b.type = "button";
	b.innerHTML = ICONS[name];
	b.setAttribute("aria-label", label);
	return b;
}
const CREATED_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function fmtCreated(sec) {
	const p = {};
	CREATED_FMT.formatToParts(new Date(sec * 1000)).forEach(function (x) { p[x.type] = x.value; });
	return p.month + " " + p.day + ", " + p.hour + ":" + p.minute;
}
const hasPopover = typeof HTMLElement.prototype.showPopover === "function";

// One live region per page (#toast, a manual popover so it stacks above an open
// panel). Text is set after showing so screen readers announce it.
let toastT;
function toast(msg, opts) {
	const t = document.getElementById("toast");
	clearTimeout(toastT);
	t.textContent = "";
	if (hasPopover) { if (t.matches(":popover-open")) t.hidePopover(); t.showPopover(); }
	// Fill the region a beat after it is rendered, or it is never announced.
	setTimeout(function () {
		t.textContent = msg;
		if (opts && opts.extra) t.append(opts.extra);
	}, 60);
	if (opts && opts.sticky) return;
	toastT = setTimeout(function () {
		if (hasPopover && t.matches(":popover-open")) t.hidePopover();
		t.textContent = "";
	}, 2600);
}
function copyToClipboard(text) {
	if (!navigator.clipboard) return Promise.resolve(false);
	return Promise.race([
		navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }),
		new Promise(function (r) { setTimeout(function () { r(false); }, 1000); }),
	]);
}
// The signature exit: blur out like smoke, shed a few motes, close the gap.
function puff(node) {
	return new Promise(function (resolve) {
		if (calm.matches || !node.isConnected) { node.remove(); resolve(); return; }
		const box = node.getBoundingClientRect();
		// Inside an open popover the motes must join it in the top layer.
		const host = node.closest(".pop") || document.body;
		for (let i = 0; i < 7; i++) {
			const m = el("span", "mote");
			const a = (Math.PI * 2 * i) / 7 + Math.random() * 0.6;
			const d = 26 + Math.random() * 30;
			m.style.left = box.right - 40 + Math.random() * 30 + "px";
			m.style.top = box.top + box.height / 2 + "px";
			m.style.setProperty("--s", 3 + Math.random() * 5 + "px");
			m.style.setProperty("--dx", Math.cos(a) * d + "px");
			m.style.setProperty("--dy", Math.sin(a) * d - 18 + "px");
			host.append(m);
			setTimeout(function () { m.remove(); }, 900);
		}
		node.classList.add("puff");
		setTimeout(function () {
			const h = node.offsetHeight;
			const close = node.animate([{ height: h + "px", marginBottom: "0px" }, { height: "0px", marginBottom: "-6px", paddingTop: "0px", paddingBottom: "0px" }], { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" });
			close.onfinish = function () { node.remove(); resolve(); };
		}, 460);
	});
}

// Popovers: one menu or panel at a time, placed beside its trigger and kept
// right after it in the DOM so Tab order follows. The browser's light dismiss
// and Esc report back through "toggle", which arrives a task late; by then the
// next popover may already be open, so closePop() acts only on the current one.
let open = null;
let lastClose = { anchor: null, t: 0 };
const narrow = matchMedia("(max-width: 640px)");
function place(pop, anchor) {
	if (pop.classList.contains("panel") && narrow.matches) { pop.style.left = ""; pop.style.top = ""; return; }
	const a = anchor.getBoundingClientRect();
	const w = pop.offsetWidth, h = pop.offsetHeight, pad = 12;
	pop.style.left = Math.min(window.innerWidth - w - pad, Math.max(pad, a.right - w)) + "px";
	let top = a.bottom + 8;
	if (top + h > window.innerHeight - pad) top = Math.max(pad, a.top - h - 8);
	pop.style.top = top + "px";
}
// dismissed: the browser closed it (outside click or Esc), not our own code.
function closePop(dismissed) {
	const s = open;
	if (!s) return;
	open = null;
	const hadFocus = s.pop.contains(document.activeElement);
	if (hasPopover && s.pop.matches(":popover-open")) s.pop.hidePopover();
	s.pop.remove();
	s.anchor.setAttribute("aria-expanded", "false");
	// A click on the trigger light-dismisses before its own click handler runs;
	// remember that so the click does not reopen what it just closed.
	if (dismissed) lastClose = { anchor: s.anchor, t: performance.now() };
	if (hadFocus && s.anchor.isConnected) s.anchor.focus({ preventScroll: true });
}
// Returns false when the click was the trigger closing its own popover.
function openPop(pop, anchor) {
	if (open && open.anchor === anchor) { closePop(); return false; }
	if (lastClose.anchor === anchor && performance.now() - lastClose.t < 300) return false;
	closePop();
	open = { pop: pop, anchor: anchor };
	anchor.after(pop);
	if (hasPopover) {
		pop.popover = "auto";
		pop.addEventListener("toggle", function (e) { if (e.newState === "closed" && open && open.pop === pop) closePop(true); });
		pop.showPopover();
	}
	anchor.setAttribute("aria-expanded", "true");
	place(pop, anchor);
	const first = pop.querySelector("button:not([disabled]), a[href]");
	if (first) first.focus({ preventScroll: true });
	return true;
}
if (!hasPopover) {
	document.addEventListener("pointerdown", function (e) {
		if (open && !open.pop.contains(e.target) && !open.anchor.contains(e.target)) closePop(true);
	});
	document.addEventListener("keydown", function (e) { if (e.key === "Escape") closePop(true); });
}
["scroll", "resize"].forEach(function (type) {
	window.addEventListener(type, function () { if (open) place(open.pop, open.anchor); }, { passive: true, capture: true });
});
// items: { label, icon, run, href, download, danger, confirm, confirmLabel } or "sep".
function menu(anchor, items) {
	const pop = el("div", "pop");
	pop.setAttribute("role", "menu");
	items.forEach(function (item) {
		if (item === "sep") { const sep = el("div", "menu-sep"); sep.setAttribute("role", "separator"); pop.append(sep); return; }
		const b = el(item.href ? "a" : "button", "menu-item" + (item.danger ? " danger" : ""));
		if (item.href) { b.href = item.href; if (item.download) b.setAttribute("download", ""); }
		else b.type = "button";
		b.setAttribute("role", "menuitem");
		if (item.icon) b.innerHTML = ICONS[item.icon];
		b.append(el("span", "", item.label));
		b.addEventListener("click", function () {
			if (item.href) { closePop(); return; }
			if (item.confirm) { confirmIn(pop, anchor, item); return; }
			closePop();
			item.run();
		});
		pop.append(b);
	});
	pop.addEventListener("keydown", function (e) {
		// confirmIn() reuses this element; its buttons need ordinary Tab.
		if (pop.getAttribute("role") !== "menu") return;
		if (e.key === "Tab") { closePop(); return; }
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		const all = Array.from(pop.querySelectorAll(".menu-item"));
		if (!all.length) return;
		e.preventDefault();
		const i = all.indexOf(document.activeElement);
		all[(i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length].focus();
	});
	openPop(pop, anchor);
}
function confirmIn(pop, anchor, item) {
	pop.textContent = "";
	pop.setAttribute("role", "alertdialog");
	const box = el("div", "confirm");
	const text = el("p", "", item.confirm);
	text.id = "confirm-text";
	pop.setAttribute("aria-labelledby", text.id);
	const row = el("div");
	const cancel = el("button", "btn ghost small", "Cancel");
	cancel.type = "button";
	cancel.addEventListener("click", function () { closePop(); });
	const go = el("button", "btn danger small", item.confirmLabel || item.label);
	go.type = "button";
	go.addEventListener("click", function () { closePop(); item.run(); });
	row.append(cancel, go);
	box.append(text, row);
	pop.append(box);
	place(pop, anchor);
	cancel.focus();
}
let panelCount = 0;
function panel(heading, sub) {
	const pop = el("section", "pop panel");
	pop.setAttribute("role", "dialog");
	const head = el("div", "panel-head");
	const titles = el("div");
	const h = el("h2", "", heading);
	h.id = "panel-title-" + ++panelCount;
	pop.setAttribute("aria-labelledby", h.id);
	titles.append(h);
	if (sub) titles.append(el("p", "", sub));
	const x = iconButton("close", "btn ghost icon", "Close");
	x.addEventListener("click", function () { closePop(); });
	head.append(titles, x);
	pop.append(head);
	return pop;
}
function isOpen(pop) { return !!open && open.pop === pop; }

// State pills: [data-state-pill] carries the soonest live share expiry and the
// document's own expiry; the label and the row's fade both derive from them.
function paintState(pill) {
	const s = stateOf(Number(pill.dataset.shareExpires) || 0, Number(pill.dataset.docExpires) || 0, nowSec());
	pill.textContent = s.text;
	pill.classList.toggle("live", s.live);
	const row = pill.closest("[data-fade]");
	if (row) row.style.setProperty("--fade", String(s.fade));
}
function setShares(docId, shares) {
	const soonest = shares.reduce(function (m, s) { return m && m < s.expires_at ? m : s.expires_at; }, 0);
	document.querySelectorAll('[data-state-pill][data-id="' + CSS.escape(docId) + '"]').forEach(function (pill) {
		pill.dataset.shareExpires = soonest ? String(soonest) : "";
		paintState(pill);
	});
}
async function refreshShares(docId) {
	try {
		const res = await fetch("/api/documents/" + docId + "/shares");
		if (!res.ok) return null;
		const shares = (await res.json()).shares || [];
		setShares(docId, shares);
		return shares;
	} catch (e) { return null; }
}
function confirmGone(docId) {
	return askServer("document " + docId, async function () {
		try { return (await fetch("/api/documents/" + docId)).status === 404; } catch (e) { return false; }
	});
}
`;

// The share panel: choose a lifetime, create a link, copy, extend, or revoke live links.
const SHARE = String.raw`
const TTL = [["1h", "1 hour"], ["1d", "1 day"], ["1w", "1 week"]];
function ttlName(ttl) { return TTL.find(function (o) { return o[0] === ttl; })[1]; }
function linkRow(s, fresh, ctx) {
	const full = location.origin + "/v/" + s.token;
	const row = el("div", "link" + (fresh ? " fresh" : ""));
	row.setAttribute("role", "listitem");
	row.dataset.token = s.token;
	const text = el("div");
	text.append(el("span", "link-url", location.host + "/v/" + s.token));
	const left = el("span", "link-left");
	text.append(left);
	row.setExpires = function (end) {
		row.dataset.shareExpires = String(end);
		left.dataset.countdown = String(end);
		left.textContent = fmtLeft(end - nowSec()) + " left";
	};
	row.setExpires(s.expires_at);
	const copy = el("button", "btn ghost small", "Copy");
	copy.type = "button";
	copy.addEventListener("click", function () {
		copyToClipboard(full).then(function (ok) {
			if (!ok) { toast("Could not copy. Select the link and copy it instead."); return; }
			copy.textContent = "Copied";
			setTimeout(function () { copy.textContent = "Copy"; }, 1600);
		});
	});
	let leaving = false;
	row.gone = async function (message) {
		if (leaving) return;
		leaving = true;
		const focus = document.activeElement;
		if (!focus || focus === document.body || row.contains(focus)) {
			const stay = Array.from(row.parentElement.children).filter(function (r) { return r === row || !r.classList.contains("puff"); });
			const i = stay.indexOf(row);
			const next = stay[i + 1] || stay[i - 1];
			(next ? next.querySelector("button") : ctx.fallbackFocus).focus();
		}
		await puff(row);
		if (message) toast(message);
		ctx.sync();
	};
	const extend = el("button", "btn ghost small", "Extend");
	extend.type = "button";
	extend.addEventListener("click", async function () {
		const ttl = ctx.ttl();
		extend.disabled = true;
		try {
			const r = await fetch("/api/shares/" + s.token + "/extend", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ttl: ttl }),
			});
			if (r.status === 404) { await row.gone("This link already ended."); return; }
			if (!r.ok) throw new Error();
			const extended = await r.json();
			row.setExpires(extended.expires_at);
			toast(extended.renewed
				? "Link now lasts " + ttlName(ttl) + "."
				: "This link already lasts longer than " + ttlName(ttl) + ".");
			ctx.sync();
		} catch (e) { toast("Could not extend the link. Try again."); }
		finally { extend.disabled = false; }
	});
	const revoke = el("button", "btn ghost small", "Revoke");
	revoke.type = "button";
	revoke.addEventListener("click", async function () {
		revoke.disabled = true;
		try {
			const r = await fetch("/api/shares/" + s.token, { method: "DELETE" });
			if (!r.ok) throw new Error();
		} catch (e) { revoke.disabled = false; toast("Could not revoke the link. Try again."); return; }
		await row.gone("Link revoked. It now shows a 404.");
	});
	row.append(text, copy, extend, revoke);
	return row;
}
function radioGroup(label, options, value, onChange) {
	const group = el("div", "choice");
	group.setAttribute("role", "radiogroup");
	group.setAttribute("aria-label", label);
	const buttons = options.map(function (o) {
		const b = el("button", "", o[1]);
		b.type = "button";
		b.setAttribute("role", "radio");
		b.addEventListener("click", function () { select(o[0], false); });
		group.append(b);
		return b;
	});
	function select(v, focus) {
		value = v;
		buttons.forEach(function (b, i) {
			const on = options[i][0] === v;
			b.setAttribute("aria-checked", String(on));
			b.tabIndex = on ? 0 : -1;
			if (on && focus) b.focus();
		});
		onChange(v);
	}
	group.addEventListener("keydown", function (e) {
		const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
		if (!step) return;
		e.preventDefault();
		const i = options.findIndex(function (o) { return o[0] === value; });
		select(options[(i + step + options.length) % options.length][0], true);
	});
	select(value, false);
	return group;
}
let sharePanel = null;
async function openShare(anchor, docId, title) {
	const pop = panel("Share", title);
	let ttl = "1d";
	pop.append(el("p", "field-label", "Link lasts"));
	const choice = radioGroup("Link lasts", TTL, ttl, function (v) { ttl = v; });
	const create = el("button", "btn primary wide");
	create.type = "button";
	create.innerHTML = ICONS.link;
	create.append(document.createTextNode("Create link"));
	const rows = el("div", "rows");
	rows.setAttribute("role", "list");
	rows.setAttribute("aria-label", "Live links");
	const note = el("p", "panel-note", "Loading links…");
	function sync() {
		const shares = Array.from(rows.children).map(function (r) { return { expires_at: Number(r.dataset.shareExpires) }; });
		note.textContent = shares.length
			? "Anyone with a link sees the current version until the link runs out."
			: "No live links. Only you can open this document.";
		setShares(docId, shares);
	}
	const ctx = { fallbackFocus: create, sync: sync, ttl: function () { return ttl; } };
	sharePanel = {
		docId: docId,
		settle: function (shares) {
			if (!isOpen(pop)) return;
			const ends = new Map(shares.map(function (s) { return [s.token, s.expires_at]; }));
			const now = nowSec();
			Array.from(rows.children).forEach(function (row) {
				if (Number(row.dataset.shareExpires) > now) return;
				if (ends.has(row.dataset.token)) row.setExpires(ends.get(row.dataset.token));
				else row.gone();
			});
		},
		stale: function (now) {
			return isOpen(pop) && Array.from(rows.children).some(function (row) {
				return Number(row.dataset.shareExpires) <= now && !row.classList.contains("puff");
			});
		},
	};
	create.addEventListener("click", async function () {
		create.disabled = true;
		try {
			const res = await fetch("/api/documents/" + docId + "/shares", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ttl: ttl }),
			});
			if (!res.ok) throw new Error();
			const s = await res.json();
			// The link is live now; show it before the clipboard can stall.
			rows.prepend(linkRow(s, true, ctx));
			sync();
			const ok = await copyToClipboard(location.origin + "/v/" + s.token);
			toast(ok ? "Link created and copied" : "Link created. Copy it from the list.");
		} catch (e) {
			toast("Could not create a link. Try again.");
		} finally { create.disabled = false; }
	});
	pop.append(choice, create, rows, note);
	if (!openPop(pop, anchor)) return;
	create.disabled = true;
	try {
		const res = await fetch("/api/documents/" + docId + "/shares");
		if (!res.ok) throw new Error();
		((await res.json()).shares || []).forEach(function (s) { rows.append(linkRow(s, false, ctx)); });
		create.disabled = false;
		sync();
	} catch (e) {
		// Never claim "no live links" when the list did not load.
		note.textContent = "Could not load the live links. Close this panel and try again.";
		note.dataset.error = "";
	}
	if (isOpen(pop)) place(pop, anchor);
}
`;

// History: every version of the document. View opens a read-only pin; Restore
// moves the current pointer, which every live share follows.
const HISTORY = String.raw`
async function restoreVersion(docId, n) {
	try {
		const res = await fetch("/api/documents/" + docId + "/versions/" + n + "/rollback", { method: "POST" });
		if (!res.ok) throw new Error();
	} catch (e) { toast("Could not restore that version. Try again."); return false; }
	toast("Restored v" + n);
	setTimeout(function () { location.href = "/d/" + docId; }, 500);
	return true;
}
async function openHistory(anchor, docId) {
	const pop = panel("History", "Share links always show the current version.");
	const rows = el("div", "rows");
	rows.setAttribute("role", "list");
	const note = el("p", "panel-note", "Loading versions…");
	pop.append(rows, note);
	if (!openPop(pop, anchor)) return;
	let data;
	try {
		const res = await fetch("/api/documents/" + docId + "/versions");
		if (!res.ok) throw new Error();
		data = await res.json();
	} catch (e) {
		note.textContent = "Could not load the history. Close this panel and try again.";
		note.dataset.error = "";
		return;
	}
	note.remove();
	(data.versions || []).forEach(function (v) {
		const row = el("div", "ver");
		row.setAttribute("role", "listitem");
		const text = el("div");
		text.append(el("b", "", "v" + v.version));
		text.append(el("span", "", fmtCreated(v.created_at) + " · " + v.kind));
		row.append(text);
		if (v.version === data.current_version) {
			row.append(el("span", "pill live", "Current"));
		} else {
			const view = el("a", "btn ghost small", "View");
			view.href = "/d/" + docId + "?v=" + v.version;
			const restore = el("button", "btn small", "Restore");
			restore.type = "button";
			restore.addEventListener("click", async function () {
				restore.disabled = true;
				if (!(await restoreVersion(docId, v.version))) restore.disabled = false;
			});
			row.append(view, restore);
		}
		rows.append(row);
	});
	if (isOpen(pop)) place(pop, anchor);
}
`;

// Drag and drop, paste, and the file pickers, shared by the library and the
// owner viewer. `#drop` names the target: `data-endpoint` receives the POST and
// `data-with-title` asks for a `title` field (the library names a new document
// after its first file; a new version keeps the document's title). No `#drop`
// means a read-only page, so nothing is wired.
//
// Send `title` only for a dropped or selected file, which has a user-chosen
// name. Pasted text uses the synthetic name `pasted.md`, so omit the field and
// let the server choose a title (lib/title.ts).
//
// The document iframe is sandboxed to an opaque origin and its drag events never
// reach this page, so drops register over the bar, the file chips, and the
// margins. ⌘V works whenever focus is outside the iframe, and "Add or update
// files" in the More menu always works.
const UPLOAD = String.raw`
const dropEl = document.getElementById("drop");
const fileInput = document.getElementById("file");
const folderInput = document.getElementById("folder");
let dragDepth = 0;
let uploading = false;
function countFile(file, budget) {
	budget.count++; budget.bytes += file.size;
	if (budget.count > ${MAX_FILES}) throw new Error("Choose at most ${MAX_FILES} files per upload.");
	if (budget.bytes > ${MAX_BYTES}) throw new Error("Keep each upload under ${MAX_MB} MB.");
}
async function uploadFiles(files, named) {
	if (!files.length || uploading) return;
	uploading = true;
	const controls = document.querySelectorAll("[data-upload], [data-folder]");
	controls.forEach(function (c) { c.disabled = true; });
	const elapsed = el("span", "", "");
	elapsed.setAttribute("aria-hidden", "true");
	toast("Uploading " + files.length + (files.length === 1 ? " file…" : " files…"), { sticky: true, extra: elapsed });
	const started = performance.now();
	const timer = setInterval(function () { elapsed.textContent = " " + Math.round((performance.now() - started) / 1000) + "s"; }, 1000);
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
		if (!res.ok) throw new Error((await res.text()) || "Upload failed. Try again.");
		const doc = await res.json();
		clearInterval(timer);
		toast("Uploaded " + files.length + (files.length === 1 ? " file" : " files"));
		const url = new URL(location.href);
		url.searchParams.delete("v");
		if (dropEl.dataset.withTitle && doc.id) { url.pathname = "/d/" + doc.id; url.search = ""; }
		location.href = url.href;
	} catch (error) {
		clearInterval(timer);
		let msg = error.message || "Upload failed. Try again.";
		try { msg = JSON.parse(msg).error || msg; } catch (e) {}
		toast(msg);
	} finally {
		uploading = false;
		controls.forEach(function (c) { c.disabled = false; });
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
function hasFiles(e) { return Array.from(e.dataTransfer ? e.dataTransfer.types : []).includes("Files"); }
if (dropEl && fileInput) {
	window.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropEl.hidden = false; });
	window.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl.hidden = true; });
	window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
	window.addEventListener("drop", async function (e) {
		if (!hasFiles(e)) return;
		e.preventDefault(); dragDepth = 0; dropEl.hidden = true;
		try {
			const items = Array.from(e.dataTransfer.items || []);
			const entries = items.map(function (item) { return item.webkitGetAsEntry && item.webkitGetAsEntry(); }).filter(Boolean);
			let files = [];
			const budget = { count: 0, bytes: 0 };
			for (const entry of entries) files = files.concat(await readEntry(entry, "", budget));
			if (!entries.length) files = Array.from(e.dataTransfer.files || []);
			if (entries.length === 1 && entries[0].isDirectory) files = files.map(function (entry) { return { file: entry.file, path: entry.path.slice(entries[0].name.length + 1) }; });
			await uploadFiles(files, true);
		} catch (error) { toast(error.message || "Could not read the dropped files. Choose them instead."); }
	});
	window.addEventListener("paste", function (e) {
		if (e.target.closest("input, textarea, [contenteditable]")) return;
		const files = Array.from(e.clipboardData.files || []);
		if (files.length) { e.preventDefault(); uploadFiles(files, true); return; }
		const text = e.clipboardData.getData("text");
		if (text) { e.preventDefault(); uploadFiles([new File([text], "pasted.md", { type: "text/markdown" })], false); }
	});
	document.querySelectorAll("[data-upload]").forEach(function (c) { c.addEventListener("click", function () { fileInput.click(); }); });
	document.querySelectorAll("[data-folder]").forEach(function (c) { c.addEventListener("click", function () { folderInput.click(); }); });
	fileInput.addEventListener("change", function () { uploadFiles(Array.from(fileInput.files), true); fileInput.value = ""; });
	if (folderInput) folderInput.addEventListener("change", function () { uploadFiles(Array.from(folderInput.files).map(function (file) { return { file: file, path: file.webkitRelativePath.split("/").slice(1).join("/") }; }), true); folderInput.value = ""; });
}
`;

// Live time: countdowns tick, state pills recompute, and anything whose time
// runs out leaves the page the way it leaves the server.
const CLOCK = String.raw`
async function checkShares(docId) {
	const shares = await askServer("shares " + docId, function () { return refreshShares(docId); });
	if (shares && sharePanel && sharePanel.docId === docId) sharePanel.settle(shares);
}
function tick() {
	const now = nowSec();
	const ask = new Set();
	document.querySelectorAll("[data-state-pill]").forEach(function (pill) {
		const docEnd = Number(pill.dataset.docExpires) || 0;
		const shareEnd = Number(pill.dataset.shareExpires) || 0;
		if (docEnd && docEnd <= now) {
			confirmGone(pill.dataset.id).then(function (gone) {
				if (!gone) return;
				const row = pill.closest(".doc");
				if (row) { if (!row.classList.contains("puff")) puff(row).then(emptyCheck); }
				else location.reload();
			});
		} else if (shareEnd && shareEnd <= now) {
			ask.add(pill.dataset.id);
		}
		paintState(pill);
	});
	if (sharePanel && sharePanel.stale(now)) ask.add(sharePanel.docId);
	ask.forEach(checkShares);
	document.querySelectorAll("[data-countdown]").forEach(function (label) {
		label.textContent = fmtLeft(Number(label.dataset.countdown) - now) + " left";
	});
}
function emptyCheck() { if (!document.querySelector(".doc")) location.reload(); }
setInterval(tick, 20000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(); });
`;

const LIBRARY = String.raw`
document.querySelectorAll("[data-created]").forEach(function (node) {
	node.textContent = fmtCreated(Number(node.dataset.created));
});
document.querySelectorAll(".doc").forEach(function (row) {
	const id = row.dataset.id;
	const more = row.querySelector("[data-menu]");
	const pill = row.querySelector("[data-state-pill]");
	pill.addEventListener("click", function () { openShare(pill, id, row.dataset.title); });
	more.addEventListener("click", function () {
		menu(more, [
			{ label: "Rename…", icon: "pencil", run: function () { openTitleEditor(row, more); } },
			{ label: "Share…", icon: "link", run: function () { openShare(more, id, row.dataset.title); } },
			"sep",
			{
				label: "Delete…", icon: "trash", danger: true, confirmLabel: "Delete",
				confirm: "Delete “" + row.dataset.title + "”? Every version and share link goes with it.",
				run: async function () {
					try {
						const res = await fetch("/api/documents/" + id, { method: "DELETE" });
						if (!res.ok) throw new Error();
					} catch (e) { toast("Could not delete. Try again."); return; }
					const next = row.nextElementSibling || row.previousElementSibling;
					(next ? next.querySelector(".doc-open") : document.querySelector("[data-upload]")).focus();
					await puff(row);
					toast("Deleted “" + row.dataset.title + "”");
					emptyCheck();
				},
			},
		]);
	});
});
`;

const VIEWER = String.raw`
const renameBtn = document.getElementById("rename-current");
if (renameBtn) renameBtn.addEventListener("click", function () { openTitleEditor(renameBtn, renameBtn); });
const shareBtn = document.getElementById("share-current");
[shareBtn, document.getElementById("share-state")].forEach(function (b) {
	if (b) b.addEventListener("click", function () { openShare(b, shareBtn.dataset.id, shareBtn.dataset.title); });
});
const verBtn = document.getElementById("ver-btn");
if (verBtn) verBtn.addEventListener("click", function () { openHistory(verBtn, verBtn.dataset.id); });
const restoreBtn = document.getElementById("ver-restore");
if (restoreBtn) restoreBtn.addEventListener("click", async function () {
	restoreBtn.disabled = true;
	if (!(await restoreVersion(restoreBtn.dataset.id, Number(restoreBtn.dataset.version)))) restoreBtn.disabled = false;
});
const moreBtn = document.getElementById("more-btn");
if (moreBtn) moreBtn.addEventListener("click", function () {
	const d = moreBtn.dataset;
	const items = [
		{ label: "Add or update files…", icon: "upload", run: function () { fileInput.click(); } },
		{ label: "Upload a folder…", icon: "folder", run: function () { folderInput.click(); } },
		{ label: "Download " + d.path, icon: "download", href: d.downloadUrl, download: true },
		{ label: "History…", icon: "history", run: function () { openHistory(moreBtn, d.id); } },
	];
	if (d.removable) items.push("sep", {
		label: "Remove " + d.path + "…", icon: "fileMinus", danger: true, confirmLabel: "Remove",
		confirm: "Remove “" + d.path + "” from this document? Earlier versions keep it.",
		run: async function () {
			try {
				const body = new FormData(); body.append("delete", d.path);
				const res = await fetch("/api/documents/" + d.id + "/versions", { method: "POST", body: body });
				if (!res.ok) throw new Error(await res.text());
				location.href = location.pathname;
			} catch (error) { toast("Could not remove the file. Try again."); }
		},
	});
	menu(moreBtn, items);
});
`;

// The document frame: keep the selected chip in view and follow file links that
// the sandboxed document posts back.
const FRAME = String.raw`
const frame = document.getElementById("document-frame");
if (frame) {
	const revealSelectedFile = function () {
		const selected = document.querySelector(".file[aria-current=page]");
		if (selected) selected.scrollIntoView({ block: "nearest", inline: "nearest" });
	};
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
`;

// Copy each guide command's single-line form, which pastes into any shell. On
// failure, select the visible command so it can be copied by hand.
const GUIDE = String.raw`
document.querySelectorAll(".cmd-copy").forEach(function (btn) {
	const block = btn.parentElement;
	const status = block.querySelector(".cmd-copy-status");
	let resetT;
	function announce(msg) {
		status.textContent = "";
		requestAnimationFrame(function () { status.textContent = msg; });
	}
	btn.addEventListener("click", function () {
		copyToClipboard(btn.dataset.copy).then(function (ok) {
			if (!ok) {
				const range = document.createRange();
				range.selectNodeContents(block.querySelector(".cmd-text"));
				const sel = window.getSelection();
				sel.removeAllRanges();
				sel.addRange(range);
				toast("Could not copy. The command is selected instead.");
				announce("Could not copy; command selected");
				return;
			}
			btn.classList.add("copied");
			announce("Copied");
			clearTimeout(resetT);
			resetT = setTimeout(function () { btn.classList.remove("copied"); status.textContent = ""; }, 1600);
		});
	});
});
`;

// A recipient's page: the link's countdown, and once the server confirms the
// link has ended, the document dissolves in place instead of waiting for the
// next reload to 404.
const PUBLIC = String.raw`
const expiry = document.querySelector("[data-share-expires]");
let publicTimer;
let ended = false;
function setEnd(end) {
	expiry.dataset.shareExpires = String(end);
	expiry.title = "This link stops working " + new Date(end * 1000).toLocaleString();
}
async function linkEnd() {
	try {
		const res = await fetch(location.pathname, { method: "HEAD", cache: "no-store" });
		if (res.status === 404) return "gone";
		if (res.ok) return Number(res.headers.get("${ENDS_HEADER}")) || null;
	} catch (e) {}
	return null;
}
async function publicTick() {
	if (!expiry || ended) return;
	if (Number(expiry.dataset.shareExpires) <= nowSec()) {
		const answer = await askServer("link", linkEnd);
		if (answer === "gone") { dissolve(); return; }
		if (typeof answer === "number") setEnd(answer);
	}
	expiry.textContent = "Gone in " + fmtLeft(Number(expiry.dataset.shareExpires) - nowSec());
}
function dissolve() {
	ended = true;
	clearInterval(publicTimer);
	expiry.textContent = "Expired";
	expiry.classList.remove("live");
	document.querySelector(".sheet").classList.add("vanishing");
	setTimeout(function () {
		if (frame) frame.remove();
		document.querySelectorAll(".files, [data-download]").forEach(function (n) { n.remove(); });
		const gone = document.getElementById("gone");
		gone.hidden = false;
		gone.querySelector("h1").focus();
	}, calm.matches ? 0 : 900);
}
if (expiry) {
	setEnd(Number(expiry.dataset.shareExpires));
	publicTimer = setInterval(publicTick, 15000);
	document.addEventListener("visibilitychange", function () { if (!document.hidden) publicTick(); });
}
`;

const bundle = (...parts: string[]) =>
  `"use strict";\n(function () {\n${parts.join("\n")}\n})();\n`;

/** Every owner page: library, viewers, and guide. */
export const OWNER_JS = bundle(
  CLIENT_TIME,
  CLIENT_OWNER_CORE,
  TITLE_EDITOR_JS,
  SHARE,
  HISTORY,
  UPLOAD,
  CLOCK,
  LIBRARY,
  VIEWER,
  FRAME,
  GUIDE,
);

/** A share recipient's page. Nothing here can reach the owner API. */
export const PUBLIC_JS = bundle(CLIENT_TIME, FRAME, PUBLIC);
