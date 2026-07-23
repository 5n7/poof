import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// NOTE: PLAN §9 specifies `defineWorkersConfig`, but the pinned
// `@cloudflare/vitest-pool-workers@0.18.x` targets vitest v4, which replaced
// that helper with the `cloudflareTest` Vite plugin + `defineConfig`. The
// functional intent is preserved: migrations loaded via `readD1Migrations` and
// exposed as the `TEST_MIGRATIONS` binding, `test/setup.ts` applies them, and
// the miniflare bindings match §9 exactly.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
	plugins: [
		cloudflareTest({
			main: "./src/index.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
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
