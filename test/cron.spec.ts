import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runCleanup } from "../src/cron";
import { seedDoc, seedShare } from "./helpers";

const HTML = "<html><body>doc</body></html>";

function putDoc(id: string, expiresAt: number | null) {
	return seedDoc(id, { expiresAt, body: HTML });
}

function putShare(token: string, docId: string, expiresAt: number) {
	return seedShare(token, docId, { expiresAt });
}

async function docExists(id: string) {
	const row = await env.DB.prepare("SELECT id FROM document WHERE id = ?").bind(id).first();
	return row !== null;
}

async function shareExists(token: string) {
	const row = await env.DB.prepare("SELECT token FROM share WHERE token = ?").bind(token).first();
	return row !== null;
}

describe("runCleanup", () => {
	it("deletes exactly the expired and orphaned items and returns correct counts", async () => {
		const now = (Date.now() / 1000) | 0;

		// Expired share on a live document (removed by step 1).
		await putDoc("cron_live_for_expshare", null);
		await putShare("s_cron_expiredshare00000", "cron_live_for_expshare", now - 100);

		// Expired document with its own blob and a (still-live) share, removed via
		// step 2 + FK cascade.
		const expiredDocKey = await putDoc("cron_expired_doc", now - 100);
		await putShare("s_cron_docshare000000000", "cron_expired_doc", now + 3600);

		// Live document with a live share — must survive.
		const liveKey = await putDoc("cron_live_doc", now + 3600);
		await putShare("s_cron_liveshare00000000", "cron_live_doc", now + 3600);

		// Orphan R2 object with no matching document row.
		await env.BLOBS.put("doc/cron_orphan.html", HTML);

		const counts = await runCleanup(env, now);
		expect(counts).toEqual({ shares: 1, documents: 1, orphans: 1 });

		// Expired share gone.
		expect(await shareExists("s_cron_expiredshare00000")).toBe(false);
		// Expired document + blob + cascaded share gone.
		expect(await docExists("cron_expired_doc")).toBe(false);
		expect(await env.BLOBS.get(expiredDocKey)).toBeNull();
		expect(await shareExists("s_cron_docshare000000000")).toBe(false);
		// Orphan blob gone.
		expect(await env.BLOBS.get("doc/cron_orphan.html")).toBeNull();

		// Live document, its blob, and its share survive.
		expect(await docExists("cron_live_doc")).toBe(true);
		expect(await env.BLOBS.get(liveKey)).not.toBeNull();
		expect(await shareExists("s_cron_liveshare00000000")).toBe(true);
	});

	it("is idempotent — a second run is a no-op", async () => {
		const now = (Date.now() / 1000) | 0;
		await putDoc("cron_idem_expired", now - 100);
		await putDoc("cron_idem_live", now + 3600);
		await env.BLOBS.put("doc/cron_idem_orphan.html", HTML);

		const first = await runCleanup(env, now);
		expect(first).toEqual({ shares: 0, documents: 1, orphans: 1 });

		const second = await runCleanup(env, now);
		expect(second).toEqual({ shares: 0, documents: 0, orphans: 0 });

		// The live document is still present after both runs.
		expect(await docExists("cron_idem_live")).toBe(true);
	});
});
