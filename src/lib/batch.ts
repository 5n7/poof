/** D1 binds at most 100 parameters per statement, so `IN (…)` lists must be chunked. */
export const D1_MAX_BINDINGS = 100;

/** R2 deletes at most 1000 keys per call — the same size as one `list()` page. */
export const R2_MAX_DELETE = 1000;

export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Bulk-delete blobs, honoring R2's per-call key limit. */
export async function deleteBlobs(blobs: R2Bucket, keys: string[]): Promise<void> {
	for (const batch of chunk(keys, R2_MAX_DELETE)) await blobs.delete(batch);
}
