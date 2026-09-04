import { Hono } from "hono";

import { runCleanup } from "./cron";
import { canonicalHost, hostIdentity } from "./lib/hosts";
import { csrfProtection, notConfigured, unknownHost } from "./lib/http";
import { accessAuth } from "./middleware/access";
import { apiRoutes } from "./routes/api";
import { mcpRoutes } from "./routes/mcp";
import { libraryPage, ownerViewerPage, publicViewerPage } from "./routes/pages";
import { rawRoutes } from "./routes/raw";

/**
 * The owner surface: the web library, the JSON API, and the two public paths.
 * Served on `OWNER_HOST` and on nothing else.
 *
 * Register public paths before Access-protected paths (SPEC §6.2). A
 * sandboxed iframe has an opaque origin, so Access cookies are never sent.
 *
 * It deliberately does not mount `/mcp`. The MCP endpoint has its own hostname
 * and its own Access application, and a second mount here would accept this
 * application's JWT for tool calls, which is the boundary the split exists to
 * draw.
 */
const ownerApp = new Hono<{ Bindings: Env }>();

ownerApp.route("/raw", rawRoutes);
ownerApp.get("/v/:token", publicViewerPage);

// Exact-path middleware keeps /raw and /v public. See PLAN §3.1.
//
// The write surfaces list both guards here, together: "behind Access" and
// "CSRF-guarded" are one decision about one surface, and splitting them across
// two files is what lets a new route get half of them. Adding a write surface
// without `csrfProtection` would fail silently because no test can cover a route
// that does not exist yet. Keep both guards together.
ownerApp.use("/api/*", accessAuth("owner"), csrfProtection);
ownerApp.use("/", accessAuth("owner"));
ownerApp.use("/d/*", accessAuth("owner"));
ownerApp.route("/api", apiRoutes);
ownerApp.get("/", libraryPage);
ownerApp.get("/d/:id", ownerViewerPage);

/**
 * The MCP surface: exactly one path, `POST /mcp`. Served on `MCP_HOST` and on
 * nothing else.
 *
 * One route is the whole app, so everything else this hostname is asked for
 * (`/`, `/api/*`, `/raw/*`, `/v/*`) falls through to Hono's 404 without
 * reaching a handler. There is nothing to keep in sync: a route added to
 * `ownerApp` cannot appear here by accident.
 *
 * The path is exact. Hono matches `/mcp` and answers 404 for `/mcp/`, `/mcp//`,
 * and `/mcp/anything`, so the guards below cannot be walked around with a
 * trailing slash. Register the endpoint with clients as
 * `https://mcp.poof.5n7.me/mcp`, with no trailing slash (SPEC §11.1).
 */
const mcpApp = new Hono<{ Bindings: Env }>();

mcpApp.use("/mcp", accessAuth("mcp"), csrfProtection);
mcpApp.route("/mcp", mcpRoutes);

type Surface = "mcp" | "owner" | "unconfigured" | "unknown";

/**
 * Classify a request host.
 *
 * Both hostnames are named explicitly, and an unrecognized host is served
 * nothing. `workers_dev` and `preview_urls` are already off, so no third
 * hostname should reach this Worker; if one ever does, through a zone route
 * added by hand or a hostname moved between Workers, it arrives without an
 * Access application in front of it. Answering it from `ownerApp` would put the
 * library one misconfigured DNS record away from being public.
 *
 * A missing, blank, or malformed pair fails the request rather than guessing, and
 * so does a pair naming one host. Both guarantees the split exists to make ("the
 * MCP host serves only MCP" and "the owner host serves no MCP") rest on these two
 * values being present and naming different hosts.
 *
 * **Distinctness is decided on DNS identity, routing on the full authority.**
 * The two questions need different answers. Whether the vars name one host or
 * two cannot depend on the request's scheme, or `OWNER_HOST=example` against
 * `MCP_HOST=example:443` would fail closed over HTTPS, where 443 is the default
 * and drops, and route as two surfaces over HTTP, where it does not. So the
 * check above ignores the port. Matching a request still honours it, which is
 * what lets `wrangler dev` serve `localhost:8787` and `127.0.0.1:8787` as two
 * surfaces from one process. Case and the trailing DNS root label normalize
 * away in both.
 */
function surfaceFor(env: { MCP_HOST?: string; OWNER_HOST?: string }, url: URL): Surface {
	const mcpIdentity = hostIdentity(env.MCP_HOST);
	const ownerIdentity = hostIdentity(env.OWNER_HOST);
	if (mcpIdentity === null || ownerIdentity === null || mcpIdentity === ownerIdentity) return "unconfigured";

	const requested = canonicalHost(url.host, url.protocol);
	if (requested === null) return "unknown";
	if (requested === canonicalHost(env.MCP_HOST, url.protocol)) return "mcp";
	if (requested === canonicalHost(env.OWNER_HOST, url.protocol)) return "owner";
	return "unknown";
}

/**
 * Route the request to its surface.
 *
 * Typed with a plain `Request` rather than inferred from `ExportedHandler`,
 * whose narrower `IncomingRequestCfProperties` would make
 * `worker.fetch(new Request(…), …)` a type error in the tests that call the
 * Worker directly.
 *
 * The switch is exhaustive, so adding a `Surface` without answering it is a
 * type error rather than a hostname that silently falls through to the library.
 */
function dispatch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
	switch (surfaceFor(env, new URL(request.url))) {
		case "mcp":
			return mcpApp.fetch(request, env, ctx);
		case "owner":
			return ownerApp.fetch(request, env, ctx);
		case "unconfigured":
			return notConfigured();
		case "unknown":
			return unknownHost();
	}
}

export default {
	fetch: dispatch,
	scheduled: (_event, env, ctx) => ctx.waitUntil(runCleanup(env)),
} satisfies ExportedHandler<Env>;
