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
					ACCESS_AUD: "test",
					OWNER_TOKEN_SECRET: "test-secret",
					DEV_DISABLE_ACCESS: "1",
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
	},
});
