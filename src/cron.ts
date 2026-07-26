import { D1_MAX_BINDINGS, chunk, deleteBlobs } from "./lib/batch";
import { nowSeconds } from "./lib/time";

/** The `?,?,?` bind list for an `IN (…)` of `count` values. */
function placeholders(count: number): string {
	return Array(count).fill("?").join(",");
}

/**
 * Weekly cleanup (SPEC §7 — housekeeping only; read-time checks are the real
 * enforcement). Deletes expired shares, expired documents (+ every version's R2
 * blob and their cascaded shares), and sweeps orphaned R2 objects under `doc/`.
 */
export async function runCleanup(
	env: Env,
	now = nowSeconds(),
): Promise<{ shares: number; documents: number; orphans: number }> {
	// 1. Expired shares.
	const sharesRes = await env.DB.prepare("DELETE FROM share WHERE expires_at < ?").bind(now).run();
	const shares = sharesRes.meta.changes ?? 0;

	// 2. Expired documents: drop blobs, then rows (cascade removes their versions
	// and shares). The version keys must be read BEFORE the delete, since the
	// cascade takes document_version with the document. `documents` counts
	// document rows, not blobs.
	const { results: expiredDocs } = await env.DB.prepare(
		"SELECT id FROM document WHERE expires_at IS NOT NULL AND expires_at < ?",
	)
		.bind(now)
		.all<{ id: string }>();
	const documents = expiredDocs.length;
	if (documents > 0) {
		const idBatches = chunk(
			expiredDocs.map((doc) => doc.id),
			D1_MAX_BINDINGS,
		);
		const keys: string[] = [];
		for (const batch of idBatches) {
			const { results } = await env.DB.prepare(
				`SELECT r2_key FROM document_version WHERE document_id IN (${placeholders(batch.length)})`,
			)
				.bind(...batch)
				.all<{ r2_key: string }>();
			for (const row of results) keys.push(row.r2_key);
		}
		await deleteBlobs(env.BLOBS, keys);
		for (const batch of idBatches) {
			await env.DB.prepare(`DELETE FROM document WHERE id IN (${placeholders(batch.length)})`)
				.bind(...batch)
				.run();
		}
	}

	// 3. Orphan sweep: R2 objects under doc/ with no document_version row. The
	// reference set is document_version, not document — otherwise every blob of a
	// non-current version would look orphaned and be deleted. Both key shapes
	// arrive here (legacy flat `doc/{id}.html` from the backfill and nested
	// `doc/{id}/v{n}.html`); R2 keys are flat strings, so one prefix covers both.
	let orphans = 0;
	let cursor: string | undefined;
	do {
		const listed = await env.BLOBS.list({ prefix: "doc/", cursor });
		const keys = listed.objects.map((o) => o.key);
		if (keys.length > 0) {
			// A listing page holds up to 1000 keys but a statement binds at most
			// 100, so the probe has to be chunked.
			const known = new Set<string>();
			for (const batch of chunk(keys, D1_MAX_BINDINGS)) {
				const { results } = await env.DB.prepare(
					`SELECT r2_key FROM document_version WHERE r2_key IN (${placeholders(batch.length)})`,
				)
					.bind(...batch)
					.all<{ r2_key: string }>();
				for (const row of results) known.add(row.r2_key);
			}
			const orphanKeys = keys.filter((key) => !known.has(key));
			if (orphanKeys.length > 0) {
				await deleteBlobs(env.BLOBS, orphanKeys);
				orphans += orphanKeys.length;
			}
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor);

	return { shares, documents, orphans };
}
