import { nowSeconds } from "./time";

/** base64url-encode bytes with no padding. */
export function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url-decode (no padding required). */
function b64urlDecode(s: string): Uint8Array {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** 16 random bytes (128 bits) → base64url, ~22 chars, no padding (SPEC §5). */
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
 * Mint a stateless owner view token: `o_` + b64url(JSON {d, exp}) +
 * "." + b64url(HMAC-SHA256(payloadB64, secret)). Default TTL 600s (SPEC §6.2).
 */
export async function mintOwnerToken(documentId: string, secret: string, ttlSeconds = 600): Promise<string> {
	const exp = nowSeconds() + ttlSeconds;
	const payloadB64 = b64url(enc.encode(JSON.stringify({ d: documentId, exp })));
	const key = await hmacKey(secret);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
	return "o_" + payloadB64 + "." + b64url(sig);
}

/**
 * Verify an owner token. Returns the document id, or null on malformed,
 * expired, or bad-signature input. Signature check uses `crypto.subtle.verify`
 * (constant-time).
 */
export async function verifyOwnerToken(token: string, secret: string, now = nowSeconds()): Promise<string | null> {
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
		return payload.d;
	} catch {
		return null;
	}
}

const TTL_SECONDS = new Map<string, number>([
	["1h", 3600],
	["1d", 86400],
	["1w", 604800],
]);

/** "1h" | "1d" | "1w" → seconds; null otherwise. */
export function parseTtl(s: string): number | null {
	return TTL_SECONDS.get(s) ?? null;
}
