// Shared by the owner library and current document viewer.
export const TITLE_EDITOR_CSS = `
.title-editor { width: 440px; max-width: calc(100vw - 32px); max-height: calc(100dvh - 32px); overflow: auto; margin: auto; padding: 24px; border: 1px solid #e0e0e6; border-radius: 12px; color: #1a1a1e; background: #fff; box-shadow: 0 12px 40px rgba(20,20,40,.22); }
.title-editor::backdrop { background: rgba(24,24,32,.32); }
.title-editor h2 { margin: 0 0 20px; font-size: 17px; font-weight: 650; }
.title-editor label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 600; }
.title-input { display: block; width: 100%; padding: 10px 12px; border: 1px solid #c9c9d1; border-radius: 7px; color: inherit; background: #fff; font: inherit; font-size: 16px; caret-color: #b45309; }
.title-input:focus-visible { outline: 2px solid #b45309; outline-offset: 2px; }
.title-input[aria-invalid="true"] { border-color: #b1352e; }
.title-help, .title-status { margin: 10px 0 0; color: #62626b; font-size: 12px; line-height: 1.5; }
.title-status { min-height: 18px; overflow-wrap: anywhere; }
.title-status[data-error="true"] { color: #b1352e; }
.title-assist { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.title-count { color: #62626b; font-size: 12px; font-variant-numeric: tabular-nums; }
.title-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
.title-editor button { min-height: 40px; padding: 8px 14px; }
.title-editor button:disabled { cursor: default; }
.title-editor .share-btn { background: #b45309; }
.title-editor .share-btn:hover { background: #92400e; }
.title-editor ::selection { background: #f7dcc5; }
button.menu-btn { border: 0; background: transparent; font: inherit; min-width: 36px; min-height: 36px; }
button.menu-item { display: block; width: 100%; border: 0; background: transparent; text-align: left; font-family: inherit; }
button.menu-item:hover { background: #f1f1f5; }
button.menu-item.del:hover { background: #fdf0ef; }
.tb-rename { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: min(40vw, 520px); padding: 5px 7px; border: 0; border-radius: 6px; background: transparent; color: inherit; font-family: inherit; cursor: pointer; }
.tb-rename:hover { background: #e6e6eb; }
.tb-rename .tb-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-rename-label { color: #62626b; font-size: 12px; font-weight: 400; }
@media (max-width: 640px) { .tb-rename { flex: 1 1 calc(100% - 80px); max-width: calc(100% - 80px); } .tb-rename .tb-title { min-width: 0; text-align: left; } }
`;

