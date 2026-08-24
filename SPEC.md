# poof — Ephemeral Document Viewer & Sharing Tool

_Spec v0.4 — adds an MCP server (`POST /mcp`) as a second client alongside the CLI, on top of v0.3's document versioning (in-place update, retained history, rollback) and v0.2's security review decisions (CSP sandbox, unified delivery path)._

> **poof**: throw a document in, view it rendered, share it with a TTL, and it goes _poof_. Served at `poof.5n7.me` (Cloudflare, subdomain of `5n7.me`).

---

## 1. Purpose

View AI-generated design docs and memos (Markdown / HTML) **properly rendered in a browser**. Most are throwaway, but some need to be **temporarily shared with specific people via a link**. Personal tool; top priority is being **lightweight and effectively free**.

## 2. Scope

### In scope

- Upload Markdown / HTML documents and view them in the browser
- Personal library (list view, authenticated, owner-only)
- Per-document disposable share links (unlisted URL + TTL), with manual revocation
- **In-place document update**: replace the contents while keeping the same `/d/{id}` and the same already-issued share links
- **Version history**: past versions are retained, viewable, and restorable — owner only
- JavaScript execution inside documents (interactive charts, tabs, widgets)
- **Mermaid rendering** in Markdown code fences (`` ```mermaid ``)
- **CLI** for headless upload/share (`poof push design.md --share`)
- **MCP server** hosted by the Worker, exposing the same operations as tools to AI agents

### Out of scope (for now)

- Multi-user upload (owner is the only uploader)
- Viewer authentication for shares (unlisted + TTL is the accepted trade-off)
- Per-share version pinning and version diffs (future work, §13)
- Physically separate serving origin (future work, §13)

## 3. Core model: two surfaces

| Surface                  | Nature                               | Auth                | TTL      |
| ------------------------ | ------------------------------------ | ------------------- | -------- |
| **A. Library (private)** | Your documents. Persistent entities. | Yes (owner only)    | Optional |
| **B. Disposable shares** | Links to a specific document.        | None (unlisted URL) | Required |

**Key design decision**: a share is **its own entity (`share`)**, not an attribute of a document. Share links expire or get revoked independently; multiple links per document (per recipient / per deadline) are possible; killing a share never touches the document.

**Documents are mutable, versions are not.** A document is a **stable identity** (id, title, TTL) whose contents are an **ordered sequence of immutable versions**, plus a pointer to the one that is live. `/d/{id}` and every `/v/{token}` resolve that pointer **at request time**, so an update is visible through every link already handed out — nothing is re-issued and nobody has to be re-sent a URL. Recipients always follow the current version and are never shown a version number or the existence of a history; viewing and restoring past versions is owner-only (§9).

## 4. Architecture

**Single Cloudflare stack. Everything fits the free tier.**

| Role                                   | Cloudflare service    | Free tier (as of 2026)     |
| -------------------------------------- | --------------------- | -------------------------- |
| Runtime                                | **Workers**           | 100K req/day, 10ms CPU/req |
| Blob storage                           | **R2**                | 10GB, zero egress fees     |
| Metadata (documents, versions, shares) | **D1** (SQLite)       | 5GB, 5M row reads/day      |
| Owner auth                             | **Cloudflare Access** | Free up to 50 users        |
| Automatic titling                      | **Workers AI**        | 10K neurons/day            |

### Tech stack

- **TypeScript** everywhere (Worker, admin UI, CLI) in a single repo
- **Hono** on Workers; admin UI is server-rendered Hono JSX + minimal vanilla JS (no frontend framework)
- **wrangler** for deploys and D1 migrations
- **Vitest + `@cloudflare/vitest-pool-workers`** for tests

### Repository layout

```
poof/
  src/            # Worker (Hono app, render pipeline, auth, cron)
  cli/            # poof CLI (TypeScript)
  migrations/     # D1 migrations
  scripts/        # bootstrap.sh — idempotent resource creation (D1, R2)
  docs/           # SETUP.md — one-time setup steps (Access, secrets, domain)
  wrangler.jsonc
```

### Infrastructure management

- `wrangler.jsonc` declares all bindings, routes, and cron triggers (committed, declarative).
- Resource _creation_ (D1 database, R2 bucket) lives in **`scripts/bootstrap.sh`** — an idempotent script (skip-if-exists) so "what should exist" stays in the repo without introducing Terraform state management. Revisit IaC (Terraform/OpenTofu) only if environments multiply.
- Cloudflare Access (apps, policies, service token) is configured once in the Zero Trust dashboard, documented step-by-step in **`docs/SETUP.md`**.
- `workers_dev` and `preview_urls` are disabled — the default `*.workers.dev` route would bypass Access entirely. The Worker additionally validates the Access JWT (`Cf-Access-Jwt-Assertion`) as defense in depth.

## 5. Data model (D1, single store)

### `document` — library entity, persistent identity

```sql
CREATE TABLE document (
  id              TEXT PRIMARY KEY,  -- 128-bit random, base64url
  title           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,  -- last version added or rolled back to
  current_version INTEGER NOT NULL,  -- pointer into document_version
  expires_at      INTEGER            -- optional owner TTL; NULL = keep forever
);
```

`kind` and `r2_key` used to live here; migration `0002` moved them into `document_version`, which is now the **single source of truth for blobs**. There is deliberately no `current_r2_key` mirror on `document`: the orphan sweep's "set of referenced blobs" would then be a UNION of two tables, and any drift between them deletes live blobs. The hot path costs one JOIN on a composite primary key — zero extra round-trips.

### `document_version` — the contents, immutable, one row per upload

```sql
CREATE TABLE document_version (
  document_id TEXT    NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,      -- 1-based, allocated MAX(version)+1
  kind        TEXT    NOT NULL,      -- 'html' | 'md'
  r2_key      TEXT    NOT NULL,      -- rendered HTML blob in R2
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, version)
);

