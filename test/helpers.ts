import { env } from "cloudflare:test";

import { insertDocument, insertShare } from "../src/lib/db";

/**
 * Seed a document row through the real insert path (so the column list lives in
 * one place — `src/lib/db`). Writes an R2 blob unless `body` is null; returns
 * the r2 key. Defaults keep existing per-spec behavior.
 */
export async function seedDoc(
	id: string,
	opts: {
		title?: string;
		kind?: "md" | "html";
		createdAt?: number;
		expiresAt?: number | null;
		body?: string | null;
	} = {},
): Promise<string> {
	const r2Key = `doc/${id}.html`;
	if (opts.body !== null) await env.BLOBS.put(r2Key, opts.body ?? "<html><body>doc</body></html>");
	await insertDocument(env.DB, {
		id,
		title: opts.title ?? id,
		kind: opts.kind ?? "html",
		r2_key: r2Key,
		created_at: opts.createdAt ?? 0,
		expires_at: opts.expiresAt ?? null,
	});
	return r2Key;
}

/** Seed a share row through the real insert path. */
export async function seedShare(
	token: string,
	documentId: string,
	opts: { createdAt?: number; expiresAt: number; revoked?: 0 | 1 },
): Promise<void> {
	await insertShare(env.DB, {
		token,
		document_id: documentId,
		created_at: opts.createdAt ?? 0,
		expires_at: opts.expiresAt,
		revoked: opts.revoked ?? 0,
	});
}
