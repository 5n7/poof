import { Hono } from "hono";

import { type ResolvedDocument, getLiveDocumentAt, getLiveDocumentByShareToken } from "../lib/db";
import { RAW_HEADERS, uniform404, withHeaders } from "../lib/http";
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

	return new Response(obj.body, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
});
