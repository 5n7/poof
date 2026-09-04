import type { Context, MiddlewareHandler, Next } from "hono";

/**
 * CSRF guard for state-changing requests on `/api/*` and `/mcp`, the
 * two Access-protected write surfaces. A cross-origin form/script can drive the
 * browser to POST/DELETE with the user's Access cookie attached, so we reject
 * any `Sec-Fetch-Site` the browser reports as cross-origin. The header is absent
 * on non-browser clients (the CLI's fetch, MCP clients, service tokens), so
 * an absent value must pass. Safe methods (GET) are never guarded.
 */
export async function csrfProtection(c: Context<{ Bindings: Env }>, next: Next) {
	if (c.req.method !== "GET") {
		const site = c.req.header("Sec-Fetch-Site");
		if (site !== undefined && site !== "same-origin" && site !== "none") {
			return c.text("Forbidden", 403);
		}
	}
	return next();
}

/**
 * A plain-text response for the host dispatcher in `src/index.ts`, which runs
 * before either Hono app and so has no `Context` to build one from. Spelling
 * out the content type keeps a browser from sniffing the body into markup.
 */
function plain(body: string, status: number): Response {
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=UTF-8" }, status });
}

/**
 * The fail-closed answer to a request the Worker is not configured to serve:
 * a blank or duplicated `MCP_HOST` / `OWNER_HOST`, or a blank
 * `ACCESS_TEAM_DOMAIN` or route audience (SPEC §6.5).
 *
 * 503 rather than 403 because nothing is wrong with the request. A 403 would
 * send the operator hunting through Access policies for a deny that never
 * happened, and it is the status a rejected JWT already produces, so the two
 * failures would be indistinguishable in the logs.
 */
export function notConfigured(): Response {
	return plain("Service Unavailable", 503);
}

/**
 * The answer to a request for a hostname this Worker does not recognize
 * (SPEC §6.5). A 404 says the hostname serves nothing, which is true, and
 * reveals nothing about which hostnames do.
 */
export function unknownHost(): Response {
	return plain("Not Found", 404);
}

/**
 * The single 404 used on all public paths (`/raw`, `/v`, and delete-by-token
 * paths). Missing, expired, and revoked tokens are indistinguishable (SPEC §6.3).
 */
export function uniform404(c: Context): Response {
	return c.text("Not Found", 404);
}

/** Match a positive integer without a leading zero. */
const VERSION_PATTERN = /^[1-9][0-9]*$/;

/**
 * Check whether `raw` is a version number. The API answers malformed input with
 * 400, while viewer pages use the uniform 404 (SPEC §12.4).
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
 * 400s and 404s alike) for the endpoint `poof cat` reads. It returns untrusted
 * document HTML from the real `poof.5n7.me` origin, where SPEC §6.1 forbids
 * executing it, so a browser that navigates here carrying the Access cookie
 * must see text, never markup. Use a bare `sandbox` without `allow-scripts` plus
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

/** Headers on viewer pages (`/d/*`, `/v/*`). See SPEC §9. */
export const VIEWER_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Robots-Tag": "noindex",
};

/**
 * Middleware that stamps a fixed header set onto every response leaving a
 * route, including 200s, 400s, and 404s. Applying them at the route ensures
 * every exit path carries them.
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
