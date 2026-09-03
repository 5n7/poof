import { Hono } from "hono";

import { runCleanup } from "./cron";
import { csrfProtection } from "./lib/http";
import { accessAuth } from "./middleware/access";
import { apiRoutes } from "./routes/api";
import { mcpRoutes } from "./routes/mcp";
import { libraryPage, ownerViewerPage, publicViewerPage } from "./routes/pages";
import { rawRoutes } from "./routes/raw";

const app = new Hono<{ Bindings: Env }>();

// Register public paths before Access-protected paths (SPEC §6.2). A
// sandboxed iframe has an opaque origin, so Access cookies are never sent.
app.route("/raw", rawRoutes);
app.get("/v/:token", publicViewerPage);

// Exact-path middleware keeps /raw and /v public. See PLAN §3.1.
//
// The write surfaces list both guards here, together: "behind Access" and
// "CSRF-guarded" are one decision about one surface, and splitting them across
// two files is what lets a new route get half of them. Adding a write surface
// without `csrfProtection` would fail silently because no test can cover a route
// that does not exist yet. Keep both guards together.
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
