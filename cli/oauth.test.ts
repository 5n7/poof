import { describe, expect, test } from "bun:test";

import {
	canonicalResource,
	discoverOAuth,
	defaultCallbackListener,
	exchangeCode,
	pkce,
	parseCallbackRequest,
	refreshGrant,
	registerClient,
	revokeGrant,
	sameOAuthDiscovery,
	sameOAuthRegistration,
	type CallbackConfig,
	type CallbackServe,
	type DiscoveredOAuth,
	type OAuthRegistration,
	validateOAuthRegistration,
} from "./oauth";

const RESOURCE = "https://poof.example";
const ISSUER = "https://team.cloudflareaccess.com";

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return Response.json(value, { status, headers });
}

function discoveryFetch(
	overrides: { resource?: Record<string, unknown>; server?: Record<string, unknown> } = {},
): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		if (url === `${RESOURCE}/`) {
			return new Response(null, {
				status: 401,
				headers: { "WWW-Authenticate": `Bearer realm="OAuth", resource_metadata="${RESOURCE}/.well-known/resource"` },
			});
		}
		if (url === `${RESOURCE}/.well-known/resource`) {
			return json({ resource: `${RESOURCE}/`, authorization_servers: [ISSUER], ...overrides.resource });
		}
		if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
			return json({
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				revocation_endpoint: `${ISSUER}/revoke`,
				registration_endpoint: `${ISSUER}/register`,
				grant_types_supported: ["authorization_code", "refresh_token"],
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				...overrides.server,
			});
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as unknown as typeof fetch;
}

const DISCOVERY: DiscoveredOAuth = {
	resource: RESOURCE,
	issuer: ISSUER,
	authorizationEndpoint: `${ISSUER}/authorize`,
	tokenEndpoint: `${ISSUER}/token`,
	revocationEndpoint: `${ISSUER}/revoke`,
	registrationEndpoint: `${ISSUER}/register`,
};

const REGISTRATION: OAuthRegistration = {
	...DISCOVERY,
	clientId: "client-id",
	callbackPort: 45678,
	callbackPath: "/oauth/callback/random",
};

describe("canonicalResource", () => {
	test("normalizes an HTTPS origin", () => {
		expect(canonicalResource("https://POOF.example:443/")).toBe(RESOURCE);
	});

	test("rejects insecure URLs and URL components", () => {
		for (const value of ["http://poof.example", "https://poof.example/api", "https://user@poof.example", "nope"]) {
			expect(() => canonicalResource(value)).toThrow();
		}
	});
});

describe("registration validation and comparison", () => {
	test("validates persisted registrations with the discovery URL rules", () => {
		expect(validateOAuthRegistration(REGISTRATION, RESOURCE)).toEqual(REGISTRATION);
		expect(
			validateOAuthRegistration({ ...REGISTRATION, tokenEndpoint: "https://evil.example/token" }, RESOURCE),
		).toBeNull();
		expect(validateOAuthRegistration({ ...REGISTRATION, callbackPath: "/other" }, RESOURCE)).toBeNull();
	});

	test("compares discovery fields before registration identity", () => {
		expect(sameOAuthDiscovery(REGISTRATION, DISCOVERY)).toBe(true);
		expect(sameOAuthDiscovery(REGISTRATION, { ...DISCOVERY, tokenEndpoint: `${ISSUER}/other` })).toBe(false);
		expect(sameOAuthRegistration(REGISTRATION, { ...REGISTRATION })).toBe(true);
		expect(sameOAuthRegistration(REGISTRATION, { ...REGISTRATION, clientId: "other" })).toBe(false);
	});
});

