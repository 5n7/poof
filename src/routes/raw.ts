import { Hono } from "hono";

import { attachmentDisposition } from "../lib/content";
import { type ResolvedDocument, getLiveDocumentAt, getLiveDocumentByShareToken } from "../lib/db";
import { RAW_HEADERS, uniform404, withHeaders } from "../lib/http";
import { escapeHtml, renderMarkdown, wrapViewerHtml } from "../lib/render";
import { nowSeconds } from "../lib/time";
import { verifyOwnerToken } from "../lib/tokens";

/**
 * Serve public document HTML from `GET /raw/:token` (SPEC §6.2). Accept two token
 * kinds: `s_` share tokens (D1-backed) and `o_` owner tokens (stateless HMAC).
 * Every response carries the sandbox security headers; every failure is the
 * uniform 404 so probes cannot distinguish missing/expired/revoked.
 */
export const rawRoutes = new Hono<{ Bindings: Env }>();

rawRoutes.use("*", withHeaders(RAW_HEADERS));

rawRoutes.get("/:token", async (c) => {
	const token = c.req.param("token");
	const now = nowSeconds();

	let doc: ResolvedDocument | null = null;
	if (token.startsWith("s_")) {
		// Share → current version in one JOIN (see getLiveDocumentByShareToken).
		doc = await getLiveDocumentByShareToken(c.env.DB, token, now);
	} else if (token.startsWith("o_")) {
		const payload = await verifyOwnerToken(token, c.env.OWNER_TOKEN_SECRET, now);
		// The version pin comes from the signed payload and nowhere else: here the
		// token *is* the authorization, so accepting a version from the URL would
		// let anyone holding a share link enumerate the document's history.
		if (payload) doc = await getLiveDocumentAt(c.env.DB, payload.documentId, payload.version, now);
	}
	if (!doc) return uniform404(c);

	const obj = await c.env.BLOBS.get(doc.r2_key);
	if (!obj) return uniform404(c);

	const format = c.req.query("format");
	if (format !== undefined && format !== "raw") {
		await obj.body.cancel();
		return uniform404(c);
	}
	if (format === "raw") {
		return new Response(obj.body, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": attachmentDisposition(doc.filename),
			},
		});
	}
	if (doc.media_type === "image/svg+xml") {
		return new Response(obj.body, { headers: { "Content-Type": "image/svg+xml" } });
	}
	if (doc.kind === "html") {
		return new Response(obj.body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
	}
	const title = doc.version_title ?? doc.title;
	if (doc.kind === "md" || doc.kind === "text") {
		const source = await obj.text();
		const body = doc.kind === "md" ? renderMarkdown(source) : `<pre><code>${escapeHtml(source)}</code></pre>`;
		return new Response(wrapViewerHtml(title, body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
	}
	if (/^(image\/(png|jpeg|gif|webp|avif|x-icon)|audio\/(mpeg|wav|ogg|mp4)|video\/(mp4|webm))$/.test(doc.media_type)) {
		return new Response(obj.body, { headers: { "Content-Type": doc.media_type } });
	}
	await obj.body.cancel();
	const body = `<h1>${escapeHtml(doc.filename ?? title)}</h1><p>${escapeHtml(doc.media_type)} · ${obj.size} bytes</p><p>This file has no browser preview. Use the download button to save the original file.</p>`;
	return new Response(wrapViewerHtml(title, body), { headers: { "Content-Type": "text/html; charset=utf-8" } });
});
