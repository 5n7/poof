import { Hono } from "hono";

import { runCleanup } from "./cron";
import { accessAuth } from "./middleware/access";
import { apiRoutes } from "./routes/api";
import { libraryPage, ownerViewerPage, publicViewerPage } from "./routes/pages";
import { rawRoutes } from "./routes/raw";

const app = new Hono<{ Bindings: Env }>();

// Public paths first — these must NOT sit behind Access (SPEC §6.2): a
// sandboxed iframe has an opaque origin, so Access cookies are never sent.
app.route("/raw", rawRoutes);
app.get("/v/:token", publicViewerPage);

// Access-protected surfaces. Exact-path middleware registration (not "*") keeps
// /raw and /v public — see PLAN §3.1 route-ordering pitfall.
app.use("/api/*", accessAuth);
app.use("/", accessAuth);
app.use("/d/*", accessAuth);
app.route("/api", apiRoutes);
app.get("/", libraryPage);
app.get("/d/:id", ownerViewerPage);

export default {
	fetch: app.fetch,
	scheduled: (_event, env, ctx) => ctx.waitUntil(runCleanup(env)),
} satisfies ExportedHandler<Env>;
