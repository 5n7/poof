import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { mintOwnerToken } from "../src/lib/tokens";
import { headerDump, seedDoc, seedShare } from "./helpers";

const now = () => (Date.now() / 1000) | 0;

const BODY = "<!DOCTYPE html><html><body><h1>raw doc</h1></body></html>";

interface SeedOpts {
	docExpiresAt?: number | null;
	shareExpiresAt?: number;
	shareRevoked?: 0 | 1;
}

/** Seed a document (+blob) and a share row directly into the bindings. */
async function seed(id: string, token: string, opts: SeedOpts = {}) {
	const t = now();
	await seedDoc(id, { title: "raw doc", createdAt: t, expiresAt: opts.docExpiresAt ?? null, body: BODY });
	await seedShare(token, id, {
		createdAt: t,
		expiresAt: opts.shareExpiresAt ?? t + 3600,
		revoked: opts.shareRevoked ?? 0,
	});
}

describe("GET /raw/:token — valid delivery", () => {
	it("serves the blob for a live share token", async () => {
		const id = "doc_live_share";
		const token = "s_liveshare000000000000";
		await seed(id, token);
		const res = await SELF.fetch(`https://poof.5n7.me/raw/${token}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(BODY);
	});

	it("serves the blob for a valid owner token", async () => {
		const id = "doc_live_owner";
		const token = "s_ownerseed0000000000000";
		await seed(id, token);
		const oToken = await mintOwnerToken(id, env.OWNER_TOKEN_SECRET);
		const res = await SELF.fetch(`https://poof.5n7.me/raw/${oToken}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(BODY);
	});

	it("sends the exact security headers (§4) and never allow-same-origin", async () => {
		const id = "doc_headers";
		const token = "s_headers0000000000000000";
		await seed(id, token);
		const res = await SELF.fetch(`https://poof.5n7.me/raw/${token}`);
		expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-popups");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("Cache-Control")).toBe("no-store");

		expect(headerDump(res)).not.toContain("allow-same-origin");
	});
});

describe("GET /raw/:token — 404 uniformity (§6.3)", () => {
	// Every failure mode must return an identical status + body so a probe
	// cannot distinguish "never existed" from "existed and expired/revoked".
	it("returns identical 404 for all failure modes", async () => {
		const t = now();

		// nonexistent share token
		const nonexistent = "s_doesnotexist0000000000";

		// expired share (parent doc live)
		const expiredShareId = "doc_exp_share";
		const expiredShareToken = "s_expiredshare0000000000";
		await seed(expiredShareId, expiredShareToken, { shareExpiresAt: t - 10 });

		// revoked share (parent doc live)
		const revokedId = "doc_revoked";
		const revokedToken = "s_revokedshare0000000000";
		await seed(revokedId, revokedToken, { shareRevoked: 1 });

		// expired owner token
		const expiredOwnerId = "doc_exp_owner";
		const expiredOwnerSeedToken = "s_expownerseed0000000000";
		await seed(expiredOwnerId, expiredOwnerSeedToken);
		const expiredOwnerToken = await mintOwnerToken(expiredOwnerId, env.OWNER_TOKEN_SECRET, -10);

		// garbage / unknown prefix
		const garbage = "garbage-no-prefix";

		// live share but its parent document has expired
		const expiredParentId = "doc_exp_parent";
		const expiredParentToken = "s_expparentshare00000000";
		await seed(expiredParentId, expiredParentToken, { docExpiresAt: t - 10 });

		const tokens = [nonexistent, expiredShareToken, revokedToken, expiredOwnerToken, garbage, expiredParentToken];

		const results = await Promise.all(
			tokens.map(async (tok) => {
				const res = await SELF.fetch(`https://poof.5n7.me/raw/${tok}`);
				return { status: res.status, body: await res.text() };
			}),
		);

		for (const r of results) {
			expect(r.status).toBe(404);
			expect(r.body).toBe("Not Found");
		}
		// All responses are byte-identical.
		const unique = new Set(results.map((r) => `${r.status}:${r.body}`));
		expect(unique.size).toBe(1);
	});
});
