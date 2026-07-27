import { Hono } from "hono";
import type { Context, Next } from "hono";

import { deleteBlobs } from "../lib/batch";
import {
	type ShareRow,
	applyNewVersion,
	deleteDocument,
	deleteVersion,
	getDocument,
	getLiveDocument,
	getVersion,
	insertDocument,
	insertShare,
	insertVersion,
	listDocuments,
	listShares,
	listVersionKeys,
	listVersions,
	nextVersion,
	revokeShare,
	setCurrentVersion,
	versionR2Key,
} from "../lib/db";
import { isVersionString, uniform404 } from "../lib/http";
import { renderMarkdown, wrapViewerHtml } from "../lib/render";
import { nowSeconds } from "../lib/time";
import { newShareToken, parseTtl, randomToken } from "../lib/tokens";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Attempts at allocating a version number before giving up (see insertVersion). */
const MAX_VERSION_ATTEMPTS = 3;

/** All routes here sit behind `accessAuth` (wired in index.ts). */
export const apiRoutes = new Hono<{ Bindings: Env }>();

/**
 * CSRF guard for state-changing requests. A cross-origin form/script can drive
 * the browser to POST/DELETE with the user's Access cookie attached, so we
 * reject any `Sec-Fetch-Site` the browser reports as cross-origin. The header
 * is absent on non-browser clients (the CLI's Node fetch, service tokens), so
 * an absent value must pass. Safe methods (GET) are never guarded.
 */
async function csrfProtection(c: Context<{ Bindings: Env }>, next: Next) {
	if (c.req.method !== "GET") {
		const site = c.req.header("Sec-Fetch-Site");
		if (site !== undefined && site !== "same-origin" && site !== "none") {
			return c.text("Forbidden", 403);
		}
	}
	return next();
}

apiRoutes.use("*", csrfProtection);

interface Upload {
	file: File;
	kind: "md" | "html";
	title: string | null;
}

/**
 * Parse the upload multipart body shared by "create document" and "add
 * version". Returns a Response on rejection (413 too large, 400 missing file /
 * bad kind) so both routes fail identically. `title` is null when absent or
 * blank; only the create path falls back to the file name, since on a version
 * upload "no title" means "keep the document's current one".
 */
async function readUpload(c: Context<{ Bindings: Env }>): Promise<Upload | Response> {
	const contentLength = Number(c.req.header("Content-Length") ?? "0");
	if (contentLength > MAX_BYTES) return c.text("Payload Too Large", 413);

	const form = await c.req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
	if (file.size > MAX_BYTES) return c.text("Payload Too Large", 413);

	const kind = form.get("kind");
	if (kind !== "md" && kind !== "html") {
		return c.json({ error: "kind must be 'md' or 'html'" }, 400);
	}

	const titleField = form.get("title");
	const title = typeof titleField === "string" && titleField.trim() ? titleField.trim() : null;

	return { file, kind, title };
}

apiRoutes.post("/documents", async (c) => {
	const upload = await readUpload(c);
	if (upload instanceof Response) return upload;
	const title = upload.title ?? upload.file.name;

	const now = nowSeconds();
	let expires_at: number | null = null;
	// Hono caches the parsed body, so this is the same FormData readUpload read.
	const ttlField = (await c.req.formData()).get("ttl");
	if (typeof ttlField === "string" && ttlField) {
		const secs = parseTtl(ttlField);
		if (secs === null) return c.json({ error: "invalid ttl" }, 400);
		expires_at = now + secs;
	}

	const source = await upload.file.text();
	const html = upload.kind === "md" ? wrapViewerHtml(title, renderMarkdown(source)) : source;

	const id = randomToken();
	const r2_key = versionR2Key(id, 1);

	// Insert the rows BEFORE the blob: the weekly orphan sweep deletes any doc/
	// blob without a matching version row, so a blob that briefly exists without
	// a row could be swept mid-upload. If the put then fails, roll the rows back.
	await insertDocument(c.env.DB, { id, title, kind: upload.kind, r2_key, created_at: now, expires_at });
	try {
		await c.env.BLOBS.put(r2_key, html);
	} catch (err) {
		await deleteDocument(c.env.DB, id).catch(() => {});
		throw err;
	}

	return c.json(
		{ id, title, kind: upload.kind, version: 1, created_at: now, updated_at: now, expires_at, url: `/d/${id}` },
		201,
	);
});

apiRoutes.get("/documents", async (c) => {
	const documents = await listDocuments(c.env.DB);
	return c.json({ documents });
});

apiRoutes.delete("/documents/:id", async (c) => {
	const id = c.req.param("id");
	const doc = await getDocument(c.env.DB, id);
	if (!doc) return uniform404(c);
	// Read the keys before the row goes: the cascade wipes document_version.
	const keys = await listVersionKeys(c.env.DB, id);
	// Independent of each other — the blobs and the row (which cascades shares).
	await Promise.all([deleteBlobs(c.env.BLOBS, keys), deleteDocument(c.env.DB, id)]);
	return c.json({ deleted: true });
});

/**
 * Add a version and make it live. Three phases, in this order, because two
 * hazards pull against each other: a blob with no row can be swept mid-upload,
 * and a current_version pointing at an unwritten blob 404s live share links.
 */
