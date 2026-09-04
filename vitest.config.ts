import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// NOTE: PLAN §9 specifies `defineWorkersConfig`, but the pinned
// `@cloudflare/vitest-pool-workers@0.18.x` targets vitest v4, which replaced
// that helper with the `cloudflareTest` Vite plugin + `defineConfig`. The
// replacement keeps the same behavior. `readD1Migrations` loads migrations into
// `TEST_MIGRATIONS`, `test/setup.ts` applies them, and the Miniflare bindings
// match §9.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			// NOTE: Workers AI has no local simulator, and the pool defaults
			// `remoteBindings` to true. Leaving it on would open a real remote proxy
			// session and make real, billable inference calls on every `bun run test`.
			// Switched off, `env.AI` still exists but `run()` rejects with "Binding AI
			// needs to be run remotely". The suite then tests fallback from AI to the
			// first heading and finally the file name.
			remoteBindings: false,
			miniflare: {
				bindings: {
					ACCESS_TEAM_DOMAIN: "t.example",
					// Two distinct AUD tags, because the two hostnames are two Access
					// applications. `accessAuth` refuses to run when the two are equal,
					// so a test that made them the same would see 503, not 403.
					ACCESS_AUD: "test-owner-aud",
					ACCESS_MCP_AUD: "test-mcp-aud",
					// Host isolation is not production-only behavior: the suite reaches
					// the MCP endpoint at MCP_HOST and every other route at OWNER_HOST.
					// Keep both in sync with OWNER_BASE / MCP_BASE in test/helpers.ts.
					MCP_HOST: "mcp.poof.5n7.me",
					OWNER_HOST: "poof.5n7.me",
					OWNER_TOKEN_SECRET: "test-secret",
					DEV_DISABLE_ACCESS: "1",
					// Pinned, not omitted. Miniflare also loads `.dev.vars`, and every
					// var this block leaves out is whatever the developer happens to
					// have in that file. `.dev.vars.example` sets this one to "1", so a
					// checkout that followed docs/SETUP.md step 4 would skip inference
					// and fail the titling fallback tests.
					DEV_DISABLE_AI_TITLES: "",
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.spec.ts"],
		setupFiles: ["./test/setup.ts"],
	},
});
