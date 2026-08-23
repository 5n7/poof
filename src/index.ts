import { Hono } from "hono";

import { runCleanup } from "./cron";
import { csrfProtection } from "./lib/http";
import { accessAuth } from "./middleware/access";
import { apiRoutes } from "./routes/api";
import { mcpRoutes } from "./routes/mcp";
import { libraryPage, ownerViewerPage, publicViewerPage } from "./routes/pages";
import { rawRoutes } from "./routes/raw";

const app = new Hono<{ Bindings: Env }>();

// Public paths first — these must NOT sit behind Access (SPEC §6.2): a
// sandboxed iframe has an opaque origin, so Access cookies are never sent.
app.route("/raw", rawRoutes);
app.get("/v/:token", publicViewerPage);

// Access-protected surfaces. Exact-path middleware registration (not "*") keeps
// /raw and /v public — see PLAN §3.1 route-ordering pitfall.
//
// The write surfaces list both guards here, together: "behind Access" and
// "CSRF-guarded" are one decision about one surface, and splitting them across
// two files is what lets a new route get half of them. Adding a write surface
// without `csrfProtection` would fail silently — nothing tests a route that does
// not exist yet — so the two are kept physically adjacent instead.
app.use("/api/*", accessAuth, csrfProtection);
app.use("/", accessAuth);
app.use("/d/*", accessAuth);
app.use("/mcp", accessAuth, csrfProtection);
app.route("/api", apiRoutes);
app.route("/mcp", mcpRoutes);
app.get("/", libraryPage);
app.get("/d/:id", ownerViewerPage);

export default {
	fetch: app.fetch,
	scheduled: (_event, env, ctx) => ctx.waitUntil(runCleanup(env)),
} satisfies ExportedHandler<Env>;
