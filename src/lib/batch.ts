/** D1 binds at most 100 parameters per statement, so `IN (…)` lists must be chunked. */
export const D1_MAX_BINDINGS = 100;

/** R2 deletes at most 1000 keys per call, the size of one `list()` page. */
export const R2_MAX_DELETE = 1000;

export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Stop scheduling after a failure and drain active work before callers can clean up. */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new RangeError("Concurrency must be a positive integer.");
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	let failure: unknown;
	async function run(): Promise<void> {
		while (!failed && next < items.length) {
			const index = next++;
			try {
				results[index] = await map(items[index]!, index);
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
	if (failed) throw failure;
	return results;
}

/** Bulk-delete blobs, honoring R2's per-call key limit. */
export async function deleteBlobs(blobs: R2Bucket, keys: string[]): Promise<void> {
	for (const batch of chunk(keys, R2_MAX_DELETE)) await blobs.delete(batch);
}
