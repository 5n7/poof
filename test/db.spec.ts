import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { listDocumentsWithShares } from "../src/lib/db";
import { seedDoc, seedShare } from "./helpers";

const insDoc = (id: string, createdAt: number, expiresAt: number | null) =>
	seedDoc(id, { kind: "md", createdAt, expiresAt, body: null });

const insShare = (token: string, docId: string, expiresAt: number, revoked: 0 | 1) =>
	seedShare(token, docId, { expiresAt, revoked });

describe("listDocumentsWithShares", () => {
	it("aggregates active shares only, min expiry, newest doc first", async () => {
		const now = 1_000_000;
		await insDoc("dbA", 100, null); // older
		await insDoc("dbB", 200, null); // newer

		// dbA: two active shares + one revoked + one expired.
		await insShare("s_dbA1", "dbA", now + 500, 0);
		await insShare("s_dbA2", "dbA", now + 300, 0);
		await insShare("s_dbA3", "dbA", now + 900, 1); // revoked -> excluded
		await insShare("s_dbA4", "dbA", now - 10, 0); // expired -> excluded
		// dbB: only a revoked share -> counts as none.
		await insShare("s_dbB1", "dbB", now + 400, 1);

		const rows = await listDocumentsWithShares(env.DB, now);
		const seededOrder = rows.filter((r) => r.id === "dbA" || r.id === "dbB").map((r) => r.id);
		expect(seededOrder).toEqual(["dbB", "dbA"]); // created_at DESC

		const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(byId.dbA.active_share_count).toBe(2);
		expect(byId.dbA.next_share_expires_at).toBe(now + 300); // MIN of the two active
		expect(byId.dbB.active_share_count).toBe(0);
		expect(byId.dbB.next_share_expires_at).toBeNull();
	});
});
