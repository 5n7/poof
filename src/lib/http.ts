import type { Context, MiddlewareHandler } from "hono";

/**
 * The single 404 used on all public paths (`/raw`, `/v`, and delete-by-token
 * paths). Missing, expired, and revoked tokens are indistinguishable (SPEC §6.3).
 */
export function uniform404(c: Context): Response {
	return c.text("Not Found", 404);
}

/** A version asked for in a URL: a positive integer with no leading zero. */
const VERSION_PATTERN = /^[1-9][0-9]*$/;

/**
 * Is `raw` a well-formed version number? Only the judgment is shared — what a
 * malformed one means is not: the API answers 400, the viewer pages answer the
 * uniform 404 (SPEC §11.4). Each caller keeps its own response.
 */
export function isVersionString(raw: string): boolean {
	return VERSION_PATTERN.test(raw);
}

/**
 * Security headers on every `/raw/*` response (200s and 404s alike). The CSP
 * `sandbox` directive is the primary security boundary (SPEC §6.1); never add
 * `allow-same-origin`. `no-store` makes revocation take effect immediately.
 * `nosniff` stops the browser from MIME-sniffing 404 bodies into markup.
 * The 200 body additionally carries `Content-Type: text/html; charset=utf-8`;
 * 404s keep the `uniform404` `text/plain` type.
 */
export const RAW_HEADERS: Record<string, string> = {
	"Content-Security-Policy": "sandbox allow-scripts allow-popups",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};

/**
 * Security headers on every `GET /api/documents/:id/content` response (200s,
 * 400s and 404s alike) — the endpoint `poof cat` reads. It hands out untrusted
 * document HTML from the real `poof.5n7.me` origin, where SPEC §6.1 forbids
 * executing it, so a browser that navigates here carrying the Access cookie
 * must see text, never markup: a bare `sandbox` (never `allow-scripts`) plus
 * `nosniff`. The 200 body additionally carries `Content-Type: text/plain;
 * charset=utf-8`, which is what `nosniff` then pins it to; the 400/404 bodies
 * keep their own JSON / `uniform404` types.
 */
export const API_CONTENT_HEADERS: Record<string, string> = {
	"Content-Security-Policy": "sandbox",
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex",
	"X-Content-Type-Options": "nosniff",
	"Cache-Control": "no-store",
};

/** Headers on viewer pages (`/d/*`, `/v/*`) — SPEC §9. */
export const VIEWER_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex",
};

/**
 * Middleware that stamps a fixed header set onto every response leaving a
 * route — 200s, 400s and 404s alike. Applied once at the route rather than per
 * exit path, so the invariant is structural: every exit path carries these.
 */
export function withHeaders(headers: Record<string, string>): MiddlewareHandler {
	const entries = Object.entries(headers);
	return async (c, next) => {
		await next();
		for (const [k, v] of entries) c.res.headers.set(k, v);
	};
}

/** Apply a fixed header set to the response being built for `c`. */
export function applyHeaders(c: Context, headers: Record<string, string>): void {
	for (const [k, v] of Object.entries(headers)) c.header(k, v);
}
