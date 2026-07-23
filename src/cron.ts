import { nowSeconds } from "./lib/time";

/**
 * Weekly cleanup (SPEC §7 — housekeeping only; read-time checks are the real
 * enforcement). Deletes expired shares, expired documents (+ their R2 blobs and
 * cascaded shares), and sweeps orphaned R2 objects under `doc/`.
 */
export async function runCleanup(
	env: Env,
	now = nowSeconds(),
): Promise<{ shares: number; documents: number; orphans: number }> {
	// 1. Expired shares.
	const sharesRes = await env.DB.prepare("DELETE FROM share WHERE expires_at < ?").bind(now).run();
	const shares = sharesRes.meta.changes ?? 0;

	// 2. Expired documents: drop blobs, then rows (cascade removes their shares).
	// Batch both sides — R2 delete and the DELETE ... IN each take one round trip.
	const { results: expiredDocs } = await env.DB.prepare(
		"SELECT id, r2_key FROM document WHERE expires_at IS NOT NULL AND expires_at < ?",
	)
		.bind(now)
		.all<{ id: string; r2_key: string }>();
	const documents = expiredDocs.length;
	if (documents > 0) {
		await env.BLOBS.delete(expiredDocs.map((doc) => doc.r2_key));
		const placeholders = expiredDocs.map(() => "?").join(",");
		await env.DB.prepare(`DELETE FROM document WHERE id IN (${placeholders})`)
			.bind(...expiredDocs.map((doc) => doc.id))
			.run();
	}

	// 3. Orphan sweep: R2 objects under doc/ with no matching document row.
	let orphans = 0;
	let cursor: string | undefined;
	do {
		const listed = await env.BLOBS.list({ prefix: "doc/", cursor });
		const keys = listed.objects.map((o) => o.key);
		if (keys.length > 0) {
			const placeholders = keys.map(() => "?").join(",");
			const { results } = await env.DB.prepare(`SELECT r2_key FROM document WHERE r2_key IN (${placeholders})`)
				.bind(...keys)
				.all<{ r2_key: string }>();
			const known = new Set(results.map((r) => r.r2_key));
			const orphanKeys = keys.filter((key) => !known.has(key));
			if (orphanKeys.length > 0) {
				await env.BLOBS.delete(orphanKeys);
				orphans += orphanKeys.length;
			}
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	return { shares, documents, orphans };
}
