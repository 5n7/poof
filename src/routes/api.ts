import { Hono } from "hono";
import type { Context } from "hono";

import { attachmentDisposition, defaultMediaType, inferFileBytes, isDocumentKind } from "../lib/content";
import {
	getLiveDocument,
	getLiveDocumentAt,
	listDocuments,
	listShares,
	listVersions,
	listVersionFiles,
	revokeShare,
} from "../lib/db";
import {
	MAX_BYTES,
	MAX_FILES,
	DocumentInputError,
	type NewFileInput,
	addVersion,
	createDocument,
	deleteDocumentWithBlobs,
	issueShare,
	readVersionContent,
	rollbackDocument,
} from "../lib/documents";
import { MAX_UPLOAD_BYTES } from "../lib/files";
import { API_CONTENT_HEADERS, isVersionString, uniform404, withHeaders } from "../lib/http";
import { nowSeconds } from "../lib/time";
import { resolveNewTitle } from "../lib/title";
import { parseTtl } from "../lib/tokens";

/** All routes here sit behind `accessAuth` and `csrfProtection` (wired in index.ts). */
export const apiRoutes = new Hono<{ Bindings: Env }>();

/** Fixed blocks bound allocation overhead from tiny transport chunks. */
const UPLOAD_BUFFER_BYTES = 64 * 1024;

interface Upload {
	files: NewFileInput[];
	legacy: boolean;
	delete_paths: string[];
	title: string | null;
	ttl: string | File | null;
}

apiRoutes.onError((error, c) => {
	if (error instanceof DocumentInputError) return c.json({ error: error.message }, error.status);
	throw error;
});

/**
 * Parse the upload multipart body shared by "create document" and "add
 * version". Returns a Response on rejection (413 too large, 400 missing file /
 * bad kind) so both routes fail identically. `title` is null when absent or
 * blank; the create path then runs the naming chain (lib/title.ts), while on a
 * version upload "no title" means "keep the document's current one".
 */
async function readUpload(c: Context<{ Bindings: Env }>, update = false): Promise<Upload | Response> {
	const contentLength = Number(c.req.header("Content-Length") ?? "0");
	if (contentLength > MAX_UPLOAD_BYTES) return c.text("Payload Too Large", 413);

	// Count received bytes too: chunked uploads may have no Content-Length.
	const reader = c.req.raw.body?.getReader();
	if (!reader) return c.json({ error: "file is required" }, 400);
	const chunks: Uint8Array[] = [];
	let buffer: Uint8Array | undefined;
	let used = 0;
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > MAX_UPLOAD_BYTES) {
				await reader.cancel();
				return c.text("Payload Too Large", 413);
			}
			// Tiny transport chunks must not each retain an object and backing buffer.
			let offset = 0;
			while (offset < value.byteLength) {
				if (!buffer || used === buffer.byteLength) {
					buffer = new Uint8Array(UPLOAD_BUFFER_BYTES);
					chunks.push(buffer);
					used = 0;
				}
				const length = Math.min(value.byteLength - offset, buffer.byteLength - used);
				buffer.set(value.subarray(offset, offset + length), used);
				used += length;
				offset += length;
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (buffer) chunks[chunks.length - 1] = buffer.subarray(0, used);
	const form = await new Response(new Blob(chunks), { headers: c.req.raw.headers }).formData();
	const uploaded = form.getAll("file");
	const paths = form.getAll("path");
	const removed = form.getAll("delete");
	if (uploaded.length > MAX_FILES || removed.length > MAX_FILES)
		return c.json({ error: `At most ${MAX_FILES} files are allowed.` }, 400);
	if (paths.length && paths.length !== uploaded.length) return c.json({ error: "Each file needs one path." }, 400);
	if ((!uploaded.length && (!update || !removed.length)) || uploaded.some((file) => !(file instanceof File)))
		return c.json({ error: "file is required" }, 400);
	if (paths.some((path) => typeof path !== "string") || removed.some((path) => typeof path !== "string"))
		return c.json({ error: "Paths must be strings." }, 400);
	const files: NewFileInput[] = [];
	let bytes = 0;
	for (let i = 0; i < uploaded.length; i++) {
		const file = uploaded[i] as File;
		bytes += file.size;
		if (bytes > MAX_BYTES) return c.text("Payload Too Large", 413);
		const source = await file.arrayBuffer();
		const inferred = inferFileBytes(file.name, file.type, source);
		const kind = form.get("kind") ?? inferred.kind;
		if (!isDocumentKind(kind)) return c.json({ error: "kind must be 'file', 'html', 'md', or 'text'" }, 400);
		const media_type = kind === inferred.kind ? inferred.media_type : defaultMediaType(kind);
		files.push({
			path: paths.length ? (paths[i] as string) : file.name,
			filename: file.name,
			kind,
			media_type,
			source,
		});
	}
	const titleField = form.get("title");
	const title = typeof titleField === "string" && titleField.trim() ? titleField.trim() : null;
	return {
		files,
		legacy: files.length === 1 && !paths.length && !removed.length,
		delete_paths: removed as string[],
		title,
		ttl: form.get("ttl"),
	};
}

