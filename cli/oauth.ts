import { createHash, randomBytes } from "node:crypto";

export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const OAUTH_HTTP_TIMEOUT_MS = 15_000;

export interface OAuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export interface DiscoveredOAuth {
	resource: string;
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	revocationEndpoint: string | null;
	registrationEndpoint: string;
}

export interface OAuthRegistration extends DiscoveredOAuth {
	clientId: string;
	callbackPort: number;
	callbackPath: string;
}

export type CallbackResult =
	| { type: "success"; code: string; issuer?: string }
	| { type: "error"; error: string; errorDescription?: string; issuer?: string };

export interface CallbackConfig {
	port: number;
	path: string;
	state: string;
	timeoutMs: number;
}

export interface CallbackListener {
	port: number;
	wait(): Promise<CallbackResult>;
	close(): void;
}

export interface CallbackServer {
	port?: number;
	stop(force: boolean): void;
}

export type CallbackServe = (options: {
	hostname: "127.0.0.1";
	port: number;
	fetch(req: Request): Response;
}) => CallbackServer;

export interface OAuthRuntime {
	fetch: typeof fetch;
	now(): number;
	randomUrlSafe(bytes: number): string;
	listen(config: CallbackConfig): CallbackListener;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned invalid JSON.`);
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value === "") throw new Error(`${label} is missing.`);
	return value;
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${label} is missing or invalid.`);
	}
	return value;
}

function httpsUrl(value: unknown, label: string, origin?: string): string {
	const raw = requireString(value, label);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`${label} is not a valid URL.`);
	}
	if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
	if (url.username || url.password || url.hash) throw new Error(`${label} contains forbidden URL components.`);
	if (origin && url.origin !== origin) throw new Error(`${label} must use the OAuth issuer origin.`);
	return url.href;
}

function issuerOrigin(value: unknown, label: string): string {
	const url = new URL(httpsUrl(value, label));
	if (url.pathname !== "/" || url.search || url.hash) {
		throw new Error(`${label} must contain only an HTTPS origin.`);
	}
	return url.origin;
}

function timedFetch(
	runtime: Pick<OAuthRuntime, "fetch">,
	input: string | URL | Request,
	init: RequestInit = {},
): Promise<Response> {
	return runtime.fetch(input, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(OAUTH_HTTP_TIMEOUT_MS),
	});
}

async function jsonResponse(res: Response, label: string): Promise<Record<string, unknown>> {
	if (!res.ok) throw new Error(`${label} failed with HTTP ${res.status}.`);
	const contentType = res.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) throw new Error(`${label} did not return JSON.`);
	return requireObject(await res.json().catch(() => null), label);
}

/** Normalize the configured deployment to the exact OAuth resource origin. */
export function canonicalResource(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("POOF_URL must be an absolute HTTPS URL.");
	}
	if (url.protocol !== "https:") throw new Error("POOF_URL must use HTTPS for Managed OAuth.");
	if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
		throw new Error("POOF_URL must contain only an HTTPS origin, without credentials, a path, query, or fragment.");
	}
	return url.origin;
}

export function validateOAuthRegistration(value: unknown, resource: string): OAuthRegistration | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const registration = value as Partial<OAuthRegistration>;
	if (
		registration.resource !== resource ||
		typeof registration.issuer !== "string" ||
		typeof registration.authorizationEndpoint !== "string" ||
		typeof registration.tokenEndpoint !== "string" ||
		!(typeof registration.revocationEndpoint === "string" || registration.revocationEndpoint === null) ||
		typeof registration.registrationEndpoint !== "string" ||
		typeof registration.clientId !== "string" ||
		registration.clientId === "" ||
		typeof registration.callbackPort !== "number" ||
		!Number.isInteger(registration.callbackPort) ||
		registration.callbackPort < 1 ||
		registration.callbackPort > 65535 ||
		typeof registration.callbackPath !== "string" ||
		!/^\/oauth\/callback\/[A-Za-z0-9_-]+$/.test(registration.callbackPath)
	) {
		return null;
	}

	try {
		if (canonicalResource(registration.resource) !== resource) return null;
		const issuer = issuerOrigin(registration.issuer, "OAuth issuer");
		if (issuer !== registration.issuer) return null;
		for (const [endpoint, label] of [
			[registration.authorizationEndpoint, "OAuth authorization endpoint"],
			[registration.tokenEndpoint, "OAuth token endpoint"],
			[registration.registrationEndpoint, "OAuth registration endpoint"],
			...(registration.revocationEndpoint
				? ([[registration.revocationEndpoint, "OAuth revocation endpoint"]] as const)
				: []),
		] as const) {
			httpsUrl(endpoint, label, issuer);
		}
	} catch {
		return null;
	}

	return registration as OAuthRegistration;
}