describe("discovery", () => {
	test("follows the same-origin protected-resource chain without redirects", async () => {
		const urls: string[] = [];
		const requests: RequestInit[] = [];
		const baseFetch = discoveryFetch();
		const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
			urls.push(String(input));
			requests.push(init ?? {});
			return baseFetch(input, init);
		}) as typeof fetch;
		const found = await discoverOAuth(RESOURCE, { fetch: fetcher });
		expect(found).toEqual(DISCOVERY);
		expect(urls[0]).toBe(`${RESOURCE}/`);
		expect(requests).toHaveLength(3);
		for (const request of requests) {
			expect(request.redirect).toBe("manual");
			expect(request.signal).toBeInstanceOf(AbortSignal);
		}
	});

	test("rejects a path-valued protected resource", async () => {
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ resource: { resource: `${RESOURCE}/api/documents` } }),
			}),
		).rejects.toThrow("POOF_URL must contain only an HTTPS origin");
	});

	test("rejects cross-origin resource metadata", async () => {
		const fetcher = (async (input: string | URL | Request) => {
			if (String(input) === `${RESOURCE}/`) {
				return new Response(null, {
					status: 401,
					headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://evil.example/meta"' },
				});
			}
			throw new Error("must not fetch attacker metadata");
		}) as typeof fetch;
		await expect(discoverOAuth(RESOURCE, { fetch: fetcher })).rejects.toThrow("must be served by POOF_URL");
	});

	test("requires refresh tokens, public clients, and S256", async () => {
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ server: { grant_types_supported: ["authorization_code"] } }),
			}),
		).rejects.toThrow("refresh_token");
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ server: { token_endpoint_auth_methods_supported: ["client_secret_basic"] } }),
			}),
		).rejects.toThrow("public clients");
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ server: { code_challenge_methods_supported: ["plain"] } }),
			}),
		).rejects.toThrow("S256");
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ server: { response_types_supported: ["token"] } }),
			}),
		).rejects.toThrow("code response type");
	});

	test("rejects non-origin issuers and cross-origin endpoints", async () => {
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ resource: { authorization_servers: [`${ISSUER}/tenant`] } }),
			}),
		).rejects.toThrow("only an HTTPS origin");
		await expect(
			discoverOAuth(RESOURCE, {
				fetch: discoveryFetch({ server: { token_endpoint: "https://evil.example/token" } }),
			}),
		).rejects.toThrow("issuer origin");
	});
});

test("dynamic registration pins the resource and exact loopback callback", async () => {
	let request: Request | undefined;
	let requestInit: RequestInit | undefined;
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		requestInit = init;
		request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		return json({
			client_id: "client-id",
			redirect_uris: ["http://127.0.0.1:45678/oauth/callback/random"],
			token_endpoint_auth_method: "none",
		});
	}) as unknown as typeof fetch;
	const registered = await registerClient(DISCOVERY, 45678, "/oauth/callback/random", { fetch: fetcher });
	expect(registered.clientId).toBe("client-id");
	expect(requestInit?.redirect).toBe("manual");
	expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
	expect(await request?.json()).toEqual({
		redirect_uris: ["http://127.0.0.1:45678/oauth/callback/random"],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code"],
		response_types: ["code"],
		resource: RESOURCE,
	});
});

test("dynamic registration rejects a client secret", async () => {
	const fetcher = (async () =>
		json({
			client_id: "client-id",
			client_secret: "must-not-exist",
			redirect_uris: ["http://127.0.0.1:45678/oauth/callback/random"],
			token_endpoint_auth_method: "none",
		})) as unknown as typeof fetch;
	await expect(registerClient(DISCOVERY, 45678, "/oauth/callback/random", { fetch: fetcher })).rejects.toThrow(
		"client secret",
	);
});

test("PKCE produces an alphanumeric-leading S256 challenge", () => {
	const result = pkce({ randomUrlSafe: () => "a".repeat(43) });
	expect(result.verifier).toBe("a".repeat(43));
	expect(result.challenge).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]+$/);
});