apiRoutes.post("/documents", async (c) => {
	const upload = await readUpload(c);
	if (upload instanceof Response) return upload;

	const now = nowSeconds();
	let expires_at: number | null = null;
	const ttlField = upload.ttl;
	if (typeof ttlField === "string" && ttlField) {
		const secs = parseTtl(ttlField);
		if (secs === null) return c.json({ error: "invalid ttl" }, 400);
		expires_at = now + secs;
	}

	const first = upload.files[0]!;
	const title =
		upload.title ??
		(upload.files.length === 1 && first.kind === "md"
			? await resolveNewTitle(c.env, {
					fallback: first.filename ?? first.path,
					kind: "md",
					source: new TextDecoder().decode(first.source as ArrayBuffer),
				})
			: first.filename?.trim() || "untitled");
	const sources = upload.legacy ? first : { files: upload.files };
	const id = await createDocument(c.env, now, { ...sources, title, expires_at });
	return c.json(
		{
			id,
			title,
			kind: first.kind,
			version: 1,
			created_at: now,
			updated_at: now,
			expires_at,
			file_count: upload.files.length,
			url: `/d/${id}`,
		},
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

	const upload = await readUpload(c, true);
	if (upload instanceof Response) return upload;
	const sources = upload.legacy ? upload.files[0]! : { files: upload.files };
	const added = await addVersion(c.env, doc, now, {
		...sources,
		title: upload.title,
		delete_paths: upload.delete_paths,
	});
	if (!added) return uniform404(c);
	const files = await listVersionFiles(c.env.DB, id, added.version);
	return c.json(
		{
			id,
			version: added.version,
			kind: files[0]!.kind,
			title: added.title,
			updated_at: now,
			file_count: files.length,
			url: `/d/${id}`,
		},
		201,
	);
});

apiRoutes.get("/documents/:id/files", async (c) => {
	const raw = c.req.query("v");
	if (raw !== undefined && !isVersionString(raw)) return c.json({ error: "invalid version" }, 400);
	const doc = await getLiveDocumentAt(
		c.env.DB,
		c.req.param("id"),
		raw === undefined ? null : Number(raw),
		nowSeconds(),
	);
	if (!doc) return uniform404(c);
	const files = await listVersionFiles(c.env.DB, doc.id, doc.version);
	return c.json({
		version: doc.version,
		files: files.map(({ path, filename, kind, media_type, position }) => ({
			path,
			filename,
			kind,
			media_type,
			position,
		})),
	});
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
 * Return readable content, or original stored bytes with `?format=raw`. A `?v=N` pin is
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
	// documents can reach 10 MiB, so stream the body as /raw does.
	const format = c.req.query("format");
	if (format !== undefined && format !== "raw") return c.json({ error: "invalid format" }, 400);
	const obj = await readVersionContent(c.env, id, asked, nowSeconds(), format === "raw", c.req.query("file"));
	if (!obj) return uniform404(c);

	return new Response(obj.body, {
		headers:
			format === "raw"
				? {
						"Content-Type": "application/octet-stream",
						"Content-Disposition": attachmentDisposition(obj.filename),
					}
				: { "Content-Type": "text/plain; charset=utf-8" },
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

	const result = await rollbackDocument(c.env, doc, version, now);
	if (!result) return uniform404(c);
	return c.json(result);
});

// The `Promise<Response>` annotation is what makes the switch below exhaustive:
// without it Hono widens the handler's return to `Response | undefined`, and a
// refusal nobody phrased would fall out of the switch as a silent 200-less
// nothing instead of a type error.
apiRoutes.post("/documents/:id/shares", async (c): Promise<Response> => {
	const id = c.req.param("id");
	const body = await c.req.json<{ ttl?: string }>().catch(() => ({}) as { ttl?: string });
	const ttl = (typeof body.ttl === "string" && body.ttl) || "1d";

	const issued = await issueShare(c.env, id, nowSeconds(), ttl);
	if (issued.ok) {
		const { share } = issued;
		return c.json({ token: share.token, expires_at: share.expires_at, url: `/v/${share.token}` }, 201);
	}
	// Wording only. Which refusal wins when both apply is the core's call, and it
	// has to stay there: a 400 for an unknown id would say the id exists.
	switch (issued.reason) {
		case "invalid-ttl":
			return c.json({ error: "invalid ttl" }, 400);
		case "not-found":
			return uniform404(c);
	}
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