export const TITLE_EDITOR_JS = String.raw`
function openTitleEditor(source, trigger) {
	if (document.querySelector(".title-editor")) return;
	const id = source.dataset.id;
	const originalTitle = source.dataset.title;
	const expected = { expected_state: source.dataset.state };
	const dialog = el("dialog", "title-editor");
	dialog.setAttribute("aria-labelledby", "title-editor-heading");
	const heading = el("h2", "", "Rename document");
	heading.id = "title-editor-heading";
	const form = el("form");
	const label = el("label", "", "Title");
	label.htmlFor = "title-editor-input";
	const input = el("input", "title-input");
	input.id = "title-editor-input";
	input.name = "title";
	input.type = "text";
	input.required = true;
	input.value = originalTitle;
	input.setAttribute("aria-describedby", "title-editor-help title-editor-count title-editor-status");
	const help = el("p", "title-help", "Changes the name everywhere this document is shared. Files and version history stay the same.");
	help.id = "title-editor-help";
	const assist = el("div", "title-assist");
	const suggest = el("button", "tb-ver", "Suggest with AI");
	suggest.type = "button";
	const count = el("span", "title-count");
	count.id = "title-editor-count";
	assist.append(suggest, count);
	const status = el("p", "title-status");
	status.id = "title-editor-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const actions = el("div", "title-actions");
	const cancel = el("button", "tb-ver", "Cancel");
	cancel.type = "button";
	const save = el("button", "share-btn", "Save title");
	save.type = "submit";
	actions.append(cancel, save);
	form.append(label, input, help, assist, status, actions);
	dialog.append(heading, form);
	let busy = null;
	let controller;
	let stale = false;
	function normalizedTitle() { return input.value.replace(/\s+/gu, " ").trim(); }
	function invalidCharacters(title) { return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(title.replace(/[\s\u200c\u200d]/gu, "")); }
	function sync() {
		const title = normalizedTitle();
		const length = Array.from(title).length;
		count.textContent = length + " / 200";
		input.setAttribute("aria-invalid", String(length > 200 || invalidCharacters(title)));
		save.disabled = !!busy || stale || !length || length > 200 || invalidCharacters(title) || title === originalTitle;
		suggest.disabled = !!busy || stale;
		input.disabled = !!busy;
		cancel.disabled = busy === "save";
		suggest.textContent = busy === "suggest" ? "Thinking…" : "Suggest with AI";
		save.textContent = busy === "save" ? "Saving…" : "Save title";
	}
	function message(text, error) {
		status.textContent = text;
		status.dataset.error = String(!!error);
	}
	function close() { if (busy !== "save") dialog.close(); }
	dialog.addEventListener("cancel", function (event) {
		if (busy === "save") event.preventDefault();
	});
	dialog.addEventListener("click", function (event) {
		const bounds = dialog.getBoundingClientRect();
		if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) close();
	});
	dialog.addEventListener("close", function () {
		if (controller) controller.abort();
		dialog.remove();
		if (trigger && trigger.isConnected) trigger.focus();
	});
	cancel.addEventListener("click", close);
	input.addEventListener("input", function () {
		if (stale) { sync(); return; }
		const invalid = invalidCharacters(normalizedTitle());
		message(invalid ? "Remove invisible control characters from the title." : "", invalid);
		sync();
	});
	async function request(action) {
		if (busy || stale) return;
		const title = normalizedTitle();
		if (action === "save" && (!title || Array.from(title).length > 200 || invalidCharacters(title) || title === originalTitle)) return;
		busy = action;
		controller = new AbortController();
		const timeout = setTimeout(function () { controller.abort(); }, 30000);
		sync();
		message(action === "suggest" ? "Reading the document to suggest a title…" : "Saving your title…");
		try {
			const response = await fetch("/api/documents/" + id + (action === "suggest" ? "/title-suggestion" : "/title"), {
				method: action === "suggest" ? "POST" : "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(action === "suggest" ? expected : Object.assign({ title: title }, expected)),
				signal: controller.signal,
			});
			if (!dialog.open) return;
			if (!response.ok) {
				if (response.status === 409) {
					stale = true;
					throw new Error("This document changed. Copy your title, then refresh the page before trying again.");
				}
				if (response.status === 404) {
					if (action === "suggest") throw new Error("Could not read this document. Enter a title yourself or refresh the page.");
					stale = true;
					throw new Error("This document is no longer available.");
				}
				if (response.status === 422) throw new Error("There is no readable text to suggest a title from. Enter a title yourself.");
				if (response.status === 503 && action === "suggest") throw new Error("AI could not suggest a title. Try again or enter one yourself.");
				throw new Error(action === "suggest" ? "Could not suggest a title. Try again or enter one yourself." : "Could not save the title. Try again.");
			}
			const data = await response.json();
			if (!dialog.open) return;
			if (action === "suggest") {
				input.value = data.title;
				message("Suggestion ready. Edit it if needed, then save.");
			} else {
				source.dataset.title = data.title;
				source.dataset.state = data.state;
				const label = source.querySelector(".row-title, .tb-title");
				if (label) label.textContent = data.title;
				if (source.id === "rename-current") {
					document.title = data.title;
					const share = document.getElementById("share-current");
					if (share) share.dataset.title = data.title;
				}
				dialog.close();
				toast("Title saved");
			}
		} catch (error) {
			if (!dialog.open) return;
			message(error.name === "AbortError" ? "The request timed out. Try again." : error.message || "Could not connect. Try again.", true);
		} finally {
			clearTimeout(timeout);
			busy = null;
			if (dialog.open) { sync(); input.focus(); }
		}
	}
	suggest.addEventListener("click", function () { request("suggest"); });
	form.addEventListener("submit", function (event) { event.preventDefault(); request("save"); });
	document.body.append(dialog);
	sync();
	dialog.showModal();
	input.focus();
	input.select();
}
`;
