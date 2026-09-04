# poof setup

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
idempotent. Re-running it skips resources that already exist.

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

Workers AI uses the `AI` binding to name untitled documents. It needs no
separate resource because every account has Workers AI enabled by default.

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

Note that Workers AI has **no local simulator**, so `wrangler dev` opens a
remote proxy session for the `AI` binding and `bunx wrangler login` (step 2) is
required either way.

`.dev.vars` also carries `DEV_DISABLE_AI_TITLES=1`, which skips inference.
Local uploads then use the document's first `#` heading, followed by the file
name. MCP uses `untitled` as its final fallback because it has no file. Remove
the line to test the full naming process locally.
Creating an untitled Markdown document through the web UI,
`POST /api/documents`, or the MCP `push` tool then makes an inference call
against your account.

Neither setting makes development offline. wrangler always proxies the `ai`
binding remotely, so development still requires authentication. To work with
no network, comment the `ai` binding out
of `wrangler.jsonc`. If the binding is absent, the Worker uses the next title
fallback.

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

poof relies on Cloudflare Access to protect the owner pages while leaving the
public share/raw paths open. Configure three applications in the **Zero Trust**
dashboard (Access → Applications). The MCP endpoint needs a fourth, on its own
hostname; [MCP-OAUTH-RUNBOOK.md](MCP-OAUTH-RUNBOOK.md) creates that one (step 9).

### App 1: owner pages

- **Type**: Self-hosted.
- **Path**: `poof.5n7.me/` (protects the library, viewer `/d/*`, and `/api/*`).
- **Policies**:
  - **Allow** your owner identity, such as a Google account. Add **One-Time
    PIN** as a backup login method.
  - **Service Auth** accepts the CLI **service token** created below. It lets the
    CLI and CI authenticate without an interactive login.

### App 2: public shared viewer

- **Type**: Self-hosted, **Bypass** policy for **everyone**.
- **Path**: `poof.5n7.me/v/*`.

### App 3: raw blob endpoint

- **Type**: Self-hosted, **Bypass** policy for **everyone**.
- **Path**: `poof.5n7.me/raw/*`.

> The `/v/*` and `/raw/*` paths must bypass Access. A sandboxed iframe has an
> opaque origin, so it does not send Access's `CF_Authorization` cookie with
> these requests. The share or owner token in the URL authenticates them.

> Keep the bypass applications to exactly those two paths. **Never add `/api/*`
> to one, and never put a bypass in front of `mcp.poof.5n7.me`**. Cloudflare
> Access protects both surfaces. Their operations list, change, and dump
> documents (`GET /api/documents/:id/content` and the `cat` tool return the raw
> stored HTML of any version) with no secret in the URL to stand in for
> authentication. A bypass covering either one would make the whole library
> world-readable and world-writable. The MCP endpoint sitting on another
> hostname changes nothing about that.

### Service token (for the CLI)

Under **Access → Service Auth**, create a service token named **`poof-cli`**.
Record the generated **Client ID** and **Client Secret**. They are shown only
once and become `POOF_ACCESS_CLIENT_ID` / `POOF_ACCESS_CLIENT_SECRET` in step 8.
The MCP endpoint does not take this pair. Its application gets no Service Auth
policy, and its clients authenticate through OAuth instead (step 9).

### Copy the AUD tag and team domain

From **App 1**'s overview, copy the **Application Audience (AUD) tag** and your
**team domain** (e.g. `your-team.cloudflareaccess.com`) into `wrangler.jsonc`
`vars`, replacing the placeholders:

```jsonc
"vars": {
  "ACCESS_AUD": "the-app-1-aud-tag",
  "ACCESS_MCP_AUD": "",
  "ACCESS_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "MCP_HOST": "mcp.poof.5n7.me",
  "OWNER_HOST": "poof.5n7.me"
}
```

The Worker verifies the Access JWT itself, behind Access, and each surface
checks the audience of its own application: the owner routes against
`ACCESS_AUD`, `POST /mcp` against `ACCESS_MCP_AUD`.

Leave `ACCESS_MCP_AUD` blank here. The MCP application does not exist yet, and
[MCP-OAUTH-RUNBOOK.md](MCP-OAUTH-RUNBOOK.md) pastes its tag in.

A blank value makes `POST /mcp` on `mcp.poof.5n7.me` answer
`503 Service Unavailable` while the rest of poof runs normally. It closes that
one path and no more. The Access middleware is mounted on the exact path
`/mcp`, so every other path on that hostname answers 404 whether the audience is
set or not.

Once both tags are filled in they must differ. Equal tags mean one application,
and then a grant for the MCP endpoint would also open `/api/*`. The Worker
answers 503 on both surfaces rather than serve that.

`MCP_HOST` and `OWNER_HOST` name the two hostnames the Worker dispatches on. A
request for any other host gets 404. A pair that is missing, blank, malformed,
or that names one host twice gets 503 on every request.

The pair is compared on hostname alone, with the port ignored, so
`POOF.5N7.ME`, `poof.5n7.me.`, and `poof.5n7.me:443` all count as the same host
as `poof.5n7.me` on either scheme. Routing still honours a configured port,
which is what makes the local split in step 9 work.

