# poof — Setup

One-time setup for deploying poof to `poof.5n7.me` on Cloudflare. Steps run
top-to-bottom; later steps assume the earlier ones succeeded.

## 1. Prerequisites

- **Bun 1.3+** and **Node.js 22+** installed (both pinned in `mise.toml`).
- A **Cloudflare account** that owns the `5n7.me` zone (poof is served from the
  `poof.5n7.me` subdomain as a custom domain route).
- The repository cloned locally, with dependencies installed:

  ```sh
  bun install
  ```

## 2. Log in

Authenticate wrangler against your Cloudflare account:

```sh
bunx wrangler login
```

This opens a browser to authorize the CLI. Confirm the account with
`bunx wrangler whoami`.

## 3. Provision resources

Create the D1 database (`poof-db`) and R2 bucket (`poof-blobs`). The script is
idempotent — re-running it skips resources that already exist:

```sh
./scripts/bootstrap.sh
```

The script prints the D1 **`database_id`** at the end. Copy it into
`wrangler.jsonc`, replacing the `"REPLACE_WITH_OUTPUT_OF_bootstrap.sh"`
placeholder in the `d1_databases` block:

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "poof-db",
  "database_id": "PASTE_THE_ID_HERE",
  "migrations_dir": "migrations"
}]
```

## 4. Secrets

poof signs owner-view (`o_`) tokens with an HMAC secret. Generate a strong
value and store it as the `OWNER_TOKEN_SECRET` secret (never committed to the
repo):

```sh
openssl rand -base64 32 | bunx wrangler secret put OWNER_TOKEN_SECRET
```

For local development, copy `.dev.vars.example` to `.dev.vars` and set a
throwaway `OWNER_TOKEN_SECRET`. `.dev.vars` also carries `DEV_DISABLE_ACCESS=1`,
which bypasses Access JWT verification locally (never set it in production).

## 5. Migrations

Apply the D1 schema (`migrations/0001_init.sql`). Run the remote migration
against the deployed database:

```sh
bun run migrate:remote
```

For local development against the miniflare D1 store:

```sh
bun run migrate:local
```

## 6. Cloudflare Access (Zero Trust dashboard)

poof relies on Cloudflare Access to protect the owner surface while leaving the
public share/raw paths open. Configure three applications in the **Zero Trust**
dashboard (Access → Applications).

### App 1 — Owner surface (self-hosted)

- **Type**: Self-hosted.
- **Path**: `poof.5n7.me/` (protects the library, viewer `/d/*`, and `/api/*`).
- **Policies**:
  - **Allow** — your owner identity (Google account); add **One-Time PIN** as a
    backup login method.
  - **Service Auth** — a policy that accepts the CLI **service token** (created
    below). This lets `poof push` and friends authenticate headlessly.

### App 2 — Public shared viewer (bypass)

- **Type**: Self-hosted, **Bypass** policy for **everyone**.
- **Path**: `poof.5n7.me/v/*`.

### App 3 — Raw blob endpoint (bypass)

- **Type**: Self-hosted, **Bypass** policy for **everyone**.
- **Path**: `poof.5n7.me/raw/*`.

> The `/v/*` and `/raw/*` paths must bypass Access: a sandboxed iframe has an
> opaque origin, so Access's `CF_Authorization` cookie is never sent with those
> requests. The share/owner token in the URL is the authentication for these
> paths.

> ⚠️ Keep the bypass applications to exactly those two paths — **`/api/*` must
> never be added to one**. The API is owner-only by session, not by token: its
> routes list, mutate, and dump documents (`GET /api/documents/:id/content`
> returns the raw stored HTML of any version) with no secret in the URL to
> stand in for authentication. A bypass covering `/api/*` would make the whole
> library world-readable.

### Service token (for the CLI)

Under **Access → Service Auth**, create a service token named **`poof-cli`**.
Record the generated **Client ID** and **Client Secret** — they are shown only
once and become `POOF_ACCESS_CLIENT_ID` / `POOF_ACCESS_CLIENT_SECRET` in step 8.

### Copy the AUD tag and team domain

From **App 1**'s overview, copy the **Application Audience (AUD) tag** and your
**team domain** (e.g. `your-team.cloudflareaccess.com`) into `wrangler.jsonc`
`vars`, replacing the placeholders:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "ACCESS_AUD": "the-app-1-aud-tag"
}
```

The Worker verifies the Access JWT against these values as defense in depth.

## 7. Deploy

Deploy the Worker:

```sh
bun run deploy
```

Verify in the Cloudflare dashboard that:

- the `poof.5n7.me` **custom domain route** exists, and
- **`workers.dev`** is disabled for the Worker (the default `*.workers.dev`
  route would bypass Access entirely; `workers_dev` and `preview_urls` are set
  to `false` in `wrangler.jsonc`).

## 8. CLI setup

Export the service-token credentials from step 6 and the base URL:

```sh
export POOF_URL=https://poof.5n7.me
export POOF_ACCESS_CLIENT_ID=<client-id-from-service-token>
export POOF_ACCESS_CLIENT_SECRET=<client-secret-from-service-token>
```

Make the `poof` command available globally by linking this checkout:

```sh
bun link
```

This installs a `poof` executable into `~/.bun/bin` (make sure that directory
is on your `PATH`); the command follows the checkout, so pulling updates is
enough. If you prefer not to link, a shell alias works too:
`alias poof='bun <repo>/cli/index.ts'`.

Run `poof --help` to confirm the wiring.

## 9. Smoke test

End-to-end check that upload, share, and revocation work:

```sh
poof push README.md --share
```

This prints a `/d/{id}` owner URL and a `/v/{token}` share URL. Then:

1. Open the `/d/{id}` URL (Access will prompt for owner login) and confirm the
   document renders.
2. Open the `/v/{token}` URL in a private window (no login) and confirm the
   shared view renders.
3. Revoke the share and confirm the public URL now 404s:

   ```sh
   poof revoke <share-token>
   ```

   Reloading the `/v/{token}` URL should return **404 Not Found**.
