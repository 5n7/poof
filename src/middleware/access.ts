import type { Context, MiddlewareHandler, Next } from "hono";
import { verifyWithJwks } from "hono/jwt";
import type { JWTPayload } from "hono/utils/jwt/types";

import { configured } from "../lib/hosts";
import { notConfigured } from "../lib/http";

/**
 * Which Cloudflare Access application protects a route. The two hostnames are
 * two applications, so each carries its own AUD tag (SPEC §6.5) and a token
 * minted for one must not open the other.
 */
type Audience = "mcp" | "owner";

/** The resolved Access settings for one route. */
interface AccessConfig {
	aud: string;
	teamDomain: string;
}

/**
 * Resolve what `audience` needs to verify a token, or `null` when this
 * deployment cannot enforce Access on the route and the request must be
 * refused (SPEC §6.5).
 *
 * Each route depends on its own AUD tag, so a blank `ACCESS_MCP_AUD` closes the
 * MCP endpoint and leaves the library alone. That is the shipped state: the MCP
 * Access application does not exist yet.
 *
 * Two *equal* tags are the exception that closes both. Equal tags mean one
 * application, one application means one policy set, and a service token or
 * OAuth grant issued for the MCP endpoint would then also open `/api/*`. There
 * is no half of that to keep serving.
 */
function accessConfig(vars: Env, audience: Audience): AccessConfig | null {
	const teamDomain = configured(vars.ACCESS_TEAM_DOMAIN);
	if (teamDomain === "") return null;

	const ownerAud = configured(vars.ACCESS_AUD);
	const mcpAud = configured(vars.ACCESS_MCP_AUD);
	if (ownerAud === mcpAud) return null;

	const aud = audience === "mcp" ? mcpAud : ownerAud;
	return aud === "" ? null : { aud, teamDomain };
}

/**
 * Claims documented for *both* application-token payloads, the identity login
 * and the service token: `type`, `aud`, `exp`, `iss`, `iat`, `sub`.
 *
 * `hono/jwt` validates `exp`, `nbf`, and `iat` only when the claim is present,
 * so a token carrying no `exp` at all would pass its expiry check. Requiring
 * presence here is what closes that.
 *
 * `nbf` appears only in the identity payload, so requiring it for every route
 * would reject every service token; `hono/jwt` still rejects an identity token
 * that carries one and is not valid yet. `sub` is documented in both, so its
 * presence is required, but it is the empty string for a service token, which
 * is why only `isIdentityAssertion` reads its value.
 *
 * `type` is not decoration. Cloudflare documents two values: `"app"` for an
 * application token and `"org"` for the team domain's global session token. The
 * same team key signs both, so without this check an `org` token lifted from a
 * browser session would satisfy every other condition here.
 *
 * See https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
 */
function hasCommonClaims(payload: JWTPayload): boolean {
	return (
		payload.type === "app" &&
		typeof payload.exp === "number" &&
		typeof payload.iat === "number" &&
		typeof payload.sub === "string"
	);
}

/**
 * Whether the assertion came from a human login rather than a service token.
 *
 * Cloudflare's two documented payloads differ in exactly the way this needs.
 * An identity login carries `email` and a UUID `sub`; a service token carries
 * `common_name` (its Client ID) and `"sub": ""`. All three are checked, because
 * any one of them alone is a single point of failure on a boundary whose whole
 * job is to keep a static credential out.
 *
 * `nbf`, `country`, and `identity_nonce` are identity-only too and are
 * deliberately not required. They add no discrimination beyond `email` and
 * `sub`, and each additional requirement is another way for a legitimate owner
 * login to be refused if Cloudflare ever omits one.
 */
function isIdentityAssertion(payload: JWTPayload): boolean {
	return (
		payload.common_name === undefined &&
		typeof payload.sub === "string" &&
		payload.sub !== "" &&
		typeof payload.email === "string" &&
		payload.email !== ""
	);
}

/**
 * Verify the Access JWT Cloudflare injects, as a second check behind Access
 * itself. Both hostnames sit behind an Access application in production, and
 * this is what stops a request that reached the Worker some other way.
 *
 * Read `Cf-Access-Jwt-Assertion`, never the `CF_Authorization` cookie:
 * Cloudflare guarantees the header, and service-token clients send no cookie.
 *
 * The audience is the route's own, which is the whole point of the split. The
 * issuer is pinned to the team domain the JWKS was fetched from, so a token
 * from another Cloudflare team cannot be replayed here even if its signature
 * checks out against a key this team happens to serve.
 *
 * **The two surfaces accept different credentials.** The owner routes take
 * either documented assertion, because the CLI and CI authenticate with the
 * `poof-cli` service token. The MCP endpoint takes an identity assertion only.
 * Its Access application is meant to have no Service Auth policy at all
 * (SPEC §11.2), and this is the Worker-side half of that: if a service-token
 * policy is ever added to the MCP application by hand, or the endpoint is
 * pointed at an application that has one, the static credential still gets a
 * 403 here instead of the full tool set.
 *
 * `DEV_DISABLE_ACCESS` skips this and nothing else. Host and path isolation in
 * `src/index.ts` still applies with it set, so a local MCP client still cannot
 * reach `/api/*`. It must be exactly `"1"`, and it must never be set in
 * production: with it on, an unauthenticated request is the owner.
 */
export function accessAuth(audience: Audience): MiddlewareHandler<{ Bindings: Env }> {
	return async (c: Context<{ Bindings: Env }>, next: Next) => {
		if (c.env.DEV_DISABLE_ACCESS === "1") return next();

		const config = accessConfig(c.env, audience);
		if (!config) return notConfigured();

		const token = c.req.header("Cf-Access-Jwt-Assertion");
		if (!token) return c.text("Forbidden", 403);

		let payload: JWTPayload;
		try {
			payload = await verifyWithJwks(token, {
				jwks_uri: `https://${config.teamDomain}/cdn-cgi/access/certs`,
				allowedAlgorithms: ["RS256"],
				verification: { aud: config.aud, iss: `https://${config.teamDomain}` },
			});
		} catch {
			return c.text("Forbidden", 403);
		}

		if (!hasCommonClaims(payload)) return c.text("Forbidden", 403);
		if (audience === "mcp" && !isIdentityAssertion(payload)) return c.text("Forbidden", 403);

		return next();
	};
}
