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
	updated_at: number;
	current_version: number;
	expires_at: number | null;
}

/** One history entry returned by the API. `r2_key` stays on the server. */
export interface VersionRow {
	version: number;
	kind: "md" | "html";
	created_at: number;
}

export interface VersionsResult {
	current_version: number;
	versions: VersionRow[];
}

export interface UpdateResult {
	id: string;
	version: number;
	kind: "md" | "html";
	title: string;
	updated_at: number;
	url: string;
}

export interface RollbackResult {
	current_version: number;
	updated_at: number;
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
 * Build an API path and percent-encode each interpolated value. IDs and tokens
 * are user input. If left raw, `poof cat 'id?v=99' --version 1` could override
 * the requested version.
 */
export function p(strings: TemplateStringsArray, ...values: string[]): string {
	return strings.reduce((acc, part, i) => acc + (i > 0 ? encodeURIComponent(values[i - 1]) : "") + part, "");
}

/**
 * Perform an authenticated request and return the raw response. Object bodies
 * are sent as JSON; FormData bodies are sent as-is (multipart). Throws with the
 * server error text on a non-2xx response.
 */
async function request(cfg: PoofConfig, method: string, path: string, body?: FormData | object): Promise<Response> {
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

	// Cloudflare Access redirects unauthenticated requests to its sign-in page.
	// Do not follow that redirect. Otherwise `poof cat` could print login HTML and
	// exit 0, while `poof ls` could parse that HTML as an API response.
	const res = await fetch(`${cfg.url}${path}`, { method, headers, body: payload, redirect: "manual" });

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}` + (text ? `\n${text}` : ""));
	}

	return res;
}

/** Perform an authenticated JSON API request. 204s resolve to undefined. */
export async function api<T>(cfg: PoofConfig, method: string, path: string, body?: FormData | object): Promise<T> {
	const res = await request(cfg, method, path, body);
	if (res.status === 204) {
		return undefined as T;
	}
	return (await res.json()) as T;
}

/**
 * Perform the same request and return the undecoded body stream. Documents can
 * reach 10 MiB, so `poof cat big > out.html` must not buffer the full response.
 * Returns null when the server sends no body.
 */
export async function apiStream(cfg: PoofConfig, method: string, path: string): Promise<ReadableStream | null> {
	const res = await request(cfg, method, path);
	return res.body;
}
