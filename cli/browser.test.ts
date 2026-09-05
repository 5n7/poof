import { expect, test } from "bun:test";

import { openBrowser, type BrowserSpawn } from "./browser";

test("browser launch removes service credentials from a copied environment", () => {
	const source = {
		KEEP: "yes",
		POOF_ACCESS_CLIENT_ID: "client-id",
		POOF_ACCESS_CLIENT_SECRET: "client-secret",
	};
	let captured: Record<string, string | undefined> | undefined;
	let unreferenced = false;
	const spawn: BrowserSpawn = (_command, options) => {
		captured = options.env;
		return { unref: () => (unreferenced = true) };
	};
	expect(openBrowser("https://example.com/authorize", spawn, source)).toBe(true);
	expect(captured).toEqual({ KEEP: "yes" });
	expect(source.POOF_ACCESS_CLIENT_ID).toBe("client-id");
	expect(unreferenced).toBe(true);
});