describe("tokens", () => {
	test("exchanges and refreshes without losing an unrotated refresh token", async () => {
		const responses = [
			json({
				access_token: "access-1",
				refresh_token: "refresh-1",
				token_type: "bearer",
				expires_in: 900,
			}),
			json({ access_token: "access-2", token_type: "Bearer", expires_in: 900, resource: `${RESOURCE}/` }),
		];
		const requests: Request[] = [];
		const inits: RequestInit[] = [];
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			inits.push(init ?? {});
			requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
			return responses.shift()!;
		}) as unknown as typeof fetch;
		const first = await exchangeCode(REGISTRATION, "http://127.0.0.1:45678/oauth/callback/random", "code", "verifier", {
			fetch: fetcher,
			now: () => 1_000,
		});
		const second = await refreshGrant(REGISTRATION, first, { fetch: fetcher, now: () => 2_000 });
		expect(first).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: 901_000 });
		expect(second.refreshToken).toBe("refresh-1");
		expect(new URLSearchParams(await requests[0].text()).get("resource")).toBe(RESOURCE);
		expect(new URLSearchParams(await requests[1].text()).get("resource")).toBe(RESOURCE);
		for (const init of inits) {
			expect(init.redirect).toBe("manual");
			expect(init.signal).toBeInstanceOf(AbortSignal);
		}
	});

	test("rejects a token for another resource", async () => {
		const fetcher = (async () =>
			json({
				access_token: "secret",
				refresh_token: "refresh",
				token_type: "bearer",
				expires_in: 900,
				resource: "https://other.example",
			})) as unknown as typeof fetch;
		await expect(
			exchangeCode(REGISTRATION, "http://127.0.0.1:45678/oauth/callback/random", "code", "verifier", {
				fetch: fetcher,
				now: () => 0,
			}),
		).rejects.toThrow("different resource");
	});

	test("rejects a malformed token resource", async () => {
		const fetcher = (async () =>
			json({
				access_token: "secret",
				refresh_token: "refresh",
				token_type: "bearer",
				expires_in: 900,
				resource: "not a URL",
			})) as unknown as typeof fetch;
		await expect(
			exchangeCode(REGISTRATION, "http://127.0.0.1:45678/oauth/callback/random", "code", "verifier", {
				fetch: fetcher,
				now: () => 0,
			}),
		).rejects.toThrow("invalid resource");
	});

	test("redacts control characters in OAuth errors", async () => {
		const fetcher = (async () =>
			json(
				{ error: "invalid_grant\nTOKEN", error_description: "bad\u202ere\u200bquest\u0000" },
				400,
			)) as unknown as typeof fetch;
		await expect(
			refreshGrant(
				REGISTRATION,
				{ accessToken: "a", refreshToken: "r", expiresAt: 0 },
				{
					fetch: fetcher,
					now: () => 0,
				},
			),
		).rejects.toThrow("invalid_grantTOKEN: badrequest");
	});

	test("revocation uses a bounded non-redirecting request", async () => {
		let init: RequestInit | undefined;
		const fetcher = (async (_input: string | URL | Request, requestInit?: RequestInit) => {
			init = requestInit;
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		await revokeGrant(REGISTRATION, { accessToken: "a", refreshToken: "r", expiresAt: 0 }, { fetch: fetcher });
		expect(init?.redirect).toBe("manual");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("callback validation", () => {
	const config: CallbackConfig = {
		port: 49123,
		path: "/oauth/callback/exact",
		state: "state",
		timeoutMs: 1_000,
	};
	const callback = (query: string, overrides: { authority?: string; method?: string; path?: string } = {}) =>
		parseCallbackRequest(
			new Request(
				`http://${overrides.authority ?? `127.0.0.1:${config.port}`}${overrides.path ?? config.path}?${query}`,
				{ method: overrides.method },
			),
			config,
		);

	test("accepts only the exact authority, method, path, and state", () => {
		expect(callback("state=state&code=no", { path: "/wrong" }).response.status).toBe(404);
		expect(callback("state=state&code=no", { authority: `localhost:${config.port}` }).response.status).toBe(404);
		expect(callback("state=state&code=no", { authority: "127.0.0.1:49124" }).response.status).toBe(404);
		expect(callback("state=state&code=no", { method: "POST" }).response.status).toBe(404);
		expect(callback("state=wrong&code=no").response.status).toBe(400);
		const parsed = callback("state=state&code=yes");
		expect(parsed.response.status).toBe(200);
		expect(parsed.result).toEqual({ type: "success", code: "yes", issuer: undefined });
		expect(parsed.response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(parsed.response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("rejects duplicate and ambiguous parameters without producing a result", () => {
		for (const query of [
			"state=state&state=state&code=yes",
			"state=state&code=yes&code=again",
			"state=state&error=no&error=again",
			"state=state&code=yes&iss=a&iss=b",
			"state=state&error=no&error_description=a&error_description=b",
			"state=state",
			"state=state&code=yes&error=no",
			"state=state&code=yes&error_description=no",
			"state=state&code=yes&iss=",
			"state=state&code=",
			"state=state&error=",
		]) {
			const parsed = callback(query);
			expect(parsed.response.status).toBe(400);
			expect(parsed.result).toBeUndefined();
		}
	});

	test("accepts exactly one OAuth error", () => {
		const parsed = callback("state=state&error=access_denied&error_description=no");
		expect(parsed.response.status).toBe(200);
		expect(parsed.result).toEqual({
			type: "error",
			error: "access_denied",
			errorDescription: "no",
			issuer: undefined,
		});
	});

	test("delegates fresh port 0 and validates against the assigned server port", async () => {
		let options: Parameters<CallbackServe>[0] | undefined;
		let stoppedWith: boolean | undefined;
		const serve: CallbackServe = (value) => {
			options = value;
			return {
				port: 52345,
				stop: (force) => {
					stoppedWith = force;
				},
			};
		};
		const listener = defaultCallbackListener({ ...config, port: 0 }, serve);
		expect(options?.port).toBe(0);
		expect(listener.port).toBe(52345);
		const response = options?.fetch(new Request("http://127.0.0.1:52345/oauth/callback/exact?state=state&code=yes"));
		expect(response?.status).toBe(200);
		expect(await listener.wait()).toEqual({ type: "success", code: "yes", issuer: undefined });
		expect(stoppedWith).toBe(false);
	});
});
