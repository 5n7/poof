import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { sign } from "hono/jwt";
import type { HonoJsonWebKey, JWTPayload } from "hono/utils/jwt/types";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { nowSeconds } from "../src/lib/time";
import { MCP_BASE, MCP_CALL, envWith } from "./helpers";

const BASE = "https://poof.5n7.me";

// Must match ACCESS_TEAM_DOMAIN, ACCESS_AUD, and ACCESS_MCP_AUD in
// vitest.config.ts. The issuer is the team domain with an `https://` scheme and
// no trailing slash, which is the shape Cloudflare documents.
const TEAM_DOMAIN = "t.example";
const ISS = `https://${TEAM_DOMAIN}`;
const CERTS_URL = `${ISS}/cdn-cgi/access/certs`;
const OWNER_AUD = "test-owner-aud";
const MCP_AUD = "test-mcp-aud";

const KID = "poof-test-key";

interface KeyPair {
	privateJwk: HonoJsonWebKey;
	publicJwk: HonoJsonWebKey;
}

/**
 * An RSA-SHA256 key pair as JWKs, tagged with `alg` and `kid` so `hono/jwt`
 * writes a `kid` into the header it signs and finds the matching key in the
 * JWKS. A bare `CryptoKey` produces a header with no `kid`, which
 * `verifyWithJwks` rejects before it looks at anything else.
 */
async function keyPair(): Promise<KeyPair> {
	// Both `generateKey` and `exportKey` are typed as unions over their
	// overloads. RSA always yields a pair, and "jwk" always yields the object.
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const asJwk = async (key: CryptoKey): Promise<HonoJsonWebKey> => ({
		...((await crypto.subtle.exportKey("jwk", key)) as JsonWebKey),
		alg: "RS256",
		kid: KID,
	});

	return { privateJwk: await asJwk(pair.privateKey), publicJwk: await asJwk(pair.publicKey) };
}

/**
 * Sign claims with a team key.
 *
 * `JWTPayload` types `exp` and `iat` as optional *numbers*, and the tests here
 * deliberately build payloads with those keys removed or replaced, which an
 * index signature alone will not describe. The widening lives here so no test
 * body has to carry it.
 */
function signAs(claims: Record<string, unknown>, key: HonoJsonWebKey): Promise<string> {
	return sign(claims as JWTPayload, key);
}

// The team's real key, and a second one with the same `kid` used to forge a
// signature the JWKS cannot verify.
let team: KeyPair;
let forger: KeyPair;

beforeAll(async () => {
	[team, forger] = await Promise.all([keyPair(), keyPair()]);
});

/**
 * Serve the team's public key at its JWKS endpoint for every test.
 *
 * The Worker under test shares this isolate, so stubbing the global `fetch`
 * reaches `verifyWithJwks` inside the middleware. Everything else is handed to
 * the original `fetch`, which is what keeps the D1 and R2 bindings working.
 *
 * Every test wants the same JWKS, including the forgery test, which serves the
 * real key and signs with another. Installing it here rather than per test
 * leaves no way to write a new test that forgets to.
 */