-- The weekly orphan sweep probes `r2_key IN (...)` once per R2 listing page;
-- without this index each page is a full table scan.
CREATE INDEX idx_document_version_r2_key ON document_version(r2_key);
```

Three rules that the schema cannot express and code therefore has to hold:

1. **`current_version` is a pointer, not a maximum.** After a rollback it trails `MAX(version)`. A new version is therefore always numbered `MAX(version) + 1`, never `current_version + 1` — otherwise an update after a rollback would collide with (and overwrite) recorded history. The composite PK turns that collision into an error rather than a silent overwrite, so the writer retries with a fresh number. Every document has at least one version and `current_version` always names a real row, guarded by an `EXISTS` clause on the pointer update.
2. **R2 keys are read, never derived.** New versions (including v1 of a new document) are written to `doc/{id}/v{n}.html`, but version-1 rows created before versioning keep their flat `doc/{id}.html` key — the migration backfilled them without copying, moving, or rewriting a single object. Both shapes are just flat strings to R2, the cron's `doc/` prefix covers both, and collision is impossible (the flat shape has `.html` directly after the id, the nested one a `/`).
3. **Rollback moves the pointer and copies nothing.** A restored version keeps its original row and blob, so the history stays a faithful record of what was actually uploaded and no two rows ever share an `r2_key`.

`expires_at` keeps its meaning: it is per **document**, and when it passes the document and all of its versions die together. Versions have no individual TTL.

### `share` — disposable link, separate entity

```sql
CREATE TABLE share (
  token       TEXT PRIMARY KEY,      -- 128-bit random, base64url
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,      -- required
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_share_document ON share(document_id);
CREATE INDEX idx_share_expires  ON share(expires_at);
```

Rationale for a single D1 store (decided from first principles):

1. Expiry is enforced at read time regardless of store, so KV's native TTL adds nothing but background cleanup — which a weekly cron `DELETE` covers in a few lines.
2. `share → document` is a real relation; FK + `ON DELETE CASCADE` come for free (D1 enforces foreign keys).
3. Listing and revocation are query/strong-consistency workloads. SQL handles both trivially; revocation takes effect immediately (KV deletes can lag up to 60s).
4. One store = fewer moving parts, which matches the "keep it light" goal.

> Future optimization (not now): if the public view path ever becomes hot and global, add KV as a read-through cache in front of D1. Additive change; don't build it until traffic demands it.

### Token generation

"Hard to guess" is specified as: **`crypto.getRandomValues`, 16 bytes (128 bits), base64url-encoded** (~22 chars). Applies to `document.id` and `share.token`.

## 6. Delivery path & security model

This is the core of the design. Untrusted HTML (uploaded docs run arbitrary JS by design) must never execute in the real `poof.5n7.me` origin.

### 6.1 The security boundary: CSP `sandbox` response header

All raw document HTML is served from a single endpoint, and every response carries:

```
Content-Security-Policy: sandbox allow-scripts allow-popups
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
```

The **CSP `sandbox` directive is the primary defense**: it forces an opaque origin even when the URL is opened directly in the address bar (not just inside an iframe). Scripts run, but they cannot touch cookies, storage, or the real origin — so a malicious document can never reach the Access-protected admin surface.

Viewer pages embed the raw endpoint in an iframe with the equivalent attribute as **defense in depth**:

```html
<iframe sandbox="allow-scripts allow-popups" src="/raw/{token}"></iframe>
```

> ⚠️ Never add `allow-same-origin` (header or attribute). Combining it with `allow-scripts` neutralizes the sandbox entirely.

Known UX constraints of the opaque origin (accepted): `localStorage`/`document.cookie` access throws inside documents; `target="_blank"` works only because of `allow-popups`.

### 6.2 Unified raw endpoint, two token kinds

A sandboxed iframe has an opaque origin, so its subresource/navigation requests are treated as cross-site and **SameSite cookies (including Access's `CF_Authorization`) are not sent**. Therefore the raw endpoint must not sit behind Access. Instead, `GET /raw/{token}` is public and validates one of two token kinds:

| Prefix | Kind             | Backing                                                                                                 | Used by                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `s_`   | Share token      | `share` row in D1 (checks `expires_at`, `revoked`); resolves to the **current** version                 | Public shared view `/v/{token}`  |
| `o_`   | Owner view token | Stateless HMAC-signed payload `{document_id, exp, version?}`, TTL ~10 min, secret via `wrangler secret` | Private library viewer `/d/{id}` |

The Access-protected library page mints an `o_` token when rendering the viewer, so owner viewing and public sharing go through **the exact same hot path** — one endpoint, one set of headers, no cookie problems, no second code path.

**Version pinning lives inside the signed payload, never in a query parameter.** On `/raw/*` the token _is_ the authorization, so accepting `?v=N` there would let anyone holding a share link enumerate the whole edit history. Instead only `/d/{id}?v=N` — behind Access — can mint a pinned token, and the pin dies with the token's ~10 minute TTL. Two consequences:

- `s_` tokens have no version field at all: there is structurally no way to ask a share for anything but the current version.
- An `o_` token pointing at the current version **omits `v` entirely**, so ordinary tokens stay byte-identical to the pre-versioning format and tokens minted before the change keep verifying.

The payload is authenticated, not trusted: after the HMAC check, a `v` that is not a positive integer (`0`, `-1`, `1.5`, `"2"`) is rejected even under a valid signature.

### 6.3 Error responses

Nonexistent, expired, and revoked tokens all return the **same status (404)** with an identical body, so a probe cannot distinguish "never existed" from "existed and expired".

### 6.4 No sanitization — by design

HTML uploads run arbitrary JS on purpose, so sanitizing Markdown-derived HTML would add inconsistency, dependencies, and zero real security. **All documents are treated as untrusted HTML blobs; the CSP sandbox is the single security boundary.** No sanitizer dependency.

## 7. TTL enforcement (two layers)

### Defaults

- **Library**: no default TTL (keep forever). `expires_at` optional.
- **Shares**: default TTL **1 day**; selectable at issue time (1h / 1d / 1w).

### Enforcement

1. **Read-time validation (authoritative, immediate)**: `/raw/{token}` and `/v/{token}` check `expires_at` / `revoked` / existence on every request → 404. This is the real enforcement.
2. **Background cleanup (housekeeping, non-security)**: weekly Cron Trigger deletes expired `share` rows, expired `document` rows (where `expires_at` is set) plus **every version's** R2 blob and their cascaded shares, and sweeps orphaned R2 objects. Expired rows left behind are harmless — read-time checks reject them.

Two details the versioned schema forces:

- The sweep's reference set is **`document_version.r2_key`**, not `document` — otherwise every non-current version's blob would look orphaned and get deleted. Likewise, a document's version keys must be read **before** its row is deleted, since the FK cascade takes `document_version` with it.
- Both the delete and the sweep now handle far more keys than before, so the fan-out chunking lives in **`src/lib/batch.ts`**: D1 binds at most 100 parameters per statement while an R2 listing page holds up to 1000 keys, and `delete()` accepts at most 1000 keys per call.

## 8. Rendering pipeline (write-time, single path)

Free-tier Workers allow 10ms CPU per request, so rendering happens **once per version at write time**, never at view time:

```
[Upload / update]
  md   → markdown-it → wrap in viewer template → store final HTML in R2
  html → store as-is in R2
        (everything converges to "one HTML blob per version")

[View (hot path)]
  resolve the version → fetch blob from R2 → serve with sandbox headers. Near-zero CPU.
```

- **Converter**: `markdown-it` (CommonMark + tables + strikethrough). No sanitizer (§6.4). Typical AI docs (tens of KB) render in well under 10ms.
  - _Documented fallback if a doc ever blows the CPU budget_: move MD→HTML into the client (upload page renders in the browser; CLI renders locally) and POST final HTML. The API accepting `kind` and raw content makes this switch non-breaking.
- **Viewer template** (MD only; HTML uploads are stored verbatim): minimal GitHub-flavored CSS, plus a tiny inline loader that lazily injects client-side libraries **only when needed**, keeping Worker CPU flat:
  - **Mermaid**: `` ```mermaid `` fences render as `<pre class="mermaid">` (content escaped); loader injects mermaid.js (CDN, SRI-pinned) if `.mermaid` elements exist.
  - **Syntax highlighting**: highlight.js via the same lazy pattern if code blocks exist.
  - Both run inside the sandbox, so they are safe by construction.
- **Per version**: an update renders and stores a new blob and never touches an existing one; rollback renders nothing at all (§5). `kind` is per version, so re-uploading a Markdown document as HTML is allowed and costs nothing.

**Automatic titling** (`src/lib/title.ts`) runs in this same write path, immediately **before** rendering — for Markdown the title is baked into the stored blob's `<title>`, so it cannot be deferred to a `waitUntil` after the response. That is the whole reason the Workers AI call is synchronous. It fires only when the request carries no usable `title` — absent, or present but blank, which both create adapters fold into the same thing (a real one is used verbatim), and the chain is **Workers AI → the document's own first `#` heading → a terminal fallback**, each link degrading silently: no binding, a timeout, a retired model ID or unusable output all fall through rather than failing the upload. **Both** create paths run it — `POST /api/documents` and the MCP `push` tool (§11.4) — and only the terminal differs, because only the terminal is a property of the caller: the API ends on the uploaded file name, MCP has no file and ends on `untitled`. The chain itself, and the acceptance rules below, live in one module that both adapters call; an MCP push landing on `untitled` where a name could have been inferred is exactly the bottleneck §1 exists to remove. `resolveNewTitle` also guards its own terminal, so no rung can yield a blank title (a multipart part sent with `filename=""` arrives as an empty file name). The model (`@cf/ibm-granite/granite-4.0-h-micro`) is asked for a single line. **Which language to answer in is decided in code, not by the model**: an excerpt whose kana share crosses a threshold is Japanese, and the prompt then says so outright and shows one Japanese example, because a 3B model with English-heavy instruction tuning does not reliably act on an implicit "match the document" (in production it returned English titles for two of three Japanese documents). Everything else keeps that implicit instruction, which holds for English. Only the model's first non-empty line is taken, that line is stripped of the usual model debris (`Title:` labels, Markdown markers and links, wrapping quotes, trailing `.`/`。`/`!`) and the result is **rejected rather than truncated** if it is longer than 80 code points, reads as a preamble, opens a `<think>` block that never closes (at 32 output tokens a reasoning model is likelier to be cut off mid-scratchpad than to close the tag, and "Okay, the user wants a title for…" is not one), or carries no letter or number at all — a chopped-off paragraph, a leaked thought and a row of `---` are all worse library labels than the file name. A trailing `?` and the ideographic space U+3000 are deliberately preserved; invisible format characters are stripped rather than trusted, since one of them (`U+202E`) silently reverses the display direction of the rest of a library row, with ZWNJ and ZWJ excepted because they carry meaning inside Persian, Devanagari and emoji sequences. `html` uploads skip the AI entirely: tag-stripping is a sanitizer-shaped problem and poof carries no sanitizer by design (§6.4). **New data flow**: the first 2000 characters of an untitled Markdown document are sent to Workers AI (inside Cloudflare, not to a third party). The `<document>` delimiter in the prompt is injection _hygiene_, not a boundary — a document that names itself is harmless, since the title is HTML-escaped at render time and stored in a `TEXT` column.

## 9. HTTP surface

| Route                                                | Auth                         | Purpose                                                             |
| ---------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `GET /`                                              | Access                       | Library list (newest first), upload UI                              |
| `POST /api/documents`                                | Access (incl. service token) | Upload; file + kind + optional title; 10MB cap; creates version 1   |
| `GET /api/documents`                                 | Access                       | List documents (incl. `current_version`, `updated_at`; no `r2_key`) |
| `DELETE /api/documents/:id`                          | Access                       | Delete document (+every version's blob, cascades shares)            |
| `POST /api/documents/:id/versions`                   | Access (incl. service token) | Add a version and make it live; body = file + kind + optional title |
| `GET /api/documents/:id/versions`                    | Access                       | List versions (newest first) + `current_version`; no `r2_key`       |
| `GET /api/documents/:id/content`                     | Access                       | Raw stored HTML of the current version; `?v=N` pins a past one      |
| `POST /api/documents/:id/versions/:version/rollback` | Access                       | Point the document at an existing version                           |
| `POST /api/documents/:id/shares`                     | Access                       | Issue share (TTL param) → returns `/v/{token}` URL                  |
| `GET /api/documents/:id/shares`                      | Access                       | List active shares for a document                                   |
| `DELETE /api/shares/:token`                          | Access                       | Revoke (`revoked=1`, immediate)                                     |
| `POST /mcp`                                          | Access (incl. service token) | MCP server (Streamable HTTP): nine tools over the same core (§11)   |
| `GET /d/:id`                                         | Access                       | Private viewer page (mints `o_` token, embeds iframe)               |
| `GET /d/:id?v=N`                                     | Access                       | Read-only view of version N (banner, no Share, no uploader)         |
| `GET /v/:token`                                      | none                         | Public shared viewer page; **always the current version**           |
| `GET /raw/:token`                                    | none (token is the auth)     | Raw HTML blob with sandbox headers (§6)                             |
| Cron (weekly)                                        | —                            | Cleanup (§7)                                                        |

Version-route conventions:

- A new version is gated on the document being **live** (not merely existing), so an owner-expired document 404s on both the POST and the GET, exactly like `POST …/shares`.
- The write is a three-phase sequence — stage the row, put the blob, then one guarded `UPDATE` as the atomic cutover — so a reader always sees either the old version or the new one, never a pointer to a blob that isn't there yet.
- Rollback is a path (`…/versions/:version/rollback`), not a `PATCH` assigning `current_version`: it verifies that the target version exists, which folds "no such version" into the existing uniform 404, and it matches the verb the CLI and UI use. A malformed `:version` is a `400 {error:"invalid version"}`; a well-formed but unknown one is a uniform 404. Rolling back to the version that is already live is an idempotent no-op that does not bump `updated_at`.
- `GET …/content` takes its version pin from `?v=N`, which `/raw` refuses (§6.2), because the two routes authorize differently: on `/raw` the token _is_ the authorization, so a URL version would let a share holder enumerate history, while `…/content` sits behind Access, where the session authorizes and the URL grants nothing. Malformed `v` is a `400 {error:"invalid version"}`, unknown is a uniform 404. The body is served as `text/plain; charset=utf-8` with `nosniff` and a bare `sandbox` CSP: it is untrusted document HTML on the real origin, which §6.1 forbids executing there, so a browser navigating in with the Access cookie must render text, never markup.
- `/d/{id}?v=N` is a page, not an API, so a malformed `v` is a uniform 404 rather than a 400. `?v=` naming the live version falls through to the normal viewer instead of rendering the current content as a read-only dead end.
- **Auto-naming is create-only.** On `POST /api/documents` an absent `title` hands the naming to §8's chain (a present one is used verbatim); on `POST …/versions` an absent `title` means "keep the current one", never "name it again" — a document that silently retitled itself on every content fix, down to the `<title>` on the recipient's page, would be a surprise. The asymmetry is deliberate, and it is the same one the MCP `push`/`update` pair keeps (§11.4).

**Cloudflare Access configuration**: one Access application protecting `poof.5n7.me` with an allow policy (owner's Google account) **plus a service-token policy** (for the CLI and MCP clients), and a bypass application for `/v/*` and `/raw/*`. `/mcp` falls under the same application as `/` and `/api/*` and needs no rule of its own; the bypass list stays exactly `/v/*` and `/raw/*`.

Viewer pages (`/d/*`, `/v/*`) also send `Referrer-Policy: no-referrer` so links inside documents can't leak token URLs via `Referer`.

## 10. CLI

The primary upload path in practice (AI output → terminal → link). TypeScript, lives in `cli/`, runs via `npx`/`bunx` or a compiled binary.

```
poof push <file> [--title <t>] [--ttl <dur>] [--share [--share-ttl 1d]]
                                # upload; prints /d/{id} URL; --share also prints /v/{token}
poof cat <doc-id> [--version <n>]
                                # print the stored (rendered) HTML to stdout
poof ls                         # list documents
poof update <doc-id> <file> [--title <t>]
                                # new version of an existing document; prints /d/{id} then v{n}
poof versions <doc-id>          # VER / KIND / CREATED / CURRENT, newest first, '*' marks current
poof rollback <doc-id> <version>
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof revoke <share-token>
poof rm <doc-id>
```

- Auth: **Cloudflare Access service token** via env vars (`POOF_URL`, `POOF_ACCESS_CLIENT_ID`, `POOF_ACCESS_CLIENT_SECRET`), sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
- The CLI only talks to the JSON API; rendering stays server-side (see §8 fallback if that changes).
- `kind` is inferred from the file extension (`.md` / `.html`) on both `push` and `update`, so a document may switch between Markdown and HTML from one version to the next.
- **Title**: `push` defaults to the first `# heading` (Markdown) or the filename. `update` **keeps the existing title** unless `--title` is passed — silently renaming a document on every content fix (down to the `<title>` on the recipient's page) would be a surprise, so the inference is deliberately not reused here. Because `push` always resolves a title locally and sends it, the server's auto-naming chain (§8) never runs for a CLI upload — it is there for the two clients that arrive with no name at all: a document pasted into the web UI, and an MCP `push` with no `title` (§11.4).
- `ls` columns are `ID TITLE KIND VER UPDATED EXPIRES`. `VER` is `current_version`; `UPDATED` replaces the old `CREATED` to hold the table at six columns — an un-updated document has `updated_at === created_at`, and the true creation time is version 1's `created_at` in `poof versions`.
- `rollback` validates the version number locally before spending a round-trip, and prints `rolled back {id} to v{n}`.
- `cat` prints **the rendered HTML, not the Markdown source**: only the rendered blob is retained (§8), so a Markdown document comes back wrapped in the viewer template. It is for checking what a recipient actually sees — piping it back through `update` would overwrite the document with its own rendering and destroy the source. `--version` is validated locally like `rollback`'s, and the body is written to stdout verbatim (no added trailing newline), so `poof cat {id} > out.html` is byte-identical to what `/raw` serves.
- The API answers `cat` with `text/plain`, not `text/html`, even though the body is HTML: the response comes from the real `poof.5n7.me` origin, so it must be inert if a browser ever navigates to it (§6.1, §9). The CLI does not care about the type, and the choice costs it nothing.

## 11. MCP server

The second client surface, alongside the CLI: an **MCP server hosted by the Worker itself** at `POST /mcp`, so an AI agent can push and manage documents without shelling out to `poof`. Same operations, same backend, nothing extra to install or keep running — the deployment that already answers `/api/*` answers `/mcp` too.

### 11.1 Transport, and why it is stateless

**Streamable HTTP**, via `@hono/mcp`'s `StreamableHTTPTransport` over `@modelcontextprotocol/sdk`, mounted as one ordinary Hono route. stdio is not an option (there is no local process to speak it), and the deprecated HTTP+SSE transport would need a second endpoint plus a connection held open — exactly the thing a request-scoped Workers isolate cannot promise. New dependencies: `@hono/mcp`, `@modelcontextprotocol/sdk`, and `zod` for tool input schemas; the bundle grows ~196 KB gzipped. No Durable Objects, no `nodejs_compat`.

**A fresh `McpServer` and transport are constructed per request, and no session id is issued.** Isolates are created, reused, and discarded outside the Worker's control: a server instance parked in module scope would be shared by whatever unrelated requests land in that isolate and be absent from the next one, so "the session" would exist or not exist depending on routing luck. Statelessness makes that a non-question. Nothing is lost by it — every tool call is a self-contained API operation with no cross-call state to keep — and the per-request cost is a constructor and a schema registration, not a round-trip.

**The route takes `POST` only**, and answers every other method with `405` and an `Allow: POST` header. Streamable HTTP also defines a `GET` that opens an SSE stream for server-initiated messages, but a stateless server has nothing to initiate: the stream could only ever be an idle connection held open by keep-alive pings — the same held-open connection that ruled out HTTP+SSE above, arrived at from the other direction. The MCP specification anticipates exactly this and permits a server that offers no SSE stream at the endpoint to answer `GET` with `405` — so the status is the documented way to say "this endpoint is POST-only", not a gap. That permission is not merely on paper: the reference client swallows the status and returns rather than raising, calling it in its own source "an expected case that should not trigger an error" (`@modelcontextprotocol/sdk`, `client/streamableHttp.js`), and handles a `405` on `DELETE` the same way, as "the server does not support explicit session termination". POST-only is a negotiation path the ecosystem implements, not an edge case it merely tolerates.

The 405 has to be registered, not left to fall out: a bare `post("/")` would hand a `GET` to Hono's fall-through **404**, which says "no such endpoint" — the opposite of the truth, and unrecognisable to a client that is looking for the 405 to mean "this server has no stream for you". An explicit `all("/")` after the POST route supplies it, with the `Allow: POST` header the status requires. §9's route table names the method for the same reason.

### 11.2 Auth

`/mcp` sits behind Cloudflare Access exactly like `/api/*`: the same `accessAuth` middleware, registered in the same Access-protected block of `src/index.ts`, plus the same `csrfProtection` guard on state-changing requests (moved out of `src/routes/api.ts` into `src/lib/http.ts` so the two surfaces share one copy rather than two that can drift). Clients authenticate with the **same Access service token the CLI uses**, sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`; Access exchanges those for the `Cf-Access-Jwt-Assertion` the Worker verifies (§4). No new credential, no second Access application, no token kind of its own — the MCP server carries exactly the owner's authority and nothing more, and revoking the service token closes both clients at once.

`/v/*` and `/raw/*` are untouched and stay public. The tool surface is entirely inside the Access boundary, so it is unreachable without the service token — a share link has never granted anything but "read the current version of this one document", and adding MCP does not change that.

### 11.3 Tools

Nine tools, named exactly after the CLI subcommands (§10) so one mental model covers both clients and the skill's vocabulary transfers unchanged. Clients namespace them — Claude Code exposes `push` as `mcp__poof__push`.

| Tool       | Input                                                                                     | Result                                                                |
| ---------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `cat`      | document id, optional version                                                             | The stored (rendered) HTML of that version, capped at 128 KiB (§11.4) |
| `ls`       | —                                                                                         | Documents, newest first, as `poof ls` shows them                      |
| `push`     | content, kind, optional title, document TTL, share flag + share TTL                       | New document: `/d/{id}` URL, plus a `/v/{token}` URL when shared      |
| `revoke`   | share token                                                                               | The share is dead on the next request                                 |
| `rm`       | document id                                                                               | Document, every version's blob, and all its shares deleted            |
| `rollback` | document id, version                                                                      | That version becomes current; no blob written                         |
| `share`    | document id, optional share TTL (`1h` / `1d` / `1w`)                                      | A `/v/{token}` URL                                                    |
| `update`   | document id, content, optional kind (default: the document's current one), optional title | New version, live immediately; same `/d/{id}` and same share links    |
| `versions` | document id                                                                               | Version history, newest first, with the current one marked            |

Semantics are the CLI's, not a second dialect: the same `md` / `html` kinds, the same 10 MiB cap, the same 1h/1d/1w share TTLs, the same default of 1 day, and the same two-surface URL model (§3).

Foreseeable failures come back **as tool results, not exceptions** — an unknown id, an expired document, oversized content — each a one-sentence `isError` text block the caller can act on.

**The tools distinguish "no such document" from "no such version", where the JSON API folds both into one uniform 404 (§9).** That is deliberate, and it does not weaken §6.3. Uniformity there is a property of the **public** surface: on `/raw` and `/v` the token _is_ the authorization, so a probe must not be able to tell a token that never existed from one that expired or was revoked. Every tool call has already cleared Access (§11.2), so the caller is the owner — who can list the entire library with `ls` regardless, and therefore learns nothing from the distinction that they could not learn by asking. What it buys is the caller's next move: "no live document with that id" sends them to `ls`, "no version N of document X" sends them to `versions`, and a single message for both would have a model guess between them. Inside the document case the states stay folded — "it may never have existed, or its TTL has passed" is one sentence, because no caller acts differently on the two.

### 11.4 Where the tools differ from the CLI

**Content, not a path.** The MCP server runs on the Worker and has no access to the caller's filesystem, so `push` and `update` take the document **content as a string** rather than a file path — which an agent that has just written the document has in hand anyway. Two CLI behaviours hang off the file name and therefore have to be replaced rather than mirrored: `kind` becomes an `md` | `html` input instead of an extension inference, and `push` hands an absent `title` to the server-side naming chain of §8 — Workers AI, then the document's own first `#` heading — ending on `untitled` where the API's create route ends on the file name. That is the whole of the difference: the rule is the same one, called from the same module, with the one argument the caller owns. Leaving MCP on `untitled` would have been the wrong asymmetry to keep, since an agent writing a document and pushing it is precisely the case §1 is built for and the case with no file name to fall back on. `update` is untouched by any of this: an omitted title still keeps the document's current one (§9).

**What an omitted `kind` means differs between the two tools, and from a single rule**: when the caller does not say, fall back to the best evidence available of what the content is. The CLI never has to fall back — the file it was handed carries an extension. `push` has no evidence at all: a brand-new document has no history, and Markdown is the overwhelming case, so an omitted kind means `md`. `update` does have evidence, the document's current kind, and it is better evidence than a blanket `md` — so an omitted kind **inherits**, and only an explicit `kind` moves a document between Markdown and HTML from one version to the next. That remains allowed and costs nothing (§5 records `kind` per version); it just has to be asked for. One principle, two answers, not two conventions.

The rejected alternative is the symmetric one, defaulting `update` to `md` like `push`. It makes "update this document" quietly change what the document _is_: revising an HTML document without repeating `kind: "html"` would re-render its markup as Markdown, producing a valid new version rather than an error — and by §3 that version is live to everyone holding a share link before anyone notices. A silently wrong rendering is a worse failure than a missing argument, and the caller who omits the argument is precisely the one who did not think about kind at all. A misspelled kind is safe by comparison: the enum rejects `markdown` or `txt` before the handler runs, so nothing is ever coerced.

**Absolute URLs.** Tool results carry full `https://poof.5n7.me/d/{id}` and `/v/{token}` URLs, built from the request origin, where the JSON API returns the relative `/d/{id}` and `/v/{token}` (§9). The CLI joins those against its own `POOF_URL`; an MCP client has no such variable, and a tool result is routinely pasted straight into a chat message or a commit comment, where a bare path is useless.

**A bounded `cat`.** The tool caps its output at **128 KiB**. A document under the cap comes back unchanged; past it the result is truncated and carries a notice giving the document's true total size and its absolute `/d/{id}` URL, so the caller knows it is holding a fragment and where the whole thing is — repeating, as every tool result that emits a `/d/{id}` does, that the URL is owner-only. Neither `poof cat` nor `GET /api/documents/:id/content` (§9) is capped, and both deliberately keep streaming: documents run to 10 MiB, which costs nothing written to a file or a terminal and costs everything written into a model's context window. The limit exists because of the client's medium, not because of the operation, so it lives in the adapter and nowhere near the shared core (§11.5) — the inconsistency between the two surfaces is the point, not an oversight to be tidied away later. Truncation keeps the **head** of the blob: in a `wrapViewerHtml` document that is the reader-visible content, while the tail it drops is the lazy Mermaid and highlight.js loader (§8), which tells a caller checking what a recipient sees nothing it could not already infer. The cap is applied while reading — the stream is pulled to the limit and then cancelled — so an oversized blob is never buffered whole just to be thrown away.

**The cautions ship with the tools.** A tool description is the only documentation the caller reads, so the warnings the Claude Code skill teaches are carried over verbatim rather than assumed. They live in two places on purpose: the server's `instructions` block, handed to the model once ahead of any call, holds the ones that are expensive to get wrong and that no single tool description is guaranteed to be read for — `/d/{id}` is owner-only and must never be handed to a recipient, a `/v/{token}` URL _is_ the secret, a revision is an `update` on the same id rather than a second document, an update or rollback is instantly visible to everyone already holding a live share link, and nothing secret belongs in a shared document. The per-tool descriptions then repeat the caution that belongs to their own operation, most sharply on `cat`: it returns the rendering, never the source, and must never be fed back into `update`.

### 11.5 One core, two adapters

The tools and the JSON API are **not** two implementations of the same rules. The core operations — create a document, add a version, roll the pointer back, issue a share — move into `src/lib/`, `src/routes/api.ts` becomes a thin HTTP adapter over them (multipart in, JSON out), and the MCP tools become a second, equally thin adapter (arguments in, text out). The version-numbering rules of §5 and the three-phase write of §9 are subtle enough that a second copy would diverge silently, and only one of the two surfaces would ever be the one under test.

**Which side of that boundary a limit lives on follows from what the limit is about.** The 10 MiB upload cap (§9) is a property of the document — true of every client, and an invariant the core owes R2 — so it lives in `src/lib/` and throws. Both adapters still check the size first and phrase the refusal in their own idiom (a `413` on `/api`, an `isError` result on `/mcp`), so the core's exception should never be what rejects a real request; it is there so that a third write adapter which forgets the check gets an exception instead of putting a 10 MiB blob in R2. The 128 KiB `cat` cap (§11.4) is the mirror image: a property of the **caller's medium** rather than of the document, so it lives in the MCP adapter and nowhere else. Two constraints that share the word "limit" sit on opposite sides of the boundary, and one question decides which: is this about the data, or about who is asking?

The rejected alternative was letting the tools call the Worker's own `/api/*` over HTTP. It would re-enter Access from inside the Worker — a service token calling itself — and pay a full extra request per tool call, to reuse code that a function call reuses for free.

## 12. Main flows

1. **Upload (web, CLI, or MCP `push`)** → render if MD → insert `document` + version 1 rows → store blob in R2 → return URL.
2. **Library view** → `/` lists `ORDER BY created_at DESC` → `/d/{id}` embeds sandboxed iframe via minted `o_` token.
3. **Issue share** → insert `share` row → return `poof.5n7.me/v/{token}`.
4. **Shared view** → `/v/{token}` validates share (404 on any failure) → joins to the document's **current** version → sandboxed iframe → `/raw/s_{token}` → R2 blob.
5. **Revoke** → `revoked=1` → next request 404s immediately.
6. **Update** → `poof update {id} file.md` (or the `update` tool, or drop/⌘V on `/d/{id}`) → render → stage version `MAX+1` → put blob → move `current_version` → **every existing share link serves the new content on its next load**, same token, nothing re-issued.
7. **Rollback** → `poof versions {id}` to pick a number (or the versions modal on `/d/{id}`) → `poof rollback {id} N` → one guarded `UPDATE` of the pointer, no blob written → live share links follow immediately, and a later update is numbered `MAX+1`, not `N+1`.

## 13. Future work (explicitly not now)

- **Physically separate serving origin** (e.g. `poof-v.5n7.me`) if sharing with third parties becomes serious — full cookie-space isolation on top of the CSP sandbox. Near-zero cost with an extra Workers route.
- **Share-side auth** (passcode or Access allowlist) if unlisted+TTL stops being enough.
- **Per-share version pinning** — a share that keeps serving the version it was issued against instead of following the current one. The schema already supports it (`share` would gain a nullable `version`); the reason not to build it is that "the link I sent shows what I fixed" is the whole point of §3, and a pinned share silently diverging from the document is the confusing case.
- **Retaining the source blob** alongside the rendered one, so a document could be round-tripped (`poof cat --source {id} > report.md`, edit, `poof update`) instead of only inspected. Today §8 stores the rendering and nothing else, which is why `poof cat` can only print HTML — and why the MCP `cat` tool inherits the same constraint, warning in its own description that its output must never be handed back to `update` (§11.4). Costs a second R2 object per version and a schema column; not worth it until editing-from-the-server is actually wanted.
- **Version diffs** in the owner UI (v2 vs v3). Needs a diff renderer and a second read path, and so far reading the two versions side by side has been enough.
- **KV read-through cache** for the public path (§5).

## 14. Cost

$0/month realistic. All components in free tiers; R2 egress is free. Only real cost is the domain (~$10/year, already owned).

Workers AI is the one metered addition: auto-naming costs roughly 3-5 neurons per untitled Markdown create (a ~2000-character prompt capped at 32 output tokens on the smallest text model) against a free allowance of 10,000 neurons/day, and it fires only on the two paths that arrive without a name — a pasted document in the web UI, and an MCP `push` with no `title`. `poof push` resolves its title locally and sends it, so the CLI spends nothing. Still $0.

## 15. Decision summary

| Item              | Decision                                                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share model       | Unlisted URL + TTL; `share` as its own entity; revocation in initial scope                                                                                                                                                                                                  |
| Versioning        | Document = stable identity + ordered immutable versions; `document_version` is the only source of truth for blobs; `current_version` is a pointer, next = `MAX+1`                                                                                                           |
| Share on update   | Shares **follow the current version** — an update reaches everyone holding a live link, no re-issue; per-share pinning is out of scope (§13)                                                                                                                                |
| Rollback          | `POST …/versions/:version/rollback`; pointer move only, no blob copied; already-current is an idempotent no-op                                                                                                                                                              |
| Version viewing   | Owner-only: `/d/{id}?v=N` (read-only, behind Access) via an `o_` token with the version **inside the signed payload**; `/raw` never accepts a `v` query param                                                                                                               |
| Security boundary | **CSP `sandbox allow-scripts allow-popups` response header** on `/raw/*` (primary) + iframe `sandbox` attribute (defense in depth); never `allow-same-origin`                                                                                                               |
| Delivery path     | Single public `/raw/{token}` endpoint; `s_` share tokens (D1) + `o_` owner tokens (HMAC, ~10 min)                                                                                                                                                                           |
| Sanitization      | None; all docs treated as untrusted blobs, sandbox is the boundary                                                                                                                                                                                                          |
| Rendering         | Write-time `markdown-it` in the Worker; Mermaid + highlight.js lazily loaded client-side inside the sandbox                                                                                                                                                                 |
| Titling           | Create-only, and only when `title` is absent: Workers AI → the document's first `#` heading → a per-adapter terminal (file name on `/api`, `untitled` on MCP `push`); synchronous, because the title is baked into the blob, and silently degrading                         |
| Errors            | Uniform 404 for missing/expired/revoked                                                                                                                                                                                                                                     |
| Tokens            | `crypto.getRandomValues`, 128-bit, base64url                                                                                                                                                                                                                                |
| MCP server        | Worker-hosted at `POST /mcp`, Streamable HTTP (`@hono/mcp`), **stateless** — new server per request, no session id, because isolates are not sticky; POST-only, `405` + `Allow: POST` elsewhere (no SSE stream to offer)                                                    |
| MCP auth          | Same Access application and same CLI service token (`CF-Access-Client-*`) as `/api/*`, plus the shared CSRF guard; no new credential and no new bypass                                                                                                                      |
| MCP tools         | Nine, named after the CLI subcommands; `push`/`update` take content, not a file path; an omitted `kind` means `md` on `push` and the document's current kind on `update`; `cat` capped at 128 KiB; results carry absolute URLs; one shared core in `src/lib/`, two adapters |
| Auth              | Cloudflare Access (`/` + API + `/mcp`); service token for CLI and MCP clients; bypass on `/v/*` `/raw/*`                                                                                                                                                                    |
| Infra / stack     | Cloudflare Workers + R2 + D1 + Access; TypeScript + Hono + wrangler + vitest-pool-workers                                                                                                                                                                                   |
| Provisioning      | Idempotent `scripts/bootstrap.sh` + `docs/SETUP.md`; no Terraform until environments multiply; `workers_dev` disabled; Access JWT verified in-Worker                                                                                                                        |
| TTL defaults      | Library: none; shares: 1 day (1h/1d/1w selectable)                                                                                                                                                                                                                          |
| Headers           | `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on viewer/raw paths                                                                                                                                                                                                 |
