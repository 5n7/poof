import { deleteBlobs } from "./batch";
import {
	type ResolvedDocument,
	type ShareRow,
	applyNewVersion,
	deleteDocument,
	deleteVersion,
	getLiveDocument,
	getLiveDocumentAt,
	getVersion,
	insertDocument,
	insertShare,
	insertVersion,
	listVersionKeys,
	nextVersion,
	setCurrentVersion,
	versionR2Key,
} from "./db";
import { renderMarkdown, wrapViewerHtml } from "./render";
import { newShareToken, parseTtl, randomToken } from "./tokens";

/**
 * Shared write operations for the JSON API and MCP tools. Route files parse
 * input and format responses. This module owns the render, blob, and row order
 * defined in SPEC §9.
 *
 * Two calling conventions live here and the split is deliberate. A function that
 * reads a document's fields takes an already-resolved `ResolvedDocument`
 * (`addVersion`, `rollbackDocument`), so an adapter can reject a missing
 * document before it spends anything on parsing the request body. One that only
 * needs the document to exist takes an id and checks it by
 * resolving it (`issueShare`, `readVersionBlob`) or by reading it off the write
 * (`deleteDocumentWithBlobs`, whose DELETE reports whether a row was there).
 */

/** Upload size cap (SPEC §9). */
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Attempts at allocating a version number before giving up (see insertVersion). */
const MAX_VERSION_ATTEMPTS = 3;

/**
 * Return a document source's UTF-8 byte length. Adapters use this to enforce the
 * same `MAX_BYTES` limit. `/api` can use `File.size` directly.
 */
export function sourceBytes(source: string): number {
	return new TextEncoder().encode(source).length;
}

/**
 * Refuse an oversized source before anything is rendered or written.
 *
 * Adapters check the size first so they can return their own error format. This
 * guard keeps later adapters from writing an oversized blob (SPEC §11.5).
 */
function enforceMaxBytes(source: string): void {
	const bytes = sourceBytes(source);
	if (bytes > MAX_BYTES) throw new Error(`document source is ${bytes} bytes, over the ${MAX_BYTES}-byte limit`);
}

/** Render one version's source to the HTML stored in R2 (SPEC §8). */
function renderVersion(source: string, kind: "md" | "html", title: string): string {
	return kind === "md" ? wrapViewerHtml(title, renderMarkdown(source)) : source;
}

export interface NewDocumentInput {
	expires_at: number | null;
	kind: "md" | "html";
	source: string;
	title: string;
}

/**
 * Create a document and its version 1.
 *
 * Insert the rows BEFORE the blob: the weekly orphan sweep deletes any doc/blob
 * without a matching version row, so a blob that briefly exists without a row
 * could be swept mid-upload. If the put then fails, roll the rows back.
 */
export async function createDocument(env: Env, now: number, input: NewDocumentInput): Promise<string> {
	enforceMaxBytes(input.source);
	const html = renderVersion(input.source, input.kind, input.title);

	const id = randomToken();
	const r2_key = versionR2Key(id, 1);

	await insertDocument(env.DB, {
		id,
		title: input.title,
		kind: input.kind,
		r2_key,
		created_at: now,
		expires_at: input.expires_at,
	});
	try {
		await env.BLOBS.put(r2_key, html);
	} catch (err) {
		await deleteDocument(env.DB, id).catch(() => {});
		throw err;
	}

	return id;
}

export interface NewVersionInput {
	kind: "md" | "html";
	source: string;
	/** null keeps the document's current title. */
	title: string | null;
}

/** The version an upload landed on, plus the title it is now filed under. */
export interface NewVersion {
	title: string;
	version: number;
}

/**
 * Add a version to a live document in three phases. Stage the row before the
 * blob so cleanup cannot remove it. Move current_version only after the blob
 * exists so live links never point to a missing object.
 *
 * `doc` must already be resolved live by the caller, so that a missing document
 * is rejected before the caller spends anything on parsing its input. null here
 * means the document went away mid-request, which folds into that same "isn't
 * there" answer.
 */
