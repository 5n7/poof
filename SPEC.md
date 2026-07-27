# poof — Ephemeral Document Viewer & Sharing Tool

_Spec v0.3 — adds document versioning (in-place update, retained history, rollback) on top of v0.2's security review decisions (CSP sandbox, unified delivery path), Mermaid support, and CLI._

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

### Out of scope (for now)

- Multi-user upload (owner is the only uploader)
- Viewer authentication for shares (unlisted + TTL is the accepted trade-off)
- Per-share version pinning and version diffs (future work, §12)
- Physically separate serving origin (future work, §12)

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

## 9. HTTP surface

| Route                                                | Auth                         | Purpose                                                             |
| ---------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| `GET /`                                              | Access                       | Library list (newest first), upload UI                              |
| `POST /api/documents`                                | Access (incl. service token) | Upload; body = file + title + kind; 10MB cap; creates version 1     |
| `GET /api/documents`                                 | Access                       | List documents (incl. `current_version`, `updated_at`; no `r2_key`) |
| `DELETE /api/documents/:id`                          | Access                       | Delete document (+every version's blob, cascades shares)            |
| `POST /api/documents/:id/versions`                   | Access (incl. service token) | Add a version and make it live; body = file + kind + optional title |
| `GET /api/documents/:id/versions`                    | Access                       | List versions (newest first) + `current_version`; no `r2_key`       |
| `GET /api/documents/:id/content`                     | Access                       | Raw stored HTML of the current version; `?v=N` pins a past one      |
| `POST /api/documents/:id/versions/:version/rollback` | Access                       | Point the document at an existing version                           |
| `POST /api/documents/:id/shares`                     | Access                       | Issue share (TTL param) → returns `/v/{token}` URL                  |
| `GET /api/documents/:id/shares`                      | Access                       | List active shares for a document                                   |
| `DELETE /api/shares/:token`                          | Access                       | Revoke (`revoked=1`, immediate)                                     |
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

**Cloudflare Access configuration**: one Access application protecting `poof.5n7.me` with an allow policy (owner's Google account) **plus a service-token policy** (for the CLI), and a bypass application for `/v/*` and `/raw/*`.

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
- **Title**: `push` defaults to the first `# heading` (Markdown) or the filename. `update` **keeps the existing title** unless `--title` is passed — silently renaming a document on every content fix (down to the `<title>` on the recipient's page) would be a surprise, so the inference is deliberately not reused here.
- `ls` columns are `ID TITLE KIND VER UPDATED EXPIRES`. `VER` is `current_version`; `UPDATED` replaces the old `CREATED` to hold the table at six columns — an un-updated document has `updated_at === created_at`, and the true creation time is version 1's `created_at` in `poof versions`.
- `rollback` validates the version number locally before spending a round-trip, and prints `rolled back {id} to v{n}`.
- `cat` prints **the rendered HTML, not the Markdown source**: only the rendered blob is retained (§8), so a Markdown document comes back wrapped in the viewer template. It is for checking what a recipient actually sees — piping it back through `update` would overwrite the document with its own rendering and destroy the source. `--version` is validated locally like `rollback`'s, and the body is written to stdout verbatim (no added trailing newline), so `poof cat {id} > out.html` is byte-identical to what `/raw` serves.
- The API answers `cat` with `text/plain`, not `text/html`, even though the body is HTML: the response comes from the real `poof.5n7.me` origin, so it must be inert if a browser ever navigates to it (§6.1, §9). The CLI does not care about the type, and the choice costs it nothing.

## 11. Main flows

1. **Upload (web or CLI)** → render if MD → insert `document` + version 1 rows → store blob in R2 → return URL.
2. **Library view** → `/` lists `ORDER BY created_at DESC` → `/d/{id}` embeds sandboxed iframe via minted `o_` token.
3. **Issue share** → insert `share` row → return `poof.5n7.me/v/{token}`.
4. **Shared view** → `/v/{token}` validates share (404 on any failure) → joins to the document's **current** version → sandboxed iframe → `/raw/s_{token}` → R2 blob.
5. **Revoke** → `revoked=1` → next request 404s immediately.
6. **Update** → `poof update {id} file.md` (or drop/⌘V on `/d/{id}`) → render → stage version `MAX+1` → put blob → move `current_version` → **every existing share link serves the new content on its next load**, same token, nothing re-issued.
7. **Rollback** → `poof versions {id}` to pick a number (or the versions modal on `/d/{id}`) → `poof rollback {id} N` → one guarded `UPDATE` of the pointer, no blob written → live share links follow immediately, and a later update is numbered `MAX+1`, not `N+1`.

## 12. Future work (explicitly not now)

- **Physically separate serving origin** (e.g. `poof-v.5n7.me`) if sharing with third parties becomes serious — full cookie-space isolation on top of the CSP sandbox. Near-zero cost with an extra Workers route.
- **Share-side auth** (passcode or Access allowlist) if unlisted+TTL stops being enough.
- **Per-share version pinning** — a share that keeps serving the version it was issued against instead of following the current one. The schema already supports it (`share` would gain a nullable `version`); the reason not to build it is that "the link I sent shows what I fixed" is the whole point of §3, and a pinned share silently diverging from the document is the confusing case.
- **Retaining the source blob** alongside the rendered one, so a document could be round-tripped (`poof cat --source {id} > report.md`, edit, `poof update`) instead of only inspected. Today §8 stores the rendering and nothing else, which is why `poof cat` can only print HTML. Costs a second R2 object per version and a schema column; not worth it until editing-from-the-server is actually wanted.
- **Version diffs** in the owner UI (v2 vs v3). Needs a diff renderer and a second read path, and so far reading the two versions side by side has been enough.
- **KV read-through cache** for the public path (§5).

## 13. Cost

$0/month realistic. All components in free tiers; R2 egress is free. Only real cost is the domain (~$10/year, already owned).

## 14. Decision summary

| Item              | Decision                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share model       | Unlisted URL + TTL; `share` as its own entity; revocation in initial scope                                                                                        |
| Versioning        | Document = stable identity + ordered immutable versions; `document_version` is the only source of truth for blobs; `current_version` is a pointer, next = `MAX+1` |
| Share on update   | Shares **follow the current version** — an update reaches everyone holding a live link, no re-issue; per-share pinning is out of scope (§12)                      |
| Rollback          | `POST …/versions/:version/rollback`; pointer move only, no blob copied; already-current is an idempotent no-op                                                    |
| Version viewing   | Owner-only: `/d/{id}?v=N` (read-only, behind Access) via an `o_` token with the version **inside the signed payload**; `/raw` never accepts a `v` query param     |
| Security boundary | **CSP `sandbox allow-scripts allow-popups` response header** on `/raw/*` (primary) + iframe `sandbox` attribute (defense in depth); never `allow-same-origin`     |
| Delivery path     | Single public `/raw/{token}` endpoint; `s_` share tokens (D1) + `o_` owner tokens (HMAC, ~10 min)                                                                 |
| Sanitization      | None; all docs treated as untrusted blobs, sandbox is the boundary                                                                                                |
| Rendering         | Write-time `markdown-it` in the Worker; Mermaid + highlight.js lazily loaded client-side inside the sandbox                                                       |
| Errors            | Uniform 404 for missing/expired/revoked                                                                                                                           |
| Tokens            | `crypto.getRandomValues`, 128-bit, base64url                                                                                                                      |
| Auth              | Cloudflare Access (`/` + API); service token for CLI; bypass on `/v/*` `/raw/*`                                                                                   |
| Infra / stack     | Cloudflare Workers + R2 + D1 + Access; TypeScript + Hono + wrangler + vitest-pool-workers                                                                         |
| Provisioning      | Idempotent `scripts/bootstrap.sh` + `docs/SETUP.md`; no Terraform until environments multiply; `workers_dev` disabled; Access JWT verified in-Worker              |
| TTL defaults      | Library: none; shares: 1 day (1h/1d/1w selectable)                                                                                                                |
| Headers           | `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on viewer/raw paths                                                                                       |
