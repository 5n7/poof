import { applyD1Migrations, env } from "cloudflare:test";

// Apply the D1 schema once before the test suite runs. `TEST_MIGRATIONS` is
// populated in vitest.config.ts via `readD1Migrations("./migrations")`.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
