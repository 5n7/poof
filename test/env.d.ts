import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Extend the test environment with the migrations binding injected in
// vitest.config.ts. `env` from "cloudflare:test" is typed as `Cloudflare.Env`,
// so we merge the extra binding into that namespace.
declare global {
	namespace Cloudflare {
		interface Env {
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}

export {};
