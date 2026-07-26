export interface DocumentRow {
	id: string;
	title: string;
	created_at: number;
	updated_at: number;
	current_version: number;
	expires_at: number | null;
}

export interface VersionRow {
	document_id: string;
	version: number;
	kind: "md" | "html";
	r2_key: string;
	created_at: number;
}

/** A document resolved to one version — what every read path actually needs. */
export interface ResolvedDocument extends DocumentRow {
	version: number;
	kind: "md" | "html";
	r2_key: string;
	version_created_at: number;
}

/** List projection: no r2_key (nothing outside the blob paths needs it). */
export interface DocumentSummary extends DocumentRow {
	kind: "md" | "html";
}

/** A brand-new document plus the contents of its version 1. */
export interface NewDocument {
	id: string;
	title: string;
	kind: "md" | "html";
	r2_key: string;
	created_at: number;
	expires_at: number | null;
}

export interface ShareRow {
	token: string;
	document_id: string;
	created_at: number;
	expires_at: number;
	revoked: 0 | 1;
}

// Never `SELECT d.*, dv.*`: both tables have a `created_at` and D1 silently
// keeps one of them. Every joined read projects its columns explicitly.
const RESOLVED_COLUMNS = `d.id, d.title, d.created_at, d.updated_at, d.current_version, d.expires_at,
	dv.version AS version, dv.kind AS kind, dv.r2_key AS r2_key, dv.created_at AS version_created_at`;

const SUMMARY_COLUMNS = `d.id, d.title, d.created_at, d.updated_at, d.current_version, d.expires_at,
	dv.kind AS kind`;

const CURRENT_JOIN = `JOIN document_version dv
	ON dv.document_id = d.id AND dv.version = d.current_version`;

/**
 * R2 key for a newly written version. Keys are never derived on read — always
 * read `document_version.r2_key` — because version 1 rows that predate
 * versioning keep their flat `doc/{id}.html` key (zero-copy backfill).
 */
export function versionR2Key(id: string, version: number): string {
	return `doc/${id}/v${version}.html`;
}

/**
 * D1 reports constraint violations in the message only (there is no error
 * code), so a duplicate (document_id, version) has to be matched by string.
 */
function isUniqueViolation(err: unknown): boolean {
	return err instanceof Error && err.message.includes("UNIQUE constraint failed");
}

/** Insert a document and its version 1 in one batch (= one transaction). */
export async function insertDocument(db: D1Database, doc: NewDocument): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO document (id, title, created_at, updated_at, current_version, expires_at)
					VALUES (?, ?, ?, ?, 1, ?)`,
			)
			.bind(doc.id, doc.title, doc.created_at, doc.created_at, doc.expires_at),
		db
			.prepare(
				`INSERT INTO document_version (document_id, version, kind, r2_key, created_at)
					VALUES (?, 1, ?, ?, ?)`,
			)
			.bind(doc.id, doc.kind, doc.r2_key, doc.created_at),
	]);
}

export async function listDocuments(db: D1Database): Promise<DocumentSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS}
			FROM document d
			${CURRENT_JOIN}
			ORDER BY d.created_at DESC`,
		)
		.all<DocumentSummary>();
	return results;
}

export interface DocumentWithShares extends DocumentSummary {
	active_share_count: number;
	next_share_expires_at: number | null;
}

/**
 * Every document (newest first) with its active-share aggregate, in one query.
 * "Active" = not revoked and not yet expired at `now`. `next_share_expires_at`
 * is the soonest expiry among those active shares, or null when there are none.
 * `dv` is an inner join on the composite PK (1:1), so `dv.kind` under the
 * GROUP BY is deterministic.
 */
