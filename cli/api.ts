// HTTP client for the poof JSON API.
// Zero runtime dependencies: Node 22 builtins + global fetch/FormData/Blob.

export interface PoofConfig {
	url: string;
	clientId: string;
	clientSecret: string;
}

export interface DocumentRow {
	id: string;
	title: string;
	kind: "md" | "html";
	created_at: number;
	expires_at: number | null;
}

export interface ShareResult {
	token: string;
	expires_at: number;
	url: string;
}

/**
 * Read configuration from the environment. Exits the process with a clear
 * message when any required variable is missing.
 */
export function loadConfig(): PoofConfig {
	const url = process.env.POOF_URL;
	const clientId = process.env.POOF_ACCESS_CLIENT_ID;
	const clientSecret = process.env.POOF_ACCESS_CLIENT_SECRET;

	const missing: string[] = [];
	if (!url) missing.push("POOF_URL");
	if (!clientId) missing.push("POOF_ACCESS_CLIENT_ID");
	if (!clientSecret) missing.push("POOF_ACCESS_CLIENT_SECRET");

	if (missing.length > 0) {
		process.stderr.write(
			`Error: missing required environment variable(s): ${missing.join(", ")}\n` +
				"Set POOF_URL, POOF_ACCESS_CLIENT_ID, and POOF_ACCESS_CLIENT_SECRET " +
				"(see docs/SETUP.md).\n",
		);
		process.exit(1);
	}

	// Trim a trailing slash so path concatenation stays predictable.
	return {
		url: url!.replace(/\/+$/, ""),
		clientId: clientId!,
		clientSecret: clientSecret!,
	};
}

/**
 * Perform an authenticated API request. Object bodies are sent as JSON;
 * FormData bodies are sent as-is (multipart). Throws with the server error
 * text on a non-2xx response.
 */
export async function api<T>(cfg: PoofConfig, method: string, path: string, body?: FormData | object): Promise<T> {
	const headers: Record<string, string> = {
		"CF-Access-Client-Id": cfg.clientId,
		"CF-Access-Client-Secret": cfg.clientSecret,
	};

	let payload: string | FormData | undefined;
	if (body instanceof FormData) {
		payload = body;
	} else if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		payload = JSON.stringify(body);
	}

	const res = await fetch(`${cfg.url}${path}`, { method, headers, body: payload });

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}` + (text ? `\n${text}` : ""));
	}

	if (res.status === 204) {
		return undefined as T;
	}

	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		return (await res.json()) as T;
	}
	return (await res.text()) as unknown as T;
}