export function sameOAuthDiscovery(left: DiscoveredOAuth, right: DiscoveredOAuth): boolean {
	return (
		left.resource === right.resource &&
		left.issuer === right.issuer &&
		left.authorizationEndpoint === right.authorizationEndpoint &&
		left.tokenEndpoint === right.tokenEndpoint &&
		left.revocationEndpoint === right.revocationEndpoint &&
		left.registrationEndpoint === right.registrationEndpoint
	);
}

export function sameOAuthRegistration(left: OAuthRegistration, right: OAuthRegistration): boolean {
	return (
		sameOAuthDiscovery(left, right) &&
		left.clientId === right.clientId &&
		left.callbackPort === right.callbackPort &&
		left.callbackPath === right.callbackPath
	);
}

function resourceMetadataUrl(header: string | null, resource: string): string {
	if (!header || !/^Bearer\b/i.test(header.trim())) {
		throw new Error("Cloudflare Access did not advertise Managed OAuth. Enable it on the owner application.");
	}
	const match = /(?:^|,)\s*resource_metadata\s*=\s*"([^"]+)"/i.exec(header.replace(/^Bearer\s*/i, ""));
	if (!match) throw new Error("Cloudflare Access did not provide OAuth resource metadata.");
	const url = httpsUrl(match[1], "OAuth resource metadata URL");
	if (new URL(url).origin !== resource) throw new Error("OAuth resource metadata must be served by POOF_URL.");
	return url;
}

/** Discover and validate Cloudflare Access Managed OAuth without following redirects. */
export async function discoverOAuth(resource: string, runtime: Pick<OAuthRuntime, "fetch">): Promise<DiscoveredOAuth> {
	const probe = await timedFetch(runtime, `${resource}/`, {
		headers: { Accept: "application/json" },
	});
	if (probe.status !== 401) {
		throw new Error(
			`Managed OAuth discovery expected HTTP 401 from the protected owner root, received ${probe.status}.`,
		);
	}

	const metadataUrl = resourceMetadataUrl(probe.headers.get("www-authenticate"), resource);
	const protectedResource = await jsonResponse(
		await timedFetch(runtime, metadataUrl, { headers: { Accept: "application/json" } }),
		"OAuth resource metadata",
	);
	if (canonicalResource(requireString(protectedResource.resource, "OAuth resource")) !== resource) {
		throw new Error("OAuth resource metadata names a different resource.");
	}
	const authorizationServers = requireStringArray(
		protectedResource.authorization_servers,
		"OAuth authorization servers",
	);
	if (authorizationServers.length !== 1)
		throw new Error("OAuth resource metadata must advertise exactly one authorization server.");
	const issuer = issuerOrigin(authorizationServers[0], "OAuth issuer");
	const issuerUrl = new URL(issuer);

	const serverMetadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
	const server = await jsonResponse(
		await timedFetch(runtime, serverMetadataUrl, { headers: { Accept: "application/json" } }),
		"OAuth authorization server metadata",
	);
	const advertisedIssuer = issuerOrigin(server.issuer, "OAuth metadata issuer");
	if (advertisedIssuer !== issuer) throw new Error("OAuth authorization server metadata has an issuer mismatch.");
	const grantTypes = requireStringArray(server.grant_types_supported, "OAuth grant types");
	if (!grantTypes.includes("authorization_code") || !grantTypes.includes("refresh_token")) {
		throw new Error("OAuth server must support authorization_code and refresh_token grants.");
	}
	if (!requireStringArray(server.code_challenge_methods_supported, "OAuth PKCE methods").includes("S256")) {
		throw new Error("OAuth server must support PKCE S256.");
	}
	if (!requireStringArray(server.response_types_supported, "OAuth response types").includes("code")) {
		throw new Error("OAuth server must support the code response type.");
	}
	if (
		!requireStringArray(
			server.token_endpoint_auth_methods_supported,
			"OAuth token endpoint authentication methods",
		).includes("none")
	) {
		throw new Error("OAuth server must support public clients.");
	}

	return {
		resource,
		issuer,
		authorizationEndpoint: httpsUrl(server.authorization_endpoint, "OAuth authorization endpoint", issuerUrl.origin),
		tokenEndpoint: httpsUrl(server.token_endpoint, "OAuth token endpoint", issuerUrl.origin),
		revocationEndpoint:
			server.revocation_endpoint === undefined
				? null
				: httpsUrl(server.revocation_endpoint, "OAuth revocation endpoint", issuerUrl.origin),
		registrationEndpoint: httpsUrl(server.registration_endpoint, "OAuth registration endpoint", issuerUrl.origin),
	};
}

