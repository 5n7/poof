import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { MCP_BASE, OWNER_BASE, fetchWorker, seedDoc, seedShare } from "./helpers";

const GITHUB = "https://github.com/5n7/poof";
const GUIDE_URL = `${OWNER_BASE}/guide`;
const MCP_URL = `${MCP_BASE}/mcp`;

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
		expect(guideHtml).toContain("https://github.com/5n7/poof#mcp-server");
		expect(guideHtml).toContain("https://github.com/5n7/poof/blob/main/docs/MCP-OAUTH-RUNBOOK.md");
		expect(guideHtml).toContain("Keep links safe");
		expect((await SELF.fetch(`${MCP_BASE}/guide`)).status).toBe(404);
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
