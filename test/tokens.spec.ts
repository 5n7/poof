import { describe, expect, it } from "vitest";

import { mintOwnerToken, newShareToken, parseTtl, randomToken, verifyOwnerToken } from "../src/lib/tokens";

const SECRET = "test-secret";

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
		expect(await verifyOwnerToken(token, SECRET)).toBe("doc123");
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
