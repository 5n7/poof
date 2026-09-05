// HTTP client for the poof JSON API.

import { oauthAccessToken } from "./auth";
import { canonicalResource } from "./oauth";

interface ServiceAuth {
	type: "service";
	clientId: string;
	clientSecret: string;
}

interface OAuthAuth {
	type: "oauth";
}

export interface PoofConfig {
	url: string;
	auth: ServiceAuth | OAuthAuth;
}

export interface ApiRuntime {
	fetch: typeof fetch;
	oauthAccessToken(resource: string, forceRefresh?: boolean): Promise<string>;
}

export type HttpMethod = "DELETE" | "GET" | "HEAD" | "POST";

export const defaultApiRuntime: ApiRuntime = { fetch, oauthAccessToken };

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
 * Read the deployment URL and select one authentication method. A complete
 * service credential pair is an explicit machine credential; otherwise the
 * CLI uses the interactive OAuth grant in the OS credential manager.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PoofConfig {
	const url = env.POOF_URL;
	if (!url) throw new Error("missing required environment variable: POOF_URL (see docs/SETUP.md)");
	const clientId = env.POOF_ACCESS_CLIENT_ID;
	const clientSecret = env.POOF_ACCESS_CLIENT_SECRET;
	if ((clientId && !clientSecret) || (!clientId && clientSecret)) {
		throw new Error("POOF_ACCESS_CLIENT_ID and POOF_ACCESS_CLIENT_SECRET must be set together");
	}
	if (!clientId || !clientSecret) return { url: canonicalResource(url), auth: { type: "oauth" } };

	let serviceUrl: URL;
	try {
		serviceUrl = new URL(url);
	} catch {
		throw new Error("POOF_URL must be an absolute URL.");
	}
	const literalHttpLoopback = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]+)?\/?$/i.test(url);
	if (
		(serviceUrl.protocol !== "https:" && !(serviceUrl.protocol === "http:" && literalHttpLoopback)) ||
		serviceUrl.username ||
		serviceUrl.password ||
		serviceUrl.search ||
		serviceUrl.hash ||
		(serviceUrl.pathname !== "" && serviceUrl.pathname !== "/")
	) {
		throw new Error("POOF_URL must be an HTTPS origin or a literal HTTP loopback origin for service authentication.");
	}
	return { url: serviceUrl.origin, auth: { type: "service", clientId, clientSecret } };
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
async function requestOnce(
	cfg: PoofConfig,
	runtime: ApiRuntime,
	method: HttpMethod,
	path: string,
	body: FormData | object | undefined,
	forceRefresh = false,
): Promise<Response> {
	const headers: Record<string, string> = {};
	if (cfg.auth.type === "service") {
		headers["CF-Access-Client-Id"] = cfg.auth.clientId;
		headers["CF-Access-Client-Secret"] = cfg.auth.clientSecret;
	} else {
		headers.Authorization = `Bearer ${await runtime.oauthAccessToken(cfg.url, forceRefresh)}`;
	}
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
	return runtime.fetch(`${cfg.url}${path}`, { method, headers, body: payload, redirect: "manual" });
}

function oauthRejection(res: Response): boolean {
	return res.status === 401 && /^Bearer\b/i.test(res.headers.get("www-authenticate")?.trim() ?? "");
}

function isSafeMethod(method: HttpMethod): boolean {
	return method === "GET" || method === "HEAD";
}

async function request(
	cfg: PoofConfig,
	method: HttpMethod,
	path: string,
	body?: FormData | object,
	runtime: ApiRuntime = defaultApiRuntime,
): Promise<Response> {
	let res = await requestOnce(cfg, runtime, method, path, body);
	if (cfg.auth.type === "oauth" && oauthRejection(res)) {
		await res.body?.cancel().catch(() => undefined);
		if (isSafeMethod(method)) {
			res = await requestOnce(cfg, runtime, method, path, body, true);
		} else {
			await runtime.oauthAccessToken(cfg.url, true);
			throw new Error(`${method} ${path} was rejected before execution. OAuth was refreshed; rerun the command.`);
		}
	}

	if (!res.ok) {
		if (res.status >= 300 && res.status < 400) {
			if (cfg.auth.type === "service") {
				throw new Error(
					"Cloudflare Access redirected a service request. Check the service pair and Service Auth policy.",
				);
			}
			throw new Error("Cloudflare Access redirected to browser login. Enable Managed OAuth on the owner application.");
		}
		if (res.status === 401) {
			if (cfg.auth.type === "service") {
				throw new Error(
					`Service authentication failed for ${cfg.url}. Check the credential pair and Service Auth policy.`,
				);
			}
			throw new Error(`OAuth authentication failed for ${cfg.url}. Run 'poof login'.`);
		}
		if (res.status === 403) {
			if (cfg.auth.type === "service") {
				throw new Error(`Service authentication was denied for ${cfg.url}. Check the Service Auth policy.`);
			}
			throw new Error(`OAuth access was denied for ${cfg.url}. Check the owner identity and Access policy.`);
		}
		if (res.status === 503) throw new Error(`Poof Access configuration is unavailable at ${cfg.url}.`);
		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.toLowerCase().includes("text/html")) {
			throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}`);
		}
		const text = (await res.text().catch(() => "")).slice(0, 4096);
		throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}` + (text ? `\n${text}` : ""));
	}

	return res;
}

/** Perform an authenticated JSON API request. 204s resolve to undefined. */
export async function api<T>(
	cfg: PoofConfig,
	method: HttpMethod,
	path: string,
	body?: FormData | object,
	runtime: ApiRuntime = defaultApiRuntime,
): Promise<T> {
	const res = await request(cfg, method, path, body, runtime);
	if (res.status === 204) {
		return undefined as T;
	}
	return (await res.json()) as T;
}

/** Authenticate against the API without decoding a response body. */
export async function apiCheck(cfg: PoofConfig, runtime: ApiRuntime = defaultApiRuntime): Promise<void> {
	const res = await request(cfg, "GET", "/api/documents", undefined, runtime);
	await res.body?.cancel();
}

/**
 * Perform the same request and return the undecoded body stream. Documents can
 * reach 10 MiB, so `poof cat big > out.html` must not buffer the full response.
 * Returns null when the server sends no body.
 */
export async function apiStream(
	cfg: PoofConfig,
	method: HttpMethod,
	path: string,
	runtime: ApiRuntime = defaultApiRuntime,
): Promise<ReadableStream | null> {
	const res = await request(cfg, method, path, undefined, runtime);
	return res.body;
}
