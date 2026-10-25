// Shared by the owner library and current document viewer. Colors and type come
// from the design tokens in src/ui/theme.ts.
export const TITLE_EDITOR_CSS = `
.title-editor { width: 460px; max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow: auto; margin: auto; padding: 24px; border: 1px solid var(--line); border-radius: 28px; color: var(--ink); background: var(--surface); box-shadow: var(--shadow-lift); }
.title-editor[open] { animation: pop-in 0.22s var(--ease-out); }
.title-editor::backdrop { background: color-mix(in srgb, var(--mist) 55%, transparent); backdrop-filter: blur(6px); }
.title-editor h2 { margin: 0 0 18px; font: 700 23px/1.15 var(--font-display); letter-spacing: -0.02em; }
.title-editor label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 650; color: var(--muted); }
.title-input { display: block; width: 100%; padding: 12px 16px; border: 1px solid var(--line); border-radius: 16px; color: inherit; background: var(--mist); font: 500 16px var(--font-body); caret-color: var(--dusk); }
.title-input:focus-visible { outline: 2px solid var(--dusk); outline-offset: 1px; background: var(--surface); }
.title-input[aria-invalid="true"] { border-color: var(--danger); }
.title-help, .title-status { margin: 10px 2px 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
.title-status { min-height: 20px; overflow-wrap: anywhere; }
.title-status[data-error="true"] { color: var(--danger); }
.title-assist { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; }
.title-count { color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.title-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.title-editor .btn { min-height: 40px; }
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
	const suggest = el("button", "btn", "Suggest with AI");
	suggest.type = "button";
	const count = el("span", "title-count");
	count.id = "title-editor-count";
	assist.append(suggest, count);
	const status = el("p", "title-status");
	status.id = "title-editor-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	const actions = el("div", "title-actions");
	const cancel = el("button", "btn ghost", "Cancel");
	cancel.type = "button";
	const save = el("button", "btn primary", "Save title");
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
				const label = source.querySelector("[data-title-label]");
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