## 7. Deploy

Deploy the Worker:

```sh
bun run deploy
```

Verify in the Cloudflare dashboard that:

- both **custom domain routes** exist, `poof.5n7.me` and `mcp.poof.5n7.me`
  (`wrangler.jsonc` declares both, so one deploy creates both; the MCP hostname
  answers 503 on `POST /mcp` until step 9), and
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

This installs a `poof` executable into `~/.bun/bin`. Make sure that directory
is on your `PATH`. The command follows the checkout, so pulling updates is
enough. If you prefer not to link, use a shell alias:
`alias poof='bun <repo>/cli/index.ts'`.

Run `poof --help` to confirm the wiring.

## 9. MCP client setup

The Worker serves an MCP endpoint at `POST /mcp` (SPEC §11) so an AI agent can
use poof without the CLI. It lives on `https://mcp.poof.5n7.me/mcp`, a separate
hostname that serves that one path and answers 404 for everything else. A
separate Access application protects it, and clients authenticate with Access
**Managed OAuth**. There is no service token for the MCP endpoint and no local
MCP process.

[MCP-OAUTH-RUNBOOK.md](MCP-OAUTH-RUNBOOK.md) is the whole setup: the Access
application, the identity provider, the Managed OAuth settings, the
`ACCESS_MCP_AUD` value, and the client registration. Work through it first.
None of it is optional. Keep `ACCESS_MCP_AUD` blank through step 5 of the
runbook. Step 6 enables `/mcp` after the Access configuration has been checked.

Register it with a client that speaks OAuth. Claude Code prompts for the
Cloudflare login on first use:

```sh
claude mcp add --transport http poof https://mcp.poof.5n7.me/mcp
```

Codex separates registration from login:

```sh
codex mcp add poof --url https://mcp.poof.5n7.me/mcp
codex mcp login poof
```

`claude mcp list` should then show `poof` as connected, and the nine tools
appear as `mcp__poof__push`, `mcp__poof__ls`, and so on.

To check the endpoint without a client, send the MCP handshake by hand with an
access token from a completed grant. The `Accept` header is required by the
Streamable HTTP transport, and the reply usually arrives as a one-line SSE
`data:` frame rather than bare JSON:

```sh
curl -sS https://mcp.poof.5n7.me/mcp \
  -H "Authorization: Bearer $POOF_MCP_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A healthy deployment answers with a JSON-RPC result naming the server and its
tool capability. The failures read like this:

- `401 Unauthorized` with a `WWW-Authenticate: Bearer` header: no usable token.
  Access answered at the edge, which is what an unauthenticated request should
  get. Run the same curl without the `Authorization` header to confirm the
  application is in front of the hostname.
- `403 Forbidden`: the Worker's own JWT check refused the request. It arrived
  with no `Cf-Access-Jwt-Assertion` header, with one whose audience is not
  `ACCESS_MCP_AUD`, or with a service-token assertion, which `/mcp` refuses
  whatever audience it carries (SPEC §6.6). Compare the tag on the MCP
  application against `wrangler.jsonc`, and check that no Service Auth policy
  was added to it.
- `503 Service Unavailable`: `ACCESS_MCP_AUD` is missing, blank, or equal to
  `ACCESS_AUD`. Fill in the MCP application's own tag and deploy.
- `404 Not Found`: wrong hostname or wrong path. `poof.5n7.me/mcp` is 404 now,
  and so are `mcp.poof.5n7.me/mcp/` and anything under it. The path is exact,
  with no trailing slash.
- An HTML login page instead of JSON: the request reached Access as a browser
  navigation with no session.

The endpoint accepts **POST only**, and a wrong method returns
`405 Method Not Allowed` with an `Allow: POST` header (SPEC §11.1).

That 405 comes from the Worker, so it is only visible once the request has
crossed the edge with a valid OAuth access token or an Access session. A
non-browser request without one gets the Managed OAuth `401` first and never
reaches the method check, so a 401 here is not evidence that the method
handling is broken. Opening the URL in a browser shows the 405 after the
Cloudflare login, because the session cookie then carries the request through.

For local development, `bun run dev` with `DEV_DISABLE_ACCESS=1` in `.dev.vars`
(step 4) skips the JWT check, so the local endpoint needs no credentials at all:

```sh
claude mcp add --transport http poof-local http://127.0.0.1:8787/mcp
```

`wrangler dev` binds one port and the Worker dispatches on the request host, so
`.dev.vars` maps the two surfaces onto two spellings of that one server:
`OWNER_HOST=localhost:8787` serves the library and `/api/*`, and
`MCP_HOST=127.0.0.1:8787` serves `POST /mcp`. Open the library at
`http://localhost:8787` and point MCP clients at `http://127.0.0.1:8787/mcp`.
Swapping the two spellings returns 404, the same way the deployed hostnames do.

> Only ever do this against `wrangler dev`. `DEV_DISABLE_ACCESS` disables the
> Worker's own JWT verification, so a headerless MCP client is exactly what an
> unauthenticated attacker would be if that variable were ever set in
> production.

## 10. Smoke test

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
