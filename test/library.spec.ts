import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { seedDoc, seedShare } from "./helpers";

const BASE = "https://poof.5n7.me";
const GITHUB = "https://github.com/5n7/poof";

describe("GET / library chrome", () => {
	it("includes a GitHub mark linking to the source repo", async () => {
		const res = await SELF.fetch(`${BASE}/`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(GITHUB);
		expect(html).toContain('aria-label="GitHub"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it("does not leak the GitHub link onto a public share viewer", async () => {
		const id = "doc_lib_gh_share";
		const token = "s_libghshare000000000000";
		const t = (Date.now() / 1000) | 0;
		await seedDoc(id, { title: "share viewer", createdAt: t });
		await seedShare(token, id, { createdAt: t, expiresAt: t + 3600 });

		const res = await SELF.fetch(`${BASE}/v/${token}`);
		expect(res.status).toBe(200);
		expect(await res.text()).not.toContain(GITHUB);
	});
});
