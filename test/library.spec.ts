import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MCP_BASE, OWNER_BASE, fetchWorker, seedDoc, seedShare } from "./helpers";

const GITHUB = "https://github.com/5n7/poof";
const GUIDE_URL = `${OWNER_BASE}/guide`;
const MCP_URL = `${MCP_BASE}/mcp`;

type FakeElement = ReturnType<typeof fakeElement>;

function fakeElement(dataset: Record<string, string> = {}) {
	const attributes = new Map<string, string>();
	const classes = new Set<string>();
	const listeners = new Map<string, () => void>();
	let removed = false;
	return {
		classList: {
			add: (name: string) => classes.add(name),
			contains: (name: string) => classes.has(name),
			remove: (name: string) => classes.delete(name),
		},
		className: "",
		click: () => listeners.get("click")?.(),
		dataset,
		getAttribute: (name: string) => attributes.get(name) ?? null,
		id: "",
		isRemoved: () => removed,
		addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
		remove: () => {
			removed = true;
		},
		setAttribute: (name: string, value: string) => attributes.set(name, value),
		textContent: "",
	};
}

function guideCopyHarness(html: string, writeText: (command: string) => Promise<void>) {
	const commands = [
		fakeElement({ copyCommand: MCP_URL, copyLabel: "server URL" }),
		fakeElement({ copyCommand: `claude mcp add --transport http poof ${MCP_URL}`, copyLabel: "Claude Code" }),
		fakeElement({ copyCommand: `codex mcp add poof --url ${MCP_URL}\ncodex mcp login poof`, copyLabel: "Codex" }),
	];
	const elements: FakeElement[] = [];
	const timers = new Map<number, { callback: () => void; delay: number }>();
	let nextTimer = 0;
	const document = {
		body: { append: (element: FakeElement) => elements.push(element) },
		createElement: () => fakeElement(),
		getElementById: (id: string) => elements.find((element) => !element.isRemoved() && element.id === id) ?? null,
		querySelectorAll: (selector: string) => (selector === "[data-copy-command]" ? commands : []),
	};
	const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
	if (!script) throw new Error("Guide client script is missing");
	new Function("document", "navigator", "setTimeout", "clearTimeout", script)(
		document,
		{ clipboard: { writeText } },
		(callback: () => void, delay: number) => {
			const id = ++nextTimer;
			timers.set(id, { callback, delay });
			return id;
		},
		(id: number | undefined) => timers.delete(id ?? 0),
	);
	return {
		commands,
		runTimers: (delay: number) => {
			for (const [id, timer] of timers) {
				if (timer.delay !== delay) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		timerCount: (delay: number) => [...timers.values()].filter((timer) => timer.delay === delay).length,
		toast: () => elements.find((element) => !element.isRemoved() && element.id === "toast"),
	};
}

async function flushClientCopy() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("GET / library chrome", () => {
	it("includes a GitHub mark linking to the source repo", async () => {
		const res = await SELF.fetch(`${OWNER_BASE}/`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(GITHUB);
		expect(html).toContain('aria-label="GitHub"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("links to the owner-only assistant connection guide", async () => {
		const library = await SELF.fetch(`${OWNER_BASE}/`);
		const libraryHtml = await library.text();
		expect(libraryHtml).toContain('href="/guide"');
		expect(libraryHtml).toContain("Connect an AI assistant →");

		const guide = await SELF.fetch(GUIDE_URL);
		expect(guide.status).toBe(200);
		const guideHtml = await guide.text();
		expect(guideHtml).toContain(MCP_URL);
		expect(guideHtml).toContain("claude mcp add --transport http poof");
		expect(guideHtml).toContain("codex mcp add poof --url");
		expect(guideHtml).toContain("codex mcp login poof");
		expect(guideHtml).toContain('data-copy-command="https://mcp.poof.5n7.me/mcp"');
		expect(guideHtml).toContain('aria-label="Copy Claude Code command"');
		expect(guideHtml).toContain('aria-label="Copy Codex command"');
		expect(guideHtml).toContain("Could not copy \\u2014 select the command instead");
		expect(guideHtml).toContain('role", "status"');
		expect(guideHtml).toContain("https://github.com/5n7/poof#mcp-server");
		expect(guideHtml).toContain("https://github.com/5n7/poof/blob/main/docs/MCP-OAUTH-RUNBOOK.md");
		expect(guideHtml).toContain("Keep links safe");
		expect((await SELF.fetch(`${MCP_BASE}/guide`)).status).toBe(404);
	});

	it("copies the complete multi-line Codex command and announces success", async () => {
		const guideHtml = await (await SELF.fetch(GUIDE_URL)).text();
		const copied: string[] = [];
		const guide = guideCopyHarness(guideHtml, async (command) => {
			copied.push(command);
		});

		guide.commands[2].click();
		await flushClientCopy();

		expect(copied).toEqual([`codex mcp add poof --url ${MCP_URL}\ncodex mcp login poof`]);
		expect(guide.commands[2].textContent).toBe("Copied ✓");
		expect(guide.commands[2].getAttribute("aria-label")).toBe("Copied Codex command");
		expect(guide.toast()?.textContent).toBe("Copied Codex command");
		expect(guide.toast()?.getAttribute("role")).toBe("status");
		expect(guide.toast()?.getAttribute("aria-live")).toBe("polite");
		expect(guide.timerCount(1000)).toBe(0);
	});

	it("shows a recovery toast when the command cannot be copied", async () => {
		const guideHtml = await (await SELF.fetch(GUIDE_URL)).text();
		const guide = guideCopyHarness(guideHtml, async () => {
			throw new Error("Clipboard denied");
		});

		guide.commands[1].click();
		await flushClientCopy();

		expect(guide.commands[1].textContent).toBe("Copy");
		expect(guide.toast()?.textContent).toBe("Could not copy — select the command instead");
		expect(guide.timerCount(1000)).toBe(0);
	});

	it("clears the copy timeout when a clipboard write times out", async () => {
		const guideHtml = await (await SELF.fetch(GUIDE_URL)).text();
		let resolveWrite: (() => void) | undefined;
		const guide = guideCopyHarness(
			guideHtml,
			() =>
				new Promise<void>((resolve) => {
					resolveWrite = resolve;
				}),
		);

		guide.commands[0].click();
		expect(guide.timerCount(1000)).toBe(1);
		guide.runTimers(1000);
		await flushClientCopy();

		expect(guide.toast()?.textContent).toBe("Could not copy — select the command instead");
		expect(guide.timerCount(1000)).toBe(0);
		resolveWrite!();
		await flushClientCopy();
		expect(guide.toast()?.textContent).toBe("Could not copy — select the command instead");
	});

	it("ignores stale copy attempts and cancels the prior button timer", async () => {
		const guideHtml = await (await SELF.fetch(GUIDE_URL)).text();
		const resolves: Array<() => void> = [];
		const guide = guideCopyHarness(
			guideHtml,
			() =>
				new Promise<void>((resolve) => {
					resolves.push(resolve);
				}),
		);

		guide.commands[0].click();
		guide.commands[0].click();
		resolves[0]!();
		await flushClientCopy();
		expect(guide.commands[0].textContent).toBe("Copy");
		expect(guide.toast()).toBeUndefined();

		resolves[1]!();
		await flushClientCopy();
		expect(guide.commands[0].textContent).toBe("Copied ✓");
		expect(guide.timerCount(2200)).toBe(2);

		guide.commands[0].click();
		expect(guide.commands[0].textContent).toBe("Copy");
		expect(guide.timerCount(2200)).toBe(1);
	});

	it("uses the configured MCP host in the connection commands", async () => {
		const guide = await fetchWorker("https://owner.staging.example/guide", {
			MCP_HOST: "mcp.staging.example",
			OWNER_HOST: "owner.staging.example",
		});
		const html = await guide.text();
		expect(html).toContain("https://mcp.staging.example/mcp");
		expect(html).toContain("claude mcp add --transport http poof https://mcp.staging.example/mcp");
		expect(html).toContain("codex mcp add poof --url https://mcp.staging.example/mcp");

		const localGuide = await fetchWorker("http://localhost:8787/guide", {
			MCP_HOST: "127.0.0.1:8787",
			OWNER_HOST: "localhost:8787",
		});
		expect(await localGuide.text()).toContain("http://127.0.0.1:8787/mcp");
	});

	it("does not leak the GitHub link onto a public share viewer", async () => {
		const id = "doc_lib_gh_share";
		const token = "s_libghshare000000000000";
		const t = (Date.now() / 1000) | 0;
		await seedDoc(id, { title: "share viewer", createdAt: t });
		await seedShare(token, id, { createdAt: t, expiresAt: t + 3600 });

		const res = await SELF.fetch(`${OWNER_BASE}/v/${token}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain(GITHUB);
		expect(html).not.toContain("Connect an AI assistant");
		expect(html).not.toContain("/guide");
	});
});
