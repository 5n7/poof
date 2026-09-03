import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
	getLiveDocument,
	getLiveDocumentAtVersion,
	insertVersion,
	listDocumentsWithShares,
	nextVersion,
	setCurrentVersion,
} from "../src/lib/db";
import { seedDoc, seedShare, seedVersion } from "./helpers";

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

	it("reports current_version, updated_at and the current version's kind, without r2_key", async () => {
		await insDoc("dbsum_old", 100, null);
		await seedDoc("dbsum_new", { kind: "md", createdAt: 200, body: null });
		await seedVersion("dbsum_new", 2, { kind: "html", body: null, createdAt: 250 });

		const rows = await listDocumentsWithShares(env.DB, 1_000_000);
		const seeded = rows.filter((r) => r.id.startsWith("dbsum_"));
		expect(seeded.map((r) => r.id)).toEqual(["dbsum_new", "dbsum_old"]); // created_at DESC survives

		const byId = Object.fromEntries(seeded.map((r) => [r.id, r]));
		expect(byId.dbsum_new.current_version).toBe(2);
		expect(byId.dbsum_new.created_at).toBe(200);
		expect(byId.dbsum_new.updated_at).toBe(250);
		expect(byId.dbsum_new.kind).toBe("html"); // the current version's, not version 1's
		expect(byId.dbsum_old.current_version).toBe(1);
		expect(byId.dbsum_old.updated_at).toBe(100);
		expect(byId.dbsum_old.kind).toBe("md");
		expect(Object.keys(byId.dbsum_new).sort()).toEqual([
			"active_share_count",
			"created_at",
			"current_version",
			"expires_at",
			"id",
			"kind",
			"next_share_expires_at",
			"title",
			"updated_at",
		]);
	});
});

/** v1 md under the legacy flat key, v2 html, v3 md; current = v3. */
async function seedHistory(id: string, expiresAt: number | null = null) {
	await seedDoc(id, { kind: "md", createdAt: 10, expiresAt, body: null });
	await seedVersion(id, 2, { kind: "html", body: null, createdAt: 20 });
	await seedVersion(id, 3, { kind: "md", body: null, createdAt: 30 });
}

describe("resolving a document to a version", () => {
	it("resolves the current version's kind and r2_key after two updates", async () => {
		await seedHistory("dbres_current");

		const doc = await getLiveDocument(env.DB, "dbres_current", 1_000_000);
		expect(doc).not.toBeNull();
		expect(doc!.version).toBe(3);
		expect(doc!.current_version).toBe(3);
		expect(doc!.kind).toBe("md");
		expect(doc!.r2_key).toBe("doc/dbres_current/v3.html");
		// The two created_at columns must not be confused for each other.
		expect(doc!.created_at).toBe(10);
		expect(doc!.version_created_at).toBe(30);
		expect(doc!.updated_at).toBe(30);
	});

	it("returns a past version verbatim and leaves the pointer alone", async () => {
		await seedHistory("dbres_past");

		const past = await getLiveDocumentAtVersion(env.DB, "dbres_past", 1, 1_000_000);
		expect(past).not.toBeNull();
		expect(past!.version).toBe(1);
		expect(past!.kind).toBe("md");
		expect(past!.r2_key).toBe("doc/dbres_past.html"); // the backfilled flat key
		expect(past!.version_created_at).toBe(10);
		expect(past!.current_version).toBe(3);

		const middle = await getLiveDocumentAtVersion(env.DB, "dbres_past", 2, 1_000_000);
		expect(middle!.kind).toBe("html");
		expect(middle!.r2_key).toBe("doc/dbres_past/v2.html");
	});

	it("returns null for an unknown version and for an expired document", async () => {
		await seedHistory("dbres_null");
		await seedHistory("dbres_expired", 500);

		expect(await getLiveDocumentAtVersion(env.DB, "dbres_null", 4, 1_000_000)).toBeNull();
		expect(await getLiveDocumentAtVersion(env.DB, "dbres_missing", 1, 1_000_000)).toBeNull();
		expect(await getLiveDocumentAtVersion(env.DB, "dbres_expired", 1, 1_000_000)).toBeNull();
		expect(await getLiveDocument(env.DB, "dbres_expired", 1_000_000)).toBeNull();
	});
});

describe("version allocation and the current_version pointer", () => {
	it("allocates MAX(version) + 1 even after the pointer has been rolled back", async () => {
		await seedHistory("dbnext_rolled");
		expect(await nextVersion(env.DB, "dbnext_rolled")).toBe(4);

		expect(await setCurrentVersion(env.DB, "dbnext_rolled", 1, 40)).toBe(true);
		// current_version + 1 would be 2 and collide with recorded history.
		expect(await nextVersion(env.DB, "dbnext_rolled")).toBe(4);
	});

	it("starts at 1 for a document with no versions at all", async () => {
		expect(await nextVersion(env.DB, "dbnext_missing")).toBe(1);
	});

	it("refuses a duplicate (document_id, version) instead of overwriting it", async () => {
		await seedDoc("dbins_dup", { kind: "md", body: null });
		const row = {
			document_id: "dbins_dup",
			version: 2,
			kind: "html" as const,
			r2_key: "doc/dbins_dup/v2.html",
			created_at: 20,
		};
		expect(await insertVersion(env.DB, row)).toBe(true);
		expect(await insertVersion(env.DB, { ...row, r2_key: "doc/dbins_dup/other.html" })).toBe(false);

		// The first write remains. A competing insert must not overwrite it.
		const stored = await getLiveDocumentAtVersion(env.DB, "dbins_dup", 2, 1_000_000);
		expect(stored!.r2_key).toBe("doc/dbins_dup/v2.html");
	});

	it("refuses to point current_version at a version that does not exist", async () => {
		await seedHistory("dbptr_guard");

		expect(await setCurrentVersion(env.DB, "dbptr_guard", 9, 50)).toBe(false);
		expect(await setCurrentVersion(env.DB, "dbptr_missing", 1, 50)).toBe(false);

		const doc = await getLiveDocument(env.DB, "dbptr_guard", 1_000_000);
		expect(doc!.current_version).toBe(3);
		expect(doc!.updated_at).toBe(30); // the failed move did not touch the row
	});
});
