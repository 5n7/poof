import type { Context, Next } from "hono";
import { verifyWithJwks } from "hono/jwt";

/**
 * Verify Cloudflare Access JWTs as a second check. Access also runs in front of
 * these routes in production. Validate `Cf-Access-Jwt-Assertion`
 * against the team's JWKS; service-token auth issues the same JWT shape, so no
 * extra branch is needed. Skipped entirely for local dev (`DEV_DISABLE_ACCESS`).
 */
export async function accessAuth(c: Context<{ Bindings: Env }>, next: Next) {
	if (c.env.DEV_DISABLE_ACCESS === "1") return next();

	const token = c.req.header("Cf-Access-Jwt-Assertion");
	if (!token) return c.text("Forbidden", 403);

	try {
		await verifyWithJwks(token, {
			jwks_uri: `https://${c.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
			allowedAlgorithms: ["RS256"],
			verification: { aud: c.env.ACCESS_AUD },
		});
	} catch {
		return c.text("Forbidden", 403);
	}

	return next();
}
