import { nowSeconds } from "./time";

/** Encode bytes as unpadded base64url. */
export function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode base64url without requiring padding. */
function b64urlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Return 16 random bytes as about 22 base64url characters (SPEC §5). */
export function randomToken(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return b64url(bytes);
}

export function newShareToken(): string {
	return "s_" + randomToken();
}

const enc = new TextEncoder();

// The secret is fixed for the isolate's life and a CryptoKey is reusable for
// unlimited sign/verify ops, so import it once per secret instead of on every
// mint/verify (both are request hot paths).
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
			"verify",
		]);
		keyCache.set(secret, key);
	}
	return key;
}

/**
 * Mint a stateless owner view token as `o_` + b64url(JSON {d, v?, exp}) +
 * "." + b64url(HMAC-SHA256(payloadB64, secret)). Default TTL 600s (SPEC §6.2).
 *
 * `version` pins the token to one past version. When it is undefined the `v`
 * field is omitted *entirely*, so tokens for the current version stay
 * byte-identical to the pre-versioning format and tokens minted before this
 * change keep verifying.
 */
export async function mintOwnerToken(
	documentId: string,
	secret: string,
	ttlSeconds = 600,
	version?: number,
): Promise<string> {
	const exp = nowSeconds() + ttlSeconds;
	const payload = version === undefined ? { d: documentId, exp } : { d: documentId, v: version, exp };
	const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
	const key = await hmacKey(secret);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
	return "o_" + payloadB64 + "." + b64url(sig);
}

export interface OwnerTokenPayload {
	documentId: string;
	/** Pinned version, or null when the token follows the current version. */
	version: number | null;
}

/**
 * Verify an owner token. Returns its payload, or null on malformed, expired, or
 * bad-signature input. Signature check uses `crypto.subtle.verify`
 * (constant-time).
 */
export async function verifyOwnerToken(
	token: string,
	secret: string,
	now = nowSeconds(),
): Promise<OwnerTokenPayload | null> {
	if (!token.startsWith("o_")) return null;
	const rest = token.slice(2);
	const dot = rest.indexOf(".");
	if (dot < 0) return null;
	const payloadB64 = rest.slice(0, dot);
	const sigB64 = rest.slice(dot + 1);
	if (!payloadB64 || !sigB64) return null;

	let sig: Uint8Array;
	try {
		sig = b64urlDecode(sigB64);
	} catch {
		return null;
	}
	const key = await hmacKey(secret);
	const ok = await crypto.subtle.verify("HMAC", key, sig, enc.encode(payloadB64));
	if (!ok) return null;

	try {
		const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
		if (typeof payload?.d !== "string" || typeof payload?.exp !== "number") return null;
		if (payload.exp <= now) return null;
		let version: number | null = null;
		if ("v" in payload) {
			// The payload is authenticated, not trusted to be sane: a valid
			// signature over v: 0 / -1 / 1.5 / "2" is still a rejection.
			if (typeof payload.v !== "number" || !Number.isInteger(payload.v) || payload.v < 1) return null;
			version = payload.v;
		}
		return { documentId: payload.d, version };
	} catch {
		return null;
	}
}

const TTL_SECONDS = {
	"1h": 3600,
	"1d": 86400,
	"1w": 604800,
} as const;

export type Ttl = keyof typeof TTL_SECONDS;

/**
 * The accepted TTLs for callers that need a list. The MCP
 * tool schemas build their enum from this. Derived from `TTL_SECONDS` rather
 * than writing another list that could drift and produce a NaN expiry.
 */
export const TTL_KEYS = Object.keys(TTL_SECONDS) as [Ttl, ...Ttl[]];

/**
 * Convert a valid TTL to seconds without a null branch.
 * Named `ttlToSeconds` rather than `ttlSeconds` because `mintOwnerToken` already
 * takes a parameter by that name.
 */
export function ttlToSeconds(ttl: Ttl): number {
	return TTL_SECONDS[ttl];
}

/** Convert "1h", "1d", or "1w" to seconds. Return null for other values. */
export function parseTtl(s: string): number | null {
	return Object.hasOwn(TTL_SECONDS, s) ? TTL_SECONDS[s as Ttl] : null;
}
