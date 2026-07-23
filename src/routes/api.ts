import { Hono } from "hono";
import type { Context, Next } from "hono";

import {
	type DocumentRow,
	type ShareRow,
	deleteDocument,
	getDocument,
	getLiveDocument,
	insertDocument,
	insertShare,
	listDocuments,
	listShares,
	revokeShare,
} from "../lib/db";
import { uniform404 } from "../lib/http";
import { renderMarkdown, wrapViewerHtml } from "../lib/render";
import { nowSeconds } from "../lib/time";
import { newShareToken, parseTtl, randomToken } from "../lib/tokens";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

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

apiRoutes.post("/documents", async (c) => {
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
	const title = typeof titleField === "string" && titleField.trim() ? titleField.trim() : file.name;

	const now = nowSeconds();
	let expires_at: number | null = null;
	const ttlField = form.get("ttl");
	if (typeof ttlField === "string" && ttlField) {
		const secs = parseTtl(ttlField);
		if (secs === null) return c.json({ error: "invalid ttl" }, 400);
		expires_at = now + secs;
	}

	const source = await file.text();
	const html = kind === "md" ? wrapViewerHtml(title, renderMarkdown(source)) : source;

	const id = randomToken();
	const r2_key = `doc/${id}.html`;

	// Insert the row BEFORE the blob: the weekly orphan sweep deletes any doc/
	// blob without a matching row, so a blob that briefly exists without a row
	// could be swept mid-upload. If the put then fails, roll the row back.
	const row: DocumentRow = { id, title, kind, r2_key, created_at: now, expires_at };
	await insertDocument(c.env.DB, row);
	try {
		await c.env.BLOBS.put(r2_key, html);
	} catch (err) {
		await deleteDocument(c.env.DB, id).catch(() => {});
		throw err;
	}

	return c.json({ id, title, kind, created_at: now, expires_at, url: `/d/${id}` }, 201);
});

apiRoutes.get("/documents", async (c) => {
	const documents = await listDocuments(c.env.DB);
	return c.json({ documents });
});

apiRoutes.delete("/documents/:id", async (c) => {
	const id = c.req.param("id");
	const doc = await getDocument(c.env.DB, id);
	if (!doc) return uniform404(c);
	// Independent of each other — the blob and the row (which cascades shares).
	await Promise.all([c.env.BLOBS.delete(doc.r2_key), deleteDocument(c.env.DB, id)]);
	return c.json({ deleted: true });
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