export async function registerClient(
	discovery: DiscoveredOAuth,
	callbackPort: number,
	callbackPath: string,
	runtime: Pick<OAuthRuntime, "fetch">,
): Promise<OAuthRegistration> {
	const redirectUri = `http://127.0.0.1:${callbackPort}${callbackPath}`;
	const res = await timedFetch(runtime, discovery.registrationEndpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code"],
			response_types: ["code"],
			resource: discovery.resource,
		}),
	});
	const body = await jsonResponse(res, "OAuth dynamic client registration");
	const clientId = requireString(body.client_id, "OAuth client_id");
	if (body.token_endpoint_auth_method !== "none") throw new Error("OAuth server did not register a public client.");
	if (body.client_secret !== undefined) throw new Error("OAuth server returned a client secret for a public client.");
	const redirects = requireStringArray(body.redirect_uris, "OAuth registered redirect URIs");
	if (redirects.length !== 1 || redirects[0] !== redirectUri) {
		throw new Error("OAuth server registered a different callback URI.");
	}
	return { ...discovery, clientId, callbackPort, callbackPath };
}

export function pkce(runtime: Pick<OAuthRuntime, "randomUrlSafe">): { verifier: string; challenge: string } {
	for (;;) {
		const verifier = runtime.randomUrlSafe(32);
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		if (/^[A-Za-z0-9]/.test(challenge)) return { verifier, challenge };
	}
}

export function authorizationUrl(
	registration: OAuthRegistration,
	redirectUri: string,
	state: string,
	challenge: string,
): string {
	const url = new URL(registration.authorizationEndpoint);
	url.searchParams.set("client_id", registration.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("resource", registration.resource);
	return url.href;
}

export function oauthProtocolError(codeValue: unknown, descriptionValue: unknown, fallback: string): Error {
	const code = typeof codeValue === "string" ? codeValue.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) : "";
	const description =
		typeof descriptionValue === "string" ? descriptionValue.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 240) : "";
	return new Error([code || fallback, description].filter(Boolean).join(": "));
}

async function tokenJson(res: Response, label: string): Promise<Record<string, unknown>> {
	const body = requireObject(await res.json().catch(() => null), label);
	if (!res.ok) throw oauthProtocolError(body.error, body.error_description, `${label} failed`);
	return body;
}

function readTokens(
	body: Record<string, unknown>,
	now: number,
	resource: string,
	previousRefreshToken?: string,
): OAuthTokens {
	const accessToken = requireString(body.access_token, "OAuth access token");
	const refreshToken =
		body.refresh_token === undefined ? previousRefreshToken : requireString(body.refresh_token, "OAuth refresh token");
	if (!refreshToken) throw new Error("OAuth token response has no refresh token.");
	if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
		throw new Error("OAuth token response has an unsupported token type.");
	}
	if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
		throw new Error("OAuth token response has an invalid expiry.");
	}
	if (body.resource !== undefined) {
		let returnedResource: string;
		try {
			returnedResource = canonicalResource(requireString(body.resource, "OAuth token resource"));
		} catch (error) {
			throw new Error("OAuth token response has an invalid resource.", { cause: error });
		}
		if (returnedResource !== resource) throw new Error("OAuth token response names a different resource.");
	}
	return { accessToken, refreshToken, expiresAt: now + body.expires_in * 1000 };
}

export async function exchangeCode(
	registration: OAuthRegistration,
	redirectUri: string,
	code: string,
	verifier: string,
	runtime: Pick<OAuthRuntime, "fetch" | "now">,
): Promise<OAuthTokens> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		client_id: registration.clientId,
		redirect_uri: redirectUri,
		code_verifier: verifier,
		resource: registration.resource,
	});
	const res = await timedFetch(runtime, registration.tokenEndpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	return readTokens(await tokenJson(res, "OAuth code exchange"), runtime.now(), registration.resource);
}

