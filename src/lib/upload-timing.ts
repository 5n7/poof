/** Optional upload timing. Labels are fixed in code and never contain user input. */
export class UploadTiming {
	private readonly started = performance.now();
	private readonly durations = new Map<string, number>();
	private readonly counts = new Map<string, number>();

	async measure<T>(label: string, work: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await work();
		} finally {
			this.add(label, performance.now() - start);
		}
	}

	add(label: string, duration: number): void {
		this.durations.set(label, (this.durations.get(label) ?? 0) + duration);
		this.counts.set(label, (this.counts.get(label) ?? 0) + 1);
	}

	report(operation: "push" | "update", files: number, bytes: number): { traceId: string; serverTiming: string } {
		this.add("total", performance.now() - this.started);
		const traceId = crypto.randomUUID();
		const phases = Object.fromEntries(
			[...this.durations].map(([name, duration]) => [name, Math.round(duration * 10) / 10]),
		);
		const serverTiming = Object.entries(phases)
			.map(([name, duration]) => `${name};dur=${duration}`)
			.join(", ");
		console.info(
			JSON.stringify({
				event: "upload_timing",
				traceId,
				operation,
				files,
				bytes,
				phases,
				counts: Object.fromEntries(this.counts),
			}),
		);
		return { traceId, serverTiming };
	}

	finish(response: Response, operation: "push" | "update", files: number, bytes: number): Response {
		const { traceId, serverTiming } = this.report(operation, files, bytes);
		response.headers.set("Server-Timing", serverTiming);
		response.headers.set("X-Poof-Trace", traceId);
		return response;
	}
}

export function measureUpload<T>(timing: UploadTiming | undefined, label: string, work: () => Promise<T>): Promise<T> {
	return timing ? timing.measure(label, work) : work();
}
