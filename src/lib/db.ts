export interface DocumentRow {
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

export async function insertDocument(db: D1Database, row: DocumentRow): Promise<void> {
	await db
		.prepare("INSERT INTO document (id, title, kind, r2_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(row.id, row.title, row.kind, row.r2_key, row.created_at, row.expires_at)
		.run();
}

export async function listDocuments(db: D1Database): Promise<DocumentRow[]> {
	const { results } = await db.prepare("SELECT * FROM document ORDER BY created_at DESC").all<DocumentRow>();
	return results;
}

export interface DocumentWithShares extends DocumentRow {
	active_share_count: number;
	next_share_expires_at: number | null;
}

/**
 * Every document (newest first) with its active-share aggregate, in one query.
 * "Active" = not revoked and not yet expired at `now`. `next_share_expires_at`
 * is the soonest expiry among those active shares, or null when there are none.
 */
export async function listDocumentsWithShares(db: D1Database, now: number): Promise<DocumentWithShares[]> {
	const { results } = await db
		.prepare(
			`SELECT d.*,
				COUNT(s.token) AS active_share_count,
				MIN(s.expires_at) AS next_share_expires_at
			FROM document d
			LEFT JOIN share s
				ON s.document_id = d.id AND s.revoked = 0 AND s.expires_at > ?
			GROUP BY d.id
			ORDER BY d.created_at DESC`,
		)
		.bind(now)
		.all<DocumentWithShares>();
	return results;
}

export async function getDocument(db: D1Database, id: string): Promise<DocumentRow | null> {
	return db.prepare("SELECT * FROM document WHERE id = ?").bind(id).first<DocumentRow>();
}

/** null when the document is missing, or its owner TTL is set and has passed. */
export async function getLiveDocument(db: D1Database, id: string, now: number): Promise<DocumentRow | null> {
	const row = await getDocument(db, id);
	if (!row) return null;
	if (row.expires_at !== null && row.expires_at < now) return null;
	return row;
}

/** Delete a document row; cascades to its shares. Returns whether a row existed. */
export async function deleteDocument(db: D1Database, id: string): Promise<boolean> {
	const res = await db.prepare("DELETE FROM document WHERE id = ?").bind(id).run();
	return (res.meta.changes ?? 0) > 0;
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
 * The live document granted by a live share token, in one JOIN — the `/raw/s_…`
 * hot path. Live share = not revoked, not expired; live document = no owner TTL
 * or it hasn't passed. Equivalent to `getLiveShare` then `getLiveDocument`.
 */
export async function getLiveDocumentByShareToken(
	db: D1Database,
	token: string,
	now: number,
): Promise<DocumentRow | null> {
	return db
		.prepare(
			`SELECT d.* FROM document d
				JOIN share s ON s.document_id = d.id
				WHERE s.token = ? AND s.revoked = 0 AND s.expires_at > ?
					AND (d.expires_at IS NULL OR d.expires_at >= ?)`,
		)
		.bind(token, now, now)
		.first<DocumentRow>();
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
