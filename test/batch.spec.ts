import { describe, expect, it, vi } from "vitest";

import { mapConcurrent } from "../src/lib/batch";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("bounded concurrent work", () => {
	it("keeps the concurrency limit and input order when work finishes out of order", async () => {
		const gates = Array.from({ length: 5 }, () => deferred<number>());
		const started: number[] = [];
		const result = mapConcurrent(gates, 2, (gate, index) => {
			started.push(index);
			return gate.promise;
		});
		expect(started).toEqual([0, 1]);
		gates[1]!.resolve(11);
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2]);
		gates[2]!.resolve(12);
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2, 3]);
		gates[0]!.resolve(10);
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2, 3, 4]);
		gates[4]!.resolve(14);
		gates[3]!.resolve(13);
		expect(await result).toEqual([10, 11, 12, 13, 14]);
	});

	it("stops scheduling on failure and waits for active work before rejecting", async () => {
		const active = deferred<void>();
		const failed = vi.fn();
		const error = new Error("upload failed");
		const map = vi.fn(async (index: number) => {
			if (index === 1) throw error;
			await active.promise;
		});
		const result = mapConcurrent([0, 1, 2, 3], 2, map).catch(failed);
		await Promise.resolve();
		await Promise.resolve();
		expect(map).toHaveBeenCalledTimes(2);
		expect(failed).not.toHaveBeenCalled();
		active.resolve();
		await result;
		expect(failed).toHaveBeenCalledExactlyOnceWith(error);
		expect(map).toHaveBeenCalledTimes(2);
	});

	it("handles empty work and rejects invalid limits", async () => {
		const map = vi.fn(async () => 1);
		expect(await mapConcurrent([], 4, map)).toEqual([]);
		expect(map).not.toHaveBeenCalled();
		for (const limit of [0, -1, 1.5, Infinity])
			await expect(mapConcurrent([1], limit, map)).rejects.toThrow(RangeError);
	});
});
