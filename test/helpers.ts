import { env } from "cloudflare:test";

import {
	deleteVersion,
	insertDocument,
	insertShare,
	insertVersion,
	setCurrentVersion,
	versionR2Key,
} from "../src/lib/db";

/**
 * Seed a document row through the real insert path (so the column list lives in
 * one place — `src/lib/db`). Writes an R2 blob unless `body` is null; returns
 * the r2 key. Defaults keep existing per-spec behavior: one version numbered 1
 * under the legacy flat `doc/{id}.html` key that migration 0002 backfilled.
 * Pass `r2Key` for the nested shape, or `version` to start above 1 (for
 * MAX(version) + 1 numbering tests).
 */
export async function seedDoc(
	id: string,
	opts: {
		title?: string;
		kind?: "md" | "html";
		createdAt?: number;
		expiresAt?: number | null;
		body?: string | null;
		version?: number;
		r2Key?: string;
	} = {},
): Promise<string> {
	const version = opts.version ?? 1;
	const createdAt = opts.createdAt ?? 0;
	const kind = opts.kind ?? "html";
	const r2Key = opts.r2Key ?? (version === 1 ? `doc/${id}.html` : versionR2Key(id, version));
	if (opts.body !== null) await env.BLOBS.put(r2Key, opts.body ?? "<html><body>doc</body></html>");
	await insertDocument(env.DB, {
		id,
		title: opts.title ?? id,
		kind,
		r2_key: r2Key,
		created_at: createdAt,
		expires_at: opts.expiresAt ?? null,
	});
	if (version !== 1) {
		// insertDocument always writes version 1; renumber by adding the requested
		// version, moving the pointer (never leaving it dangling), then dropping 1.
		await insertVersion(env.DB, { document_id: id, version, kind, r2_key: r2Key, created_at: createdAt });
		await setCurrentVersion(env.DB, id, version, createdAt);
		await deleteVersion(env.DB, id, 1);
	}
	return r2Key;
}

/**
 * Seed an extra version of an existing document under the nested key shape.
 * Writes an R2 blob unless `body` is null and returns the key. `setCurrent`
 * defaults to true, mirroring what a real upload does.
 */
export async function seedVersion(
	id: string,
	version: number,
	opts: { kind?: "md" | "html"; body?: string | null; createdAt?: number; setCurrent?: boolean } = {},
): Promise<string> {
	const createdAt = opts.createdAt ?? 0;
	const r2Key = versionR2Key(id, version);
	if (opts.body !== null) await env.BLOBS.put(r2Key, opts.body ?? `<html><body>v${version}</body></html>`);
	await insertVersion(env.DB, {
		document_id: id,
		version,
		kind: opts.kind ?? "html",
		r2_key: r2Key,
		created_at: createdAt,
	});
	if (opts.setCurrent !== false) await setCurrentVersion(env.DB, id, version, createdAt);
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

/**
 * Every response header as one "name: value\n" blob — for the negative
 * assertions ("no `allow-*` anywhere in here") that have to cover headers the
 * spec does not name individually.
 */
export function headerDump(res: Response): string {
	let all = "";
	res.headers.forEach((v, k) => {
		all += `${k}: ${v}\n`;
	});
	return all;
}
