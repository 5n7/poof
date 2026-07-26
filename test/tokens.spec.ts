import { describe, expect, it } from "vitest";

import { b64url, mintOwnerToken, newShareToken, parseTtl, randomToken, verifyOwnerToken } from "../src/lib/tokens";

const SECRET = "test-secret";

const enc = new TextEncoder();

/** The decoded JSON payload of an o_ token, without verifying it. */
function payloadOf(token: string): Record<string, unknown> {
	const seg = token.slice(2, token.indexOf("."));
	return JSON.parse(atob(seg.replace(/-/g, "+").replace(/_/g, "/")));
}

/**
 * Mint an o_ token over an arbitrary payload with a *correct* signature — the
 * only way to test that verification distrusts the payload's shape rather than
 * relying on the HMAC alone.
 */
async function forgeOwnerToken(payload: unknown, secret = SECRET): Promise<string> {
	const payloadB64 = b64url(enc.encode(JSON.stringify(payload)));
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
	return "o_" + payloadB64 + "." + b64url(sig);
}

describe("randomToken", () => {
	it("is 22-char base64url with no + / = characters", () => {
		const t = randomToken();
		expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
		expect(t).not.toMatch(/[+/=]/);
	});

	it("produces unique values", () => {
		const set = new Set(Array.from({ length: 1000 }, () => randomToken()));
		expect(set.size).toBe(1000);
	});
});

describe("newShareToken", () => {
	it("carries the s_ prefix and a base64url body", () => {
		const t = newShareToken();
		expect(t.startsWith("s_")).toBe(true);
		expect(t.slice(2)).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});
});

describe("mintOwnerToken / verifyOwnerToken", () => {
	it("round-trips the document id", async () => {
		const token = await mintOwnerToken("doc123", SECRET);
		expect(token.startsWith("o_")).toBe(true);
		expect(await verifyOwnerToken(token, SECRET)).toEqual({ documentId: "doc123", version: null });
	});

	it("rejects an expired token", async () => {
		const token = await mintOwnerToken("doc123", SECRET, -10);
		expect(await verifyOwnerToken(token, SECRET)).toBeNull();
	});

	it("rejects a tampered payload", async () => {
		const token = await mintOwnerToken("doc123", SECRET);
		// Flip a character in the payload segment (between "o_" and ".").
		const dot = token.indexOf(".");
		const payload = token.slice(2, dot);
		const flipped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
		const tampered = "o_" + flipped + token.slice(dot);
		expect(await verifyOwnerToken(tampered, SECRET)).toBeNull();
	});

	it("rejects a tampered signature", async () => {
		const token = await mintOwnerToken("doc123", SECRET);
		const dot = token.indexOf(".");
		const sig = token.slice(dot + 1);
		const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
		const tampered = token.slice(0, dot + 1) + flipped;
		expect(await verifyOwnerToken(tampered, SECRET)).toBeNull();
	});

	it("rejects a token signed with a different secret", async () => {
		const token = await mintOwnerToken("doc123", SECRET);
		expect(await verifyOwnerToken(token, "other-secret")).toBeNull();
	});

	it("rejects malformed input", async () => {
		expect(await verifyOwnerToken("garbage", SECRET)).toBeNull();
		expect(await verifyOwnerToken("o_only-no-dot", SECRET)).toBeNull();
		expect(await verifyOwnerToken("s_notanownertoken", SECRET)).toBeNull();
	});

	it("round-trips a version pin", async () => {
		const token = await mintOwnerToken("doc123", SECRET, 600, 2);
		expect(await verifyOwnerToken(token, SECRET)).toEqual({ documentId: "doc123", version: 2 });
	});

	it("omits `v` entirely when no version is pinned, keeping the legacy payload shape", async () => {
		expect(Object.keys(payloadOf(await mintOwnerToken("doc123", SECRET)))).toEqual(["d", "exp"]);
		expect(Object.keys(payloadOf(await mintOwnerToken("doc123", SECRET, 600, 1)))).toEqual(["d", "v", "exp"]);
	});

	it("rejects a non-integer or non-positive `v` even with a valid signature", async () => {
		const exp = Math.floor(Date.now() / 1000) + 600;
		for (const v of [0, -1, 1.5, "2", null, true]) {
			const token = await forgeOwnerToken({ d: "doc123", v, exp });
			expect(await verifyOwnerToken(token, SECRET)).toBeNull();
		}
		// Same forging path with a sane `v` verifies — so the rejections above are
		// about the value, not about the forged token being malformed.
		const good = await forgeOwnerToken({ d: "doc123", v: 3, exp });
		expect(await verifyOwnerToken(good, SECRET)).toEqual({ documentId: "doc123", version: 3 });
	});
});

describe("parseTtl", () => {
	it("maps supported durations to seconds", () => {
		expect(parseTtl("1h")).toBe(3600);
		expect(parseTtl("1d")).toBe(86400);
		expect(parseTtl("1w")).toBe(604800);
	});

	it("returns null for anything else", () => {
		expect(parseTtl("")).toBeNull();
		expect(parseTtl("2h")).toBeNull();
		expect(parseTtl("1m")).toBeNull();
		expect(parseTtl("forever")).toBeNull();
	});
});
