import type { Context } from "hono";

/**
 * The single 404 used on all public paths (`/raw`, `/v`, and delete-by-token
 * paths). Missing, expired, and revoked tokens are indistinguishable (SPEC §6.3).
 */
export function uniform404(c: Context): Response {
	return c.text("Not Found", 404);
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

/** Headers on viewer pages (`/d/*`, `/v/*`) — SPEC §9. */
export const VIEWER_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex",
};

/** Apply a fixed header set to the response being built for `c`. */
export function applyHeaders(c: Context, headers: Record<string, string>): void {
	for (const [k, v] of Object.entries(headers)) c.header(k, v);
}
