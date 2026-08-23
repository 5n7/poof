import { Hono } from "hono";
import type { Context } from "hono";

import { getLiveDocument, listDocuments, listShares, listVersions, revokeShare } from "../lib/db";
import {
	MAX_BYTES,
	addVersion,
	createDocument,
	deleteDocumentWithBlobs,
	issueShare,
	readVersionBlob,
	rollbackDocument,
} from "../lib/documents";
import { API_CONTENT_HEADERS, isVersionString, uniform404, withHeaders } from "../lib/http";
import { nowSeconds } from "../lib/time";
import { parseTtl } from "../lib/tokens";

/** All routes here sit behind `accessAuth` and `csrfProtection` (wired in index.ts). */
export const apiRoutes = new Hono<{ Bindings: Env }>();

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
	const id = await createDocument(c.env, now, { expires_at, kind: upload.kind, source, title });

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
	if (!(await deleteDocumentWithBlobs(c.env, id))) return uniform404(c);
	return c.json({ deleted: true });
});

apiRoutes.post("/documents/:id/versions", async (c) => {
	const id = c.req.param("id");
	const now = nowSeconds();
	// getLiveDocument, not getDocument: no new versions for owner-expired documents.
	// Resolved before the body is read, so a missing document costs nothing.
	const doc = await getLiveDocument(c.env.DB, id, now);
	if (!doc) return uniform404(c);

	const upload = await readUpload(c);
	if (upload instanceof Response) return upload;

	const source = await upload.file.text();
	const added = await addVersion(c.env, doc, now, { kind: upload.kind, source, title: upload.title });
	// null = the document was deleted mid-request, which folds into the same 404
	// as any other missing document.
	if (!added) return uniform404(c);

	return c.json(
		{ id, version: added.version, kind: upload.kind, title: added.title, updated_at: now, url: `/d/${id}` },
		201,
	);
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

apiRoutes.use("/documents/:id/content", withHeaders(API_CONTENT_HEADERS));

/**
 * The stored HTML of one version — what `poof cat` prints. A `?v=N` pin is
 * accepted here and refused on `/raw` for the same reason: there the token *is*
 * the authorization, so a version in the URL would let anyone holding a share
 * link enumerate history, while this route sits behind Access, where the
 * session is the authorization and the URL grants nothing on its own.
 */
apiRoutes.get("/documents/:id/content", async (c) => {
	const id = c.req.param("id");
	// Same split as the rollback handler: malformed input is a 400, a well-formed
	// but unknown version falls into the uniform 404 below.
	const raw = c.req.query("v");
	if (raw !== undefined && !isVersionString(raw)) return c.json({ error: "invalid version" }, 400);
	const asked = raw === undefined ? null : Number(raw);

	// A staged version can exist without its blob (phase 1 → 2 of an upload), and
	// documents run to 10 MiB — so stream the body straight through, as /raw does.
	const obj = await readVersionBlob(c.env, id, asked, nowSeconds());
	if (!obj) return uniform404(c);

	return new Response(obj.body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
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

	const result = await rollbackDocument(c.env, doc, version, now);
	if (!result) return uniform404(c);
	return c.json(result);
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

	const row = await issueShare(c.env, id, now, secs);
	return c.json({ token: row.token, expires_at: row.expires_at, url: `/v/${row.token}` }, 201);
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
