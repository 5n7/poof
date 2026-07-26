import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runCleanup } from "../src/cron";
import { seedDoc, seedShare, seedVersion } from "./helpers";

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

	it("never sweeps the blob of a non-current version", async () => {
		const now = (Date.now() / 1000) | 0;
		// v1 under the legacy flat key (as migration 0002 backfilled it), v2 and v3
		// nested; the pointer trails the maximum, as it does after a rollback.
		const v1 = await seedDoc("cron_history", { body: HTML });
		const v2 = await seedVersion("cron_history", 2, { body: HTML });
		const v3 = await seedVersion("cron_history", 3, { body: HTML, setCurrent: false });
		const keys = [v1, v2, v3];

		for (let run = 0; run < 2; run++) {
			const counts = await runCleanup(env, now);
			expect(counts).toEqual({ shares: 0, documents: 0, orphans: 0 });
			for (const key of keys) expect(await env.BLOBS.get(key)).not.toBeNull();
		}
		expect(await docExists("cron_history")).toBe(true);
	});

	it("deletes every version blob of an expired document, flat and nested alike", async () => {
		const now = (Date.now() / 1000) | 0;
		const v1 = await seedDoc("cron_exp_history", { expiresAt: now - 100, body: HTML });
		const v2 = await seedVersion("cron_exp_history", 2, { body: HTML });
		const v3 = await seedVersion("cron_exp_history", 3, { body: HTML });
		expect(v1).toBe("doc/cron_exp_history.html");

		// orphans stays 0: phase 2 must remove all three itself rather than leaving
		// rowless blobs for the sweep to find.
		const counts = await runCleanup(env, now);
		expect(counts).toEqual({ shares: 0, documents: 1, orphans: 0 });

		expect(await docExists("cron_exp_history")).toBe(false);
		for (const key of [v1, v2, v3]) expect(await env.BLOBS.get(key)).toBeNull();
	});

	it("sweeps a nested version blob that has no row", async () => {
		const now = (Date.now() / 1000) | 0;
		const live = await seedDoc("cron_nested_orphan", { body: HTML });
		await env.BLOBS.put("doc/cron_nested_orphan/v2.html", HTML);

		const counts = await runCleanup(env, now);
		expect(counts).toEqual({ shares: 0, documents: 0, orphans: 1 });
		expect(await env.BLOBS.get("doc/cron_nested_orphan/v2.html")).toBeNull();
		expect(await env.BLOBS.get(live)).not.toBeNull();
	});

	it("sweeps correctly when a listing page holds more than 100 keys", async () => {
		const now = (Date.now() / 1000) | 0;
		// A listing page carries up to 1000 keys but a statement binds at most 100,
		// so an unchunked `r2_key IN (…)` probe would blow up right here.
		const known = [await seedDoc("cron_bulk", { body: HTML })];
		for (let v = 2; v <= 105; v++) {
			known.push(await seedVersion("cron_bulk", v, { body: HTML, setCurrent: false }));
		}
		expect(known.length).toBe(105);
		const orphanKeys = ["doc/cron_bulk_orphan_a.html", "doc/cron_bulk_orphan_b.html", "doc/cron_bulk/v999.html"];
		for (const key of orphanKeys) await env.BLOBS.put(key, HTML);

		const counts = await runCleanup(env, now);
		expect(counts).toEqual({ shares: 0, documents: 0, orphans: 3 });

		for (const key of orphanKeys) expect(await env.BLOBS.get(key)).toBeNull();
		for (const key of known) expect(await env.BLOBS.get(key)).not.toBeNull();
	});
});