beforeEach(() => {
	const real = globalThis.fetch;
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === CERTS_URL) return Promise.resolve(Response.json({ keys: [team.publicJwk] }));
		return real(input as RequestInfo, init);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The identity payload Cloudflare documents for an interactive login. */
function identityClaims(aud: string, now: number): Record<string, unknown> {
	return {
		aud: [aud],
		country: "US",
		email: "owner@example.com",
		exp: now + 600,
		iat: now,
		identity_nonce: "6ei69kawdKzMIAPF",
		iss: ISS,
		nbf: now,
		sub: "7335d417-61da-459d-899c-0a01c76a2f94",
		type: "app",
	};
}

/**
 * The service-token payload Cloudflare documents. It carries no `nbf`, no
 * `email`, and an empty `sub`. Owner routes accept it; MCP rejects it.
 */
function serviceClaims(aud: string, now: number): Record<string, unknown> {
	return {
		aud: [aud],
		common_name: "e367826f93b8d71185e03fe518aff3b4.access",
		exp: now + 600,
		iat: now,
		iss: ISS,
		sub: "",
		type: "app",
	};
}

/** Encode a JWT whose signature is never reached, for header-only rejections. */
function tokenWithHeader(header: object, claims: object): string {
	const part = (o: object) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	return `${part(header)}.${part(claims)}.c2lnbmF0dXJl`;
}

/**
 * Send a request carrying `token`, with Access enforcement switched on and
 * `overrides` applied on top of the shared bindings.
 */
async function fetchWithToken(
	url: string,
	token: string | null,
	init: RequestInit = {},
	overrides: Partial<Record<keyof Env, string>> = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);

	const ctx = createExecutionContext();
	const env = envWith({ DEV_DISABLE_ACCESS: "", ...overrides });
	const res = await worker.fetch!(new Request(url, { ...init, headers }), env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

/** Reach the owner surface (`GET /api/documents`) with `claims` signed by the team key. */
async function ownerRequest(claims: Record<string, unknown>): Promise<Response> {
	return fetchWithToken(`${BASE}/api/documents`, await signAs(claims, team.privateJwk));
}

/** Reach the MCP surface (`POST /mcp`) with `claims` signed by the team key. */
async function mcpRequest(claims: Record<string, unknown>): Promise<Response> {
	return fetchWithToken(`${MCP_BASE}/mcp`, await signAs(claims, team.privateJwk), MCP_CALL);
}

describe("Access JWT verification", () => {
	it("accepts a valid user JWT on the owner surface", async () => {
		const res = await ownerRequest(identityClaims(OWNER_AUD, nowSeconds()));
		expect(res.status).toBe(200);
	});

	// The common claim set is the intersection of the two documented payloads. A
	// service-token JWT has no `nbf` and no `email`, so requiring either on the
	// owner routes would lock the CLI and CI out.
	it("accepts a service-token JWT on the owner surface, which carries no nbf and no email", async () => {
		const res = await ownerRequest(serviceClaims(OWNER_AUD, nowSeconds()));
		expect(res.status).toBe(200);
	});

	it("accepts a user JWT at the MCP endpoint", async () => {
		const res = await mcpRequest(identityClaims(MCP_AUD, nowSeconds()));
		expect(res.status).toBe(200);
	});

	it("rejects a request with no Cf-Access-Jwt-Assertion header", async () => {
		const res = await fetchWithToken(`${BASE}/api/documents`, null);
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("rejects a signature the team's JWKS cannot verify", async () => {
		// Same `kid`, so the key lookup succeeds and the signature check is what
		// fails. A mismatched `kid` would prove nothing about the signature.
		const forged = await signAs(identityClaims(OWNER_AUD, nowSeconds()), forger.privateJwk);

		const res = await fetchWithToken(`${BASE}/api/documents`, forged);
		expect(res.status).toBe(403);
	});

	it("rejects a token issued by another Cloudflare team", async () => {
		const claims = { ...identityClaims(OWNER_AUD, nowSeconds()), iss: "https://other-team.cloudflareaccess.com" };
		expect((await ownerRequest(claims)).status).toBe(403);
	});

	it("rejects a token with no iss claim", async () => {
		const { iss: _iss, ...claims } = identityClaims(OWNER_AUD, nowSeconds());
		expect((await ownerRequest(claims)).status).toBe(403);
	});

	it("rejects a token for an audience this route does not serve", async () => {
		expect((await ownerRequest(identityClaims("some-other-app", nowSeconds()))).status).toBe(403);
	});

	// Header-only rejections: the algorithm is checked before the signature, so
	// these tokens carry a signature that is never examined.
	it("rejects a symmetric algorithm", async () => {
		const token = tokenWithHeader({ alg: "HS256", kid: KID, typ: "JWT" }, identityClaims(OWNER_AUD, nowSeconds()));

		expect((await fetchWithToken(`${BASE}/api/documents`, token)).status).toBe(403);
	});

	it("rejects an asymmetric algorithm other than RS256", async () => {
		const token = tokenWithHeader({ alg: "RS512", kid: KID, typ: "JWT" }, identityClaims(OWNER_AUD, nowSeconds()));

		expect((await fetchWithToken(`${BASE}/api/documents`, token)).status).toBe(403);
	});

	it("rejects a header with no kid", async () => {
		const token = tokenWithHeader({ alg: "RS256", typ: "JWT" }, identityClaims(OWNER_AUD, nowSeconds()));

		expect((await fetchWithToken(`${BASE}/api/documents`, token)).status).toBe(403);
	});

	it("rejects an expired token", async () => {
		const now = nowSeconds();
		const claims = { ...identityClaims(OWNER_AUD, now), exp: now - 60, iat: now - 660 };
		expect((await ownerRequest(claims)).status).toBe(403);
	});

	// `hono/jwt` checks exp, iat, and nbf only when the claim is present, so a
	// token with no `exp` would otherwise sail past the expiry check and never
	// stop being valid.
	it("rejects a token with no exp claim", async () => {
		const { exp: _exp, ...claims } = identityClaims(OWNER_AUD, nowSeconds());
		expect((await ownerRequest(claims)).status).toBe(403);
	});

	it("rejects a token with no iat claim", async () => {
		const { iat: _iat, ...claims } = identityClaims(OWNER_AUD, nowSeconds());
		expect((await ownerRequest(claims)).status).toBe(403);
	});

	it("rejects a token issued in the future", async () => {
		const now = nowSeconds();
		const claims = { ...identityClaims(OWNER_AUD, now), iat: now + 600 };
		expect((await ownerRequest(claims)).status).toBe(403);
	});

	// `nbf` is not required, because service tokens do not carry one. It is still
	// enforced on the identity tokens that do.
	it("rejects a token that is not valid yet", async () => {
		const now = nowSeconds();
		expect((await ownerRequest({ ...identityClaims(OWNER_AUD, now), nbf: now + 600 })).status).toBe(403);
	});

	// The same team key signs other Cloudflare token types. This route wants an
	// application token.
	it("rejects a token that is not an application token", async () => {
		const claims = { ...identityClaims(OWNER_AUD, nowSeconds()), type: "org" };
		expect((await ownerRequest(claims)).status).toBe(403);
	});
});

// The whole point of the two hostnames: two Access applications, two AUD tags,
// and a token minted for one that opens nothing on the other.
describe("route-specific audiences", () => {
	it("refuses the owner audience at the MCP endpoint", async () => {
		// An identity assertion, so the audience is the only thing wrong with it.
		const token = await signAs(identityClaims(OWNER_AUD, nowSeconds()), team.privateJwk);

		const res = await fetchWithToken(`${MCP_BASE}/mcp`, token, MCP_CALL);
		expect(res.status).toBe(403);
	});

	it("refuses the MCP audience on the owner surface", async () => {
		const token = await signAs(serviceClaims(MCP_AUD, nowSeconds()), team.privateJwk);

		expect((await fetchWithToken(`${BASE}/api/documents`, token)).status).toBe(403);
		expect((await fetchWithToken(`${BASE}/`, token)).status).toBe(403);
	});

	it("accepts each audience at its own endpoint", async () => {
		const now = nowSeconds();
		expect((await ownerRequest(serviceClaims(OWNER_AUD, now))).status).toBe(200);
		expect((await mcpRequest(identityClaims(MCP_AUD, now))).status).toBe(200);
	});
});

// The MCP endpoint is reached by a human through Managed OAuth, and its Access
// application is meant to carry no Service Auth policy at all (SPEC §11.2).
// This is the Worker-side half of that: a static credential is refused here
// even when it carries the right audience and a valid signature.
describe("the MCP endpoint takes human logins only", () => {
	it("refuses a service-token assertion carrying the MCP audience", async () => {
		const res = await mcpRequest(serviceClaims(MCP_AUD, nowSeconds()));
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	// Each of the three signals is checked on its own, so no single one of them
	// is load-bearing for the whole boundary.
	it("refuses an assertion carrying common_name, however else it is dressed up", async () => {
		const claims = { ...identityClaims(MCP_AUD, nowSeconds()), common_name: "e367826f93b8d71185e03fe518aff3b4.access" };
		expect((await mcpRequest(claims)).status).toBe(403);
	});

	it("refuses an assertion with an empty sub", async () => {
		expect((await mcpRequest({ ...identityClaims(MCP_AUD, nowSeconds()), sub: "" })).status).toBe(403);
	});

	it("refuses an assertion with no email", async () => {
		const { email: _email, ...claims } = identityClaims(MCP_AUD, nowSeconds());
		expect((await mcpRequest(claims)).status).toBe(403);
	});

	// The same three tokens are fine on the owner routes, which the CLI reaches
	// with exactly this credential.
	it("leaves the owner surface accepting service tokens", async () => {
		expect((await ownerRequest(serviceClaims(OWNER_AUD, nowSeconds()))).status).toBe(200);
	});
});

// `sub` is documented in both payloads, so its presence is required everywhere
// even though only the MCP boundary reads its value.
describe("sub presence", () => {
	it("refuses a token with no sub claim on either surface", async () => {
		const { sub: _o, ...ownerClaims } = serviceClaims(OWNER_AUD, nowSeconds());
		expect((await ownerRequest(ownerClaims)).status).toBe(403);

		const { sub: _m, ...mcpClaims } = identityClaims(MCP_AUD, nowSeconds());
		expect((await mcpRequest(mcpClaims)).status).toBe(403);
	});
});

// A blank value is a deployment that cannot enforce Access. It answers 503, not
// 200 and not 403: the request is fine, the Worker is not configured.
describe("fail-closed configuration", () => {
	/**
	 * Send a request that would otherwise succeed, so a 503 can only come from
	 * `overrides` and never from the credential.
	 */
	async function fetchWithEnv(url: string, overrides: Partial<Record<keyof Env, string>>, init: RequestInit = {}) {
		const token = await signAs(serviceClaims(OWNER_AUD, nowSeconds()), team.privateJwk);
		return fetchWithToken(url, token, init, overrides);
	}

	it("refuses every request when MCP_HOST is blank", async () => {
		for (const url of [`${BASE}/api/documents`, `${BASE}/`, `${MCP_BASE}/mcp`]) {
			const res = await fetchWithEnv(url, { MCP_HOST: "" });
			expect(res.status, url).toBe(503);
			expect(await res.text()).toBe("Service Unavailable");
		}
	});

	it("refuses every request when OWNER_HOST is blank", async () => {
		expect((await fetchWithEnv(`${BASE}/api/documents`, { OWNER_HOST: "" })).status).toBe(503);
	});

	it("refuses every request when the two hostnames are equal", async () => {
		expect((await fetchWithEnv(`${BASE}/`, { MCP_HOST: BASE.replace("https://", "") })).status).toBe(503);
	});

	it("refuses the owner surface when ACCESS_TEAM_DOMAIN is blank", async () => {
		const res = await fetchWithEnv(`${BASE}/api/documents`, { ACCESS_TEAM_DOMAIN: "" });
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Service Unavailable");
	});

	it("refuses the owner surface when ACCESS_AUD is blank", async () => {
		expect((await fetchWithEnv(`${BASE}/api/documents`, { ACCESS_AUD: "" })).status).toBe(503);
	});

	it("refuses the MCP endpoint when ACCESS_MCP_AUD is blank, and leaves the owner surface alone", async () => {
		expect((await fetchWithEnv(`${MCP_BASE}/mcp`, { ACCESS_MCP_AUD: "" }, MCP_CALL)).status).toBe(503);
		expect((await fetchWithEnv(`${BASE}/api/documents`, { ACCESS_MCP_AUD: "" })).status).toBe(200);
	});

	// Equal AUD tags mean one Access application, so an MCP grant would also open
	// the library. Neither surface has a safe half to keep serving.
	it("refuses both surfaces when the two AUD tags are equal", async () => {
		const same = { ACCESS_AUD: OWNER_AUD, ACCESS_MCP_AUD: OWNER_AUD };
		expect((await fetchWithEnv(`${BASE}/api/documents`, same)).status).toBe(503);
		expect((await fetchWithEnv(`${MCP_BASE}/mcp`, same, MCP_CALL)).status).toBe(503);
	});

	// A var deleted from wrangler.jsonc arrives with no property at all, not as
	// "". Reading `.trim()` straight off it would be a TypeError and a 500 where
	// the documented 503 belongs, so absent and blank have to land the same way.
	it("refuses without a TypeError when the Access vars are absent, not blank", async () => {
		const absent: (keyof Env)[] = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"];
		for (const key of absent) {
			const res = await fetchWithEnv(`${BASE}/api/documents`, { [key]: undefined });
			expect(res.status, key).toBe(503);
			expect(await res.text()).toBe("Service Unavailable");
		}
	});

	it("refuses the MCP endpoint when ACCESS_MCP_AUD is absent, not blank", async () => {
		const res = await fetchWithEnv(`${MCP_BASE}/mcp`, { ACCESS_MCP_AUD: undefined }, MCP_CALL);
		expect(res.status).toBe(503);
		expect(await res.text()).toBe("Service Unavailable");
	});

	it("refuses every request when the host vars are absent, not blank", async () => {
		for (const key of ["MCP_HOST", "OWNER_HOST"] as (keyof Env)[]) {
			const res = await fetchWithEnv(`${BASE}/`, { [key]: undefined });
			expect(res.status, key).toBe(503);
		}
	});

	// A value that is neither blank nor a host is the third way to end up unable
	// to tell the surfaces apart, and it fails the same way.
	it("refuses every request when a host var is not a host", async () => {
		for (const bad of ["https://poof.5n7.me", "poof.5n7.me/mcp", "poof 5n7 me", "/"]) {
			const res = await fetchWithEnv(`${BASE}/`, { OWNER_HOST: bad });
			expect(res.status, bad).toBe(503);
		}
	});

	// Misconfiguration must not open the public paths either way: they stay
	// readable when Access config is missing, because they never used it.
	it("leaves the public paths alone when the Access audience is blank", async () => {
		const res = await fetchWithEnv(`${BASE}/raw/s_nonexistent000000000`, { ACCESS_AUD: "" });
		expect(res.status).toBe(404);
	});
});