export async function addVersion(
	env: Env,
	doc: ResolvedDocument,
	now: number,
	input: NewVersionInput,
): Promise<NewVersion | null> {
	enforceMaxBytes(input.source);
	// An absent title keeps the current one: retitling a document on every content
	// fix (down to the <title> on the recipient's page) would be a surprise. The
	// asymmetry with `createDocument`, whose callers run the naming chain on an
	// absent title (SPEC §8), is deliberate. Auto-naming is create-only.
	const title = input.title ?? doc.title;
	const html = renderVersion(input.source, input.kind, title);

	// Phase 1: stage the row. It precedes the blob, and since current_version has
	// not moved yet every reader still sees the old version. The number is
	// MAX(version) + 1. After a rollback current_version + 1 would collide.
	let version = 0;
	let r2_key = "";
	for (let attempt = 1; ; attempt++) {
		version = await nextVersion(env.DB, doc.id);
		r2_key = versionR2Key(doc.id, version);
		const row = { document_id: doc.id, version, kind: input.kind, r2_key, created_at: now };
		if (await insertVersion(env.DB, row)) break;
		// A competing request took this version number. Allocate another.
		if (attempt >= MAX_VERSION_ATTEMPTS) throw new Error(`could not allocate a version for document ${doc.id}`);
	}

	// Phase 2: the blob. Nothing user-visible has moved, so a failure here just
	// drops the staged row.
	try {
		await env.BLOBS.put(r2_key, html);
	} catch (err) {
		await deleteVersion(env.DB, doc.id, version).catch(() => {});
		throw err;
	}

	const discardStaged = async () => {
		await Promise.all([
			deleteVersion(env.DB, doc.id, version).catch(() => {}),
			env.BLOBS.delete(r2_key).catch(() => {}),
		]);
	};

	// Phase 3 moves the pointer with one guarded UPDATE after the blob
	// exists. Readers see either the old version or the new one, never
	// a pointer to a missing blob.
	let applied: boolean;
	try {
		applied = await applyNewVersion(env.DB, doc.id, version, now, input.title);
	} catch (err) {
		await discardStaged();
		throw err;
	}
	// false only if the document was deleted mid-request (its version rows went
	// with it), which folds into the same "not found" as any missing document.
	if (!applied) {
		await discardStaged();
		return null;
	}

	return { title, version };
}

/** Where a document's pointer ended up, and when it last moved. */
export interface RollbackResult {
	current_version: number;
	updated_at: number;
}

/**
 * Point a live document at an existing version. null when that version is not
 * there. Missing documents and versions both return 404.
 * Rolling back to the version already live is an idempotent no-op that must not
 * bump updated_at (SPEC §9).
 */
export async function rollbackDocument(
	env: Env,
	doc: ResolvedDocument,
	version: number,
	now: number,
): Promise<RollbackResult | null> {
	if (doc.current_version === version) {
		return { current_version: doc.current_version, updated_at: doc.updated_at };
	}

	// A staged row is committed before its blob (phase 1 → 2 above), so a crash in
	// that window leaves a version row without a blob, but it looks like
	// any other version in the history. current_version must never land on one:
	// that would break this read and every live share link. Confirming the
	// blob costs one R2 round trip on a cold owner-only path.
	const target = await getVersion(env.DB, doc.id, version);
	if (!target || !(await env.BLOBS.head(target.r2_key))) return null;

	// Only move the pointer. No blob needs copying or cleanup.
	const ok = await setCurrentVersion(env.DB, doc.id, version, now);
	if (!ok) return null;
	return { current_version: version, updated_at: now };
}

/** The issued share, or which precondition refused it. */
export type IssueShareResult = { ok: true; share: ShareRow } | { ok: false; reason: "invalid-ttl" | "not-found" };

/**
 * Issue a share token for a live document (SPEC §7).
 *
 * Both preconditions live here rather than in the adapters, and the ORDER
 * between them is part of the contract. Check liveness before parsing the TTL,
 * so a request naming an unknown document with a bad TTL is answered
 * "not there", never "bad TTL". That precedence is what keeps an id's existence
 * out of the reply (SPEC §6.3), and it is the same one
 * `POST /documents/:id/versions` keeps by resolving the document before it reads
 * the body. Split across two adapters it would only hold until one of them
 * parsed its TTL first.
 *
 * `not-found` also covers an owner-expired document. A share for one would 404
 * for the recipient while looking issued to the owner (SPEC §11.5).
 */
export async function issueShare(env: Env, id: string, now: number, ttl: string): Promise<IssueShareResult> {
	if (!(await getLiveDocument(env.DB, id, now))) return { ok: false, reason: "not-found" };

	const ttlSeconds = parseTtl(ttl);
	if (ttlSeconds === null) return { ok: false, reason: "invalid-ttl" };

	const share: ShareRow = {
		token: newShareToken(),
		document_id: id,
		created_at: now,
		expires_at: now + ttlSeconds,
		revoked: 0,
	};
	await insertShare(env.DB, share);
	return { ok: true, share };
}

/**
 * Delete a document, every version's blob, and its shares. Return false when the
 * document was absent. The DELETE reports whether a row existed, so no separate
 * existence check is needed. A miss costs
 * nothing extra: `listVersionKeys` returns [] and `deleteBlobs` skips R2 on an
 * empty list.
 */
export async function deleteDocumentWithBlobs(env: Env, id: string): Promise<boolean> {
	// Read the keys before the row goes: the cascade wipes document_version.
	const keys = await listVersionKeys(env.DB, id);
	const [, existed] = await Promise.all([deleteBlobs(env.BLOBS, keys), deleteDocument(env.DB, id)]);
	return existed;
}

/**
 * Return the stored HTML read by `poof cat` and the MCP `cat` tool.
 * `version` of null resolves to the current one. null when the document, the
 * version, or (for a version staged without its blob) the blob is not there.
 *
 * Keep the body undecoded so the API can stream documents up to 10 MiB.
 */
export async function readVersionBlob(
	env: Env,
	id: string,
	version: number | null,
	now: number,
): Promise<R2ObjectBody | null> {
	const doc = await getLiveDocumentAt(env.DB, id, version, now);
	if (!doc) return null;
	return env.BLOBS.get(doc.r2_key);
}
