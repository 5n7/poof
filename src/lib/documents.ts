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
 * The write-side core of the document library — everything the JSON API and the
 * MCP tools both do. The route files stay thin adapters over this: they own
 * their own input parsing and response shapes (multipart + status codes for
 * `/api`, JSON-RPC tool results for `/mcp`), and nothing else re-implements the
 * render/blob/row sequencing that SPEC §9 pins down.
 *
 * Two calling conventions live here and the split is deliberate. A function that
 * reads a document's fields takes an already-resolved `ResolvedDocument`
 * (`addVersion`, `rollbackDocument`), so an adapter can reject a missing
 * document before it spends anything on parsing the request body. One that only
 * needs the document to exist takes an id and establishes that itself — by
 * resolving it (`issueShare`, `readVersionBlob`) or by reading it off the write
 * (`deleteDocumentWithBlobs`, whose DELETE already reports whether a row was
 * there) — so no adapter can forget the check. The rule is the core's, not
 * whoever remembers to copy it.
 */

/** Upload size cap (SPEC §9). */
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Attempts at allocating a version number before giving up (see insertVersion). */
const MAX_VERSION_ATTEMPTS = 3;

/**
 * UTF-8 size of a document source — the one measure `MAX_BYTES` is counted in.
 * Exported so an adapter that wants to reject early reports the same number this
 * module enforces, rather than agreeing with it only by convention. (`/api` has
 * no need for it: `File.size` is already the byte count.)
 */
export function sourceBytes(source: string): number {
	return new TextEncoder().encode(source).length;
}

/**
 * Refuse an oversized source before anything is rendered or written.
 *
 * Both adapters check the size first, so this should never be what rejects a
 * real request — they can say it better (a 413 on `/api`, an `isError` result on
 * `/mcp`) than a thrown Error can. It is here so the invariant belongs to the
 * core rather than to whoever remembers: a third write adapter that forgets the
 * check gets an exception, not a 10 MiB blob in R2 (SPEC §11.5).
 */
function enforceMaxBytes(source: string): void {
	const bytes = sourceBytes(source);
	if (bytes > MAX_BYTES) throw new Error(`document source is ${bytes} bytes, over the ${MAX_BYTES}-byte limit`);
}

/** Render one version's source to the HTML actually stored in R2 (SPEC §8). */
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
	/** null keeps the document's current title — "no title" means "don't retitle". */
	title: string | null;
}

/** The version an upload landed on, plus the title it is now filed under. */
export interface NewVersion {
	title: string;
	version: number;
}

/**
 * Add a version to a live document and make it live. Three phases, in this
 * order, because two hazards pull against each other: a blob with no row can be
 * swept mid-upload, and a current_version pointing at an unwritten blob 404s
 * live share links.
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
	// absent title (SPEC §8), is deliberate — auto-naming is create-only.
	const title = input.title ?? doc.title;
	const html = renderVersion(input.source, input.kind, title);

	// Phase 1: stage the row. It precedes the blob, and since current_version has
	// not moved yet every reader still sees the old version. The number is
	// MAX(version) + 1 — after a rollback current_version + 1 would collide.
	let version = 0;
	let r2_key = "";
	for (let attempt = 1; ; attempt++) {
		version = await nextVersion(env.DB, doc.id);
		r2_key = versionR2Key(doc.id, version);
		const row = { document_id: doc.id, version, kind: input.kind, r2_key, created_at: now };
		if (await insertVersion(env.DB, row)) break;
		// Lost the composite-PK race — reallocate rather than overwrite history.
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

	// Phase 3: the cutover, last — one guarded UPDATE, only now that the blob
	// exists. Readers therefore see either the old version or the new one, never
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
 * there — the same answer as a missing document, so both fold into one 404.
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
	// that window leaves a version row with nothing behind it — and it looks like
	// any other version in the history. current_version must never land on one:
	// that would 404 every live share link, not just this read. Confirming the
	// blob costs one R2 round trip on a cold owner-only path.
	const target = await getVersion(env.DB, doc.id, version);
	if (!target || !(await env.BLOBS.head(target.r2_key))) return null;

	// Pointer move only — no blob is copied, so there is nothing to unwind.
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
 * between them is part of the contract: liveness is checked before the TTL is
 * parsed, so a request naming an unknown document with a bad TTL is answered
 * "not there", never "bad TTL". That precedence is what keeps an id's existence
 * out of the reply (SPEC §6.3), and it is the same one
 * `POST /documents/:id/versions` keeps by resolving the document before it reads
 * the body. Split across two adapters it would only hold until one of them
 * parsed its TTL first.
 *
 * `not-found` covers an owner-expired document too: a share for one would 404
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
 * Delete a document, every version's blob, and (by cascade) its shares. false
 * when it was not there — taken from the DELETE itself, which already reports
 * whether a row existed, so no separate existence check is needed. A miss costs
 * nothing extra: `listVersionKeys` returns [] and `deleteBlobs` skips R2 on an
 * empty list.
 */
export async function deleteDocumentWithBlobs(env: Env, id: string): Promise<boolean> {
	// Read the keys before the row goes: the cascade wipes document_version.
	const keys = await listVersionKeys(env.DB, id);
	// Independent of each other — the blobs and the row (which cascades shares).
	const [, existed] = await Promise.all([deleteBlobs(env.BLOBS, keys), deleteDocument(env.DB, id)]);
	return existed;
}

/**
 * The stored HTML of one version — what `poof cat` and the MCP `cat` tool read.
 * `version` of null resolves to the current one. null when the document, the
 * version, or (for a version staged without its blob) the blob is not there.
 *
 * The body is handed back undecoded so the API route can stream it: documents
 * run to 10 MiB, and buffering one as a JS string to hand it straight to a
 * `Response` would be pure waste.
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