export async function refreshGrant(
	registration: OAuthRegistration,
	tokens: OAuthTokens,
	runtime: Pick<OAuthRuntime, "fetch" | "now">,
): Promise<OAuthTokens> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: tokens.refreshToken,
		client_id: registration.clientId,
		resource: registration.resource,
	});
	const res = await timedFetch(runtime, registration.tokenEndpoint, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	return readTokens(
		await tokenJson(res, "OAuth token refresh"),
		runtime.now(),
		registration.resource,
		tokens.refreshToken,
	);
}

export async function revokeGrant(
	registration: OAuthRegistration,
	tokens: OAuthTokens,
	runtime: Pick<OAuthRuntime, "fetch">,
): Promise<void> {
	if (!registration.revocationEndpoint) throw new Error("OAuth server does not advertise token revocation.");
	const res = await timedFetch(runtime, registration.revocationEndpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			token: tokens.refreshToken,
			token_type_hint: "refresh_token",
			client_id: registration.clientId,
		}),
	});
	if (!res.ok) throw new Error(`OAuth token revocation failed with HTTP ${res.status}.`);
}

const CALLBACK_SECURITY_HEADERS = Object.freeze({
	"Cache-Control": "no-store",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
});

function callbackHtml(message: string): Response {
	return new Response(`<!doctype html><meta charset="utf-8"><title>poof</title><p>${message}</p>`, {
		headers: {
			...CALLBACK_SECURITY_HEADERS,
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'none'; img-src 'none'",
		},
	});
}

function callbackError(message: string, status: number): { response: Response } {
	return {
		response: new Response(message, {
			status,
			headers: {
				...CALLBACK_SECURITY_HEADERS,
				"Content-Type": "text/plain; charset=utf-8",
			},
		}),
	};
}

export function parseCallbackRequest(
	req: Request,
	config: CallbackConfig,
): { response: Response; result?: CallbackResult } {
	const url = new URL(req.url);
	if (
		url.protocol !== "http:" ||
		url.host !== `127.0.0.1:${config.port}` ||
		url.username ||
		url.password ||
		req.method !== "GET" ||
		url.pathname !== config.path
	)
		return callbackError("Not Found", 404);
	const one = (name: string): string | undefined | null => {
		const values = url.searchParams.getAll(name);
		return values.length > 1 ? null : values[0];
	};
	const returnedState = one("state");
	const code = one("code");
	const error = one("error");
	const errorDescription = one("error_description");
	const issuer = one("iss");
	if (returnedState === null || code === null || error === null || errorDescription === null || issuer === null) {
		return callbackError("Duplicate OAuth parameters", 400);
	}
	if (returnedState !== config.state) return callbackError("Invalid OAuth state", 400);
	if ((code === undefined) === (error === undefined) || code === "" || error === "") {
		return callbackError("OAuth callback must contain exactly one code or error", 400);
	}
	if (issuer === "" || (code !== undefined && errorDescription !== undefined)) {
		return callbackError("Invalid OAuth callback parameters", 400);
	}
	let result: CallbackResult;
	if (code !== undefined) {
		result = { type: "success", code, issuer };
	} else if (error !== undefined) {
		result = { type: "error", error, errorDescription, issuer };
	} else {
		return callbackError("OAuth callback must contain exactly one code or error", 400);
	}
	return {
		result,
		response: callbackHtml(
			result.type === "error"
				? "Authorization failed. Return to the terminal."
				: "Authorization complete. Return to the terminal.",
		),
	};
}

export function defaultCallbackListener(
	config: CallbackConfig,
	serve: CallbackServe = (options) => Bun.serve(options),
): CallbackListener {
	let settle: ((result: CallbackResult) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	const result = new Promise<CallbackResult>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	let server: CallbackServer | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let closed = false;
	const close = (force: boolean): void => {
		if (closed) return;
		closed = true;
		if (timeout) clearTimeout(timeout);
		server?.stop(force);
	};
	const fetchCallback = (req: Request): Response => {
		const parsed = parseCallbackRequest(req, { ...config, port: server!.port! });
		if (parsed.result) {
			close(false);
			settle?.(parsed.result);
		}
		return parsed.response;
	};
	server = serve({ hostname: "127.0.0.1", port: config.port, fetch: fetchCallback });
	timeout = setTimeout(() => {
		close(true);
		fail?.(new Error("OAuth login timed out after five minutes."));
	}, config.timeoutMs);
	return {
		port: server.port!,
		wait: () => result,
		close: () => close(true),
	};
}

export const defaultOAuthRuntime: OAuthRuntime = {
	fetch,
	now: () => Date.now(),
	randomUrlSafe: (bytes) => randomBytes(bytes).toString("base64url"),
	listen: defaultCallbackListener,
};
