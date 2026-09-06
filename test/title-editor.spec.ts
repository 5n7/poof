import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { OWNER_BASE, seedDoc, seedShare, seedVersion } from "./helpers";

describe("owner title editing", () => {
	it("renders the escaped title with the same opaque state as the metadata API", async () => {
		const id = "title_editor_owner";
		await seedDoc(id, { title: 'A <draft> & "review"' });
		await seedVersion(id, 2);
		const metadata = await (await SELF.fetch(`${OWNER_BASE}/api/documents/${id}`)).json<{ state: string }>();
		expect(metadata.state).toMatch(/^[a-f0-9]{64}$/);
		const library = await (await SELF.fetch(`${OWNER_BASE}/`)).text();
		expect(library).toContain(
			`data-id="${id}" data-title="A &lt;draft&gt; &amp; &quot;review&quot;" data-state="${metadata.state}"`,
		);
		expect(library).toContain('class="menu-item" data-rename');
		const viewer = await (await SELF.fetch(`${OWNER_BASE}/d/${id}`)).text();
		expect(viewer).toContain('id="rename-current"');
		expect(viewer).toContain(`data-title="A &lt;draft&gt; &amp; &quot;review&quot;" data-state="${metadata.state}"`);
	});

	it("renames a legacy title larger than the request limit using the rendered state", async () => {
		const id = "title_editor_long_legacy";
		await seedDoc(id, { title: "Legacy title ".repeat(2000) });
		const viewer = await (await SELF.fetch(`${OWNER_BASE}/d/${id}`)).text();
		const state = viewer.match(/data-state="([a-f0-9]{64})"/)?.[1];
		expect(state).toBeDefined();
		const body = JSON.stringify({ title: "A shorter title", expected_state: state });
		expect(body.length).toBeLessThan(200);
		const response = await SELF.fetch(`${OWNER_BASE}/api/documents/${id}/title`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body,
		});
		expect(response.status).toBe(200);
		const saved = await response.json<{ title: string; state: string }>();
		expect(saved.title).toBe("A shorter title");
		expect(saved.state).not.toBe(state);
		const library = await (await SELF.fetch(`${OWNER_BASE}/`)).text();
		expect(library).toContain(`data-id="${id}" data-title="A shorter title" data-state="${saved.state}"`);
	});

	it("offers rename on a pin to the current version but not a historical version", async () => {
		const id = "title_editor_history";
		await seedDoc(id);
		await seedVersion(id, 2);
		await env.DB.prepare("UPDATE document SET title = ? WHERE id = ?").bind("Renamed live title", id).run();
		const current = await (await SELF.fetch(`${OWNER_BASE}/d/${id}?v=2`)).text();
		const past = await (await SELF.fetch(`${OWNER_BASE}/d/${id}?v=1`)).text();
		expect(current).toContain('id="rename-current"');
		expect(past).toContain("read-only");
		expect(current).toContain("<title>Renamed live title</title>");
		expect(past).toContain(`<title>${id}</title>`);
		expect(past).toContain(`<span class="tb-title">${id}</span>`);
		expect(past).not.toContain('id="rename-current"');
		expect(past).not.toContain('class="menu-item" data-rename');
	});

	it("keeps the public viewer free of editing controls and editing scripts", async () => {
		const id = "title_editor_public";
		const token = "s_titleeditorpublic00000000";
		await seedDoc(id);
		await seedShare(token, id, { expiresAt: Math.floor(Date.now() / 1000) + 3600 });
		const response = await SELF.fetch(`${OWNER_BASE}/v/${token}`);
		expect(response.status).toBe(200);
		const viewer = await response.text();
		expect(viewer).not.toContain('id="rename-current"');
		expect(viewer).not.toContain("function openTitleEditor");
	});
});