apiRoutes.post("/documents/:id/versions", async (c) => {
	const id = c.req.param("id");
	const now = nowSeconds();
	// getLiveDocument, not getDocument: no new versions for owner-expired documents.
	const doc = await getLiveDocument(c.env.DB, id, now);
	if (!doc) return uniform404(c);

	const upload = await readUpload(c);
	if (upload instanceof Response) return upload;
	// An absent title keeps the current one: retitling a document on every content
	// fix (down to the <title> on the recipient's page) would be a surprise.
	const title = upload.title ?? doc.title;
	const source = await upload.file.text();
	const html = upload.kind === "md" ? wrapViewerHtml(title, renderMarkdown(source)) : source;

	// Phase 1: stage the row. It precedes the blob, and since current_version has
	// not moved yet every reader still sees the old version. The number is
	// MAX(version) + 1 — after a rollback current_version + 1 would collide.
	let version = 0;
	let r2_key = "";
	for (let attempt = 1; ; attempt++) {
		version = await nextVersion(c.env.DB, id);
		r2_key = versionR2Key(id, version);
		const row = { document_id: id, version, kind: upload.kind, r2_key, created_at: now };
		if (await insertVersion(c.env.DB, row)) break;
		// Lost the composite-PK race — reallocate rather than overwrite history.
		if (attempt >= MAX_VERSION_ATTEMPTS) throw new Error(`could not allocate a version for document ${id}`);
	}

	// Phase 2: the blob. Nothing user-visible has moved, so a failure here just
	// drops the staged row.
	try {
		await c.env.BLOBS.put(r2_key, html);
	} catch (err) {
		await deleteVersion(c.env.DB, id, version).catch(() => {});
		throw err;
	}

	const discardStaged = async () => {
		await Promise.all([
			deleteVersion(c.env.DB, id, version).catch(() => {}),
			c.env.BLOBS.delete(r2_key).catch(() => {}),
		]);
	};

	// Phase 3: the cutover, last — one guarded UPDATE, only now that the blob
	// exists. Readers therefore see either the old version or the new one, never
	// a pointer to a missing blob.
	let applied: boolean;
	try {
		applied = await applyNewVersion(c.env.DB, id, version, now, upload.title);
	} catch (err) {
		await discardStaged();
		throw err;
	}
	// false only if the document was deleted mid-request (its version rows went
	// with it), which folds into the same 404 as any other missing document.
	if (!applied) {
		await discardStaged();
		return uniform404(c);
	}

	return c.json({ id, version, kind: upload.kind, title, updated_at: now, url: `/d/${id}` }, 201);
});

apiRoutes.get("/documents/:id/versions", async (c) => {
	const id = c.req.param("id");
	const now = nowSeconds();
	const doc = await getLiveDocument(c.env.DB, id, now);
	if (!doc) return uniform404(c);

	const versions = await listVersions(c.env.DB, id);
	// r2_key stays server-side: nothing outside the blob paths needs it.
	return c.json({
		current_version: doc.current_version,
		versions: versions.map((v) => ({ version: v.version, kind: v.kind, created_at: v.created_at })),
	});
});

apiRoutes.post("/documents/:id/versions/:version/rollback", async (c) => {
	const id = c.req.param("id");
	// Malformed input is a 400; a well-formed but unknown version falls into the
	// uniform 404 below, like any other thing that isn't there.
	const raw = c.req.param("version");
	if (!isVersionString(raw)) return c.json({ error: "invalid version" }, 400);
	const version = Number(raw);

	const now = nowSeconds();
	const doc = await getLiveDocument(c.env.DB, id, now);
	if (!doc) return uniform404(c);
	// Already live: an idempotent no-op must not bump updated_at.
	if (doc.current_version === version) {
		return c.json({ current_version: doc.current_version, updated_at: doc.updated_at });
	}

	// A staged row is committed before its blob (phase 1 → 2 above), so a crash in
	// that window leaves a version row with nothing behind it — and it looks like
	// any other version in the history. current_version must never land on one:
	// that would 404 every live share link, not just this read. Confirming the
	// blob costs one R2 round trip on a cold owner-only path.
	const target = await getVersion(c.env.DB, id, version);
	if (!target || !(await c.env.BLOBS.head(target.r2_key))) return uniform404(c);

	// Pointer move only — no blob is copied, so there is nothing to unwind.
	const ok = await setCurrentVersion(c.env.DB, id, version, now);
	if (!ok) return uniform404(c);
	return c.json({ current_version: version, updated_at: now });
});

apiRoutes.post("/documents/:id/shares", async (c) => {
	const id = c.req.param("id");
	const now = nowSeconds();
	// getLiveDocument, not getDocument: no shares for owner-expired documents.
	const doc = await getLiveDocument(c.env.DB, id, now);
	if (!doc) return uniform404(c);

	const body = await c.req.json<{ ttl?: string }>().catch(() => ({}) as { ttl?: string });
	const ttl = (typeof body.ttl === "string" && body.ttl) || "1d";
	const secs = parseTtl(ttl);
	if (secs === null) return c.json({ error: "invalid ttl" }, 400);

	const token = newShareToken();
	const row: ShareRow = {
		token,
		document_id: id,
		created_at: now,
		expires_at: now + secs,
		revoked: 0,
	};
	await insertShare(c.env.DB, row);

	return c.json({ token, expires_at: row.expires_at, url: `/v/${token}` }, 201);
});

apiRoutes.get("/documents/:id/shares", async (c) => {
	const id = c.req.param("id");
	const now = nowSeconds();
	const shares = await listShares(c.env.DB, id, now);
	return c.json({ shares });
});

apiRoutes.delete("/shares/:token", async (c) => {
	const token = c.req.param("token");
	const ok = await revokeShare(c.env.DB, token);
	if (!ok) return uniform404(c);
	return c.json({ revoked: true });
});