export async function listDocumentsWithShares(db: D1Database, now: number): Promise<DocumentWithShares[]> {
	const { results } = await db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS},
				COUNT(s.token) AS active_share_count,
				MIN(s.expires_at) AS next_share_expires_at
			FROM document d
			${CURRENT_JOIN}
			LEFT JOIN share s
				ON s.document_id = d.id AND s.revoked = 0 AND s.expires_at > ?
			GROUP BY d.id
			ORDER BY d.created_at DESC`,
		)
		.bind(now)
		.all<DocumentWithShares>();
	return results;
}

/** Identity only, no version resolved — enough to answer "does it exist?". */
export async function getDocument(db: D1Database, id: string): Promise<DocumentRow | null> {
	return db.prepare("SELECT * FROM document WHERE id = ?").bind(id).first<DocumentRow>();
}

/**
 * The current version of a document, or null when the document is missing or
 * its owner TTL is set and has passed.
 */
export async function getLiveDocument(db: D1Database, id: string, now: number): Promise<ResolvedDocument | null> {
	return db
		.prepare(
			`SELECT ${RESOLVED_COLUMNS}
			FROM document d
			${CURRENT_JOIN}
			WHERE d.id = ? AND (d.expires_at IS NULL OR d.expires_at >= ?)`,
		)
		.bind(id, now)
		.first<ResolvedDocument>();
}

/**
 * A live document pinned to one specific version — the owner-only history path.
 * null for an unknown version, exactly like an unknown document, so both fold
 * into the same uniform 404.
 */
export async function getLiveDocumentAtVersion(
	db: D1Database,
	id: string,
	version: number,
	now: number,
): Promise<ResolvedDocument | null> {
	return db
		.prepare(
			`SELECT ${RESOLVED_COLUMNS}
			FROM document d
			JOIN document_version dv ON dv.document_id = d.id AND dv.version = ?
			WHERE d.id = ? AND (d.expires_at IS NULL OR d.expires_at >= ?)`,
		)
		.bind(version, id, now)
		.first<ResolvedDocument>();
}

/** Delete a document row; cascades to its versions and shares. Returns whether a row existed. */
export async function deleteDocument(db: D1Database, id: string): Promise<boolean> {
	const res = await db.prepare("DELETE FROM document WHERE id = ?").bind(id).run();
	return (res.meta.changes ?? 0) > 0;
}

/**
 * The number to give the next version: MAX(version) + 1, never
 * current_version + 1 — after a rollback the pointer trails the maximum, and
 * reusing a number would collide with (or overwrite) recorded history.
 */
export async function nextVersion(db: D1Database, id: string): Promise<number> {
	const row = await db
		.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM document_version WHERE document_id = ?")
		.bind(id)
		.first<{ next: number }>();
	return row?.next ?? 1;
}

/**
 * Stage a version row. false when (document_id, version) is already taken —
 * the composite PK makes a lost update impossible, so a racing writer loses
 * here and can retry with a freshly allocated number.
 */
export async function insertVersion(db: D1Database, row: VersionRow): Promise<boolean> {
	try {
		await db
			.prepare("INSERT INTO document_version (document_id, version, kind, r2_key, created_at) VALUES (?, ?, ?, ?, ?)")
			.bind(row.document_id, row.version, row.kind, row.r2_key, row.created_at)
			.run();
		return true;
	} catch (err) {
		if (isUniqueViolation(err)) return false;
		throw err;
	}
}

/** All versions of a document, newest first. */
export async function listVersions(db: D1Database, id: string): Promise<VersionRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM document_version WHERE document_id = ? ORDER BY version DESC")
		.bind(id)
		.all<VersionRow>();
	return results;
}

export async function getVersion(db: D1Database, id: string, version: number): Promise<VersionRow | null> {
	return db
		.prepare("SELECT * FROM document_version WHERE document_id = ? AND version = ?")
		.bind(id, version)
		.first<VersionRow>();
}

/** Every blob key of a document. Call this BEFORE deleting the row — the FK cascade wipes the version rows. */
export async function listVersionKeys(db: D1Database, id: string): Promise<string[]> {
	const { results } = await db
		.prepare("SELECT r2_key FROM document_version WHERE document_id = ?")
		.bind(id)
		.all<{ r2_key: string }>();
	return results.map((row) => row.r2_key);
}

/**
 * Atomic cutover to a freshly uploaded version: one guarded UPDATE, so readers
 * see either the old version or the new one. `title` of null keeps the current
 * title. false when the version does not exist (the EXISTS guard is what keeps
 * current_version pointing at a real row — an invariant no FK can express,
 * since the two tables reference each other).
 */
export async function applyNewVersion(
	db: D1Database,
	id: string,
	version: number,
	now: number,
	title: string | null,
): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE document SET current_version = ?, updated_at = ?, title = COALESCE(?, title)
			WHERE id = ? AND EXISTS (SELECT 1 FROM document_version WHERE document_id = document.id AND version = ?)`,
		)
		.bind(version, now, title, id, version)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Move the pointer to an existing version (rollback). false when it does not exist. */
export async function setCurrentVersion(db: D1Database, id: string, version: number, now: number): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE document SET current_version = ?, updated_at = ?
			WHERE id = ? AND EXISTS (SELECT 1 FROM document_version WHERE document_id = document.id AND version = ?)`,
		)
		.bind(version, now, id, version)
		.run();
	return (res.meta.changes ?? 0) > 0;
}

/** Drop a staged version row — compensation for a failed blob write. */
export async function deleteVersion(db: D1Database, id: string, version: number): Promise<void> {
	await db.prepare("DELETE FROM document_version WHERE document_id = ? AND version = ?").bind(id, version).run();
}

export async function insertShare(db: D1Database, row: ShareRow): Promise<void> {
	await db
		.prepare("INSERT INTO share (token, document_id, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?)")
		.bind(row.token, row.document_id, row.created_at, row.expires_at, row.revoked)
		.run();
}

/** Active (not revoked, not expired) shares for a document, newest first. */
export async function listShares(db: D1Database, documentId: string, now: number): Promise<ShareRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM share WHERE document_id = ? AND revoked = 0 AND expires_at > ? ORDER BY created_at DESC")
		.bind(documentId, now)
		.all<ShareRow>();
	return results;
}

/**
 * The live document granted by a live share token, resolved to its current
 * version, in one JOIN — the `/raw/s_…` hot path. Live share = not revoked, not
 * expired; live document = no owner TTL or it hasn't passed. There is
 * deliberately no way to ask for another version here: shares always follow the
 * current one (SPEC §6.2).
 */
export async function getLiveDocumentByShareToken(
	db: D1Database,
	token: string,
	now: number,
): Promise<ResolvedDocument | null> {
	return db
		.prepare(
			`SELECT ${RESOLVED_COLUMNS}
			FROM document d
				${CURRENT_JOIN}
				JOIN share s ON s.document_id = d.id
				WHERE s.token = ? AND s.revoked = 0 AND s.expires_at > ?
					AND (d.expires_at IS NULL OR d.expires_at >= ?)`,
		)
		.bind(token, now, now)
		.first<ResolvedDocument>();
}

export async function getLiveShare(db: D1Database, token: string, now: number): Promise<ShareRow | null> {
	return db
		.prepare("SELECT * FROM share WHERE token = ? AND revoked = 0 AND expires_at > ?")
		.bind(token, now)
		.first<ShareRow>();
}

export async function revokeShare(db: D1Database, token: string): Promise<boolean> {
	const res = await db.prepare("UPDATE share SET revoked = 1 WHERE token = ?").bind(token).run();
	return (res.meta.changes ?? 0) > 0;
}
