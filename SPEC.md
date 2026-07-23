# poof — Ephemeral Document Viewer & Sharing Tool

_Spec v0.2 — incorporates security review decisions (CSP sandbox, unified delivery path), Mermaid support, and CLI._

> **poof**: throw a document in, view it rendered, share it with a TTL, and it goes _poof_. Served at `poof.5n7.me` (Cloudflare, subdomain of `5n7.me`).

---

## 1. Purpose

View AI-generated design docs and memos (Markdown / HTML) **properly rendered in a browser**. Most are throwaway, but some need to be **temporarily shared with specific people via a link**. Personal tool; top priority is being **lightweight and effectively free**.

## 2. Scope

### In scope

- Upload Markdown / HTML documents and view them in the browser
- Personal library (list view, authenticated, owner-only)
- Per-document disposable share links (unlisted URL + TTL), with manual revocation
- JavaScript execution inside documents (interactive charts, tabs, widgets)
- **Mermaid rendering** in Markdown code fences (`` ```mermaid ``)
- **CLI** for headless upload/share (`poof push design.md --share`)

### Out of scope (for now)

- Multi-user upload (owner is the only uploader)
- Document editing (re-upload to replace)
- Viewer authentication for shares (unlisted + TTL is the accepted trade-off)
- Physically separate serving origin (future work, §12)

## 3. Core model: two surfaces

| Surface                  | Nature                               | Auth                | TTL      |
| ------------------------ | ------------------------------------ | ------------------- | -------- |
| **A. Library (private)** | Your documents. Persistent entities. | Yes (owner only)    | Optional |
| **B. Disposable shares** | Links to a specific document.        | None (unlisted URL) | Required |

**Key design decision**: a share is **its own entity (`share`)**, not an attribute of a document. Share links expire or get revoked independently; multiple links per document (per recipient / per deadline) are possible; killing a share never touches the document.

## 4. Architecture

**Single Cloudflare stack. Everything fits the free tier.**

| Role                        | Cloudflare service    | Free tier (as of 2026)     |
| --------------------------- | --------------------- | -------------------------- |
| Runtime                     | **Workers**           | 100K req/day, 10ms CPU/req |
| Blob storage                | **R2**                | 10GB, zero egress fees     |
| Metadata (document / share) | **D1** (SQLite)       | 5GB, 5M row reads/day      |
| Owner auth                  | **Cloudflare Access** | Free up to 50 users        |

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

### `document` — library entity, persistent

```sql
CREATE TABLE document (
  id          TEXT PRIMARY KEY,      -- 128-bit random, base64url
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,         -- 'html' | 'md'
  r2_key      TEXT NOT NULL,         -- rendered HTML blob in R2
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER                -- optional owner TTL; NULL = keep forever
);
```

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

| Prefix | Kind             | Backing                                                                                       | Used by                          |
| ------ | ---------------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| `s_`   | Share token      | `share` row in D1 (checks `expires_at`, `revoked`)                                            | Public shared view `/v/{token}`  |
| `o_`   | Owner view token | Stateless HMAC-signed payload `{document_id, exp}`, TTL ~10 min, secret via `wrangler secret` | Private library viewer `/d/{id}` |

The Access-protected library page mints an `o_` token when rendering the viewer, so owner viewing and public sharing go through **the exact same hot path** — one endpoint, one set of headers, no cookie problems, no second code path.

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
2. **Background cleanup (housekeeping, non-security)**: weekly Cron Trigger deletes expired `share` rows, expired `document` rows (where `expires_at` is set) plus their R2 blobs and cascaded shares, and sweeps orphaned R2 objects. Expired rows left behind are harmless — read-time checks reject them.

## 8. Rendering pipeline (write-time, single path)

Free-tier Workers allow 10ms CPU per request, so rendering happens **once at upload**, never at view time:

```
[Upload]
  md   → markdown-it → wrap in viewer template → store final HTML in R2
  html → store as-is in R2
        (everything converges to "one HTML blob per document")

[View (hot path)]
  fetch blob from R2 → serve with sandbox headers. Near-zero CPU.
```

- **Converter**: `markdown-it` (CommonMark + tables + strikethrough). No sanitizer (§6.4). Typical AI docs (tens of KB) render in well under 10ms.
  - _Documented fallback if a doc ever blows the CPU budget_: move MD→HTML into the client (upload page renders in the browser; CLI renders locally) and POST final HTML. The API accepting `kind` and raw content makes this switch non-breaking.
- **Viewer template** (MD only; HTML uploads are stored verbatim): minimal GitHub-flavored CSS, plus a tiny inline loader that lazily injects client-side libraries **only when needed**, keeping Worker CPU flat:
  - **Mermaid**: `` ```mermaid `` fences render as `<pre class="mermaid">` (content escaped); loader injects mermaid.js (CDN, SRI-pinned) if `.mermaid` elements exist.
  - **Syntax highlighting**: highlight.js via the same lazy pattern if code blocks exist.
  - Both run inside the sandbox, so they are safe by construction.

## 9. HTTP surface

| Route                            | Auth                         | Purpose                                                    |
| -------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `GET /`                          | Access                       | Library list (newest first), upload UI                     |
| `POST /api/documents`            | Access (incl. service token) | Upload; body = file + title + kind; 10MB cap               |
| `GET /api/documents`             | Access                       | List documents                                             |
| `DELETE /api/documents/:id`      | Access                       | Delete document (+blob, cascades shares)                   |
| `POST /api/documents/:id/shares` | Access                       | Issue share (TTL param) → returns `/v/{token}` URL         |
| `GET /api/documents/:id/shares`  | Access                       | List active shares for a document                          |
| `DELETE /api/shares/:token`      | Access                       | Revoke (`revoked=1`, immediate)                            |
| `GET /d/:id`                     | Access                       | Private viewer page (mints `o_` token, embeds iframe)      |
| `GET /v/:token`                  | none                         | Public shared viewer page (validates share, embeds iframe) |
| `GET /raw/:token`                | none (token is the auth)     | Raw HTML blob with sandbox headers (§6)                    |
| Cron (weekly)                    | —                            | Cleanup (§7)                                               |

**Cloudflare Access configuration**: one Access application protecting `poof.5n7.me` with an allow policy (owner's Google account) **plus a service-token policy** (for the CLI), and a bypass application for `/v/*` and `/raw/*`.

Viewer pages (`/d/*`, `/v/*`) also send `Referrer-Policy: no-referrer` so links inside documents can't leak token URLs via `Referer`.

## 10. CLI

The primary upload path in practice (AI output → terminal → link). TypeScript, lives in `cli/`, runs via `npx`/`bunx` or a compiled binary.

```
poof push <file> [--title <t>] [--ttl <dur>] [--share [--share-ttl 1d]]
                                # upload; prints /d/{id} URL; --share also prints /v/{token}
poof ls                         # list documents
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof revoke <share-token>
poof rm <doc-id>
```

- Auth: **Cloudflare Access service token** via env vars (`POOF_URL`, `POOF_ACCESS_CLIENT_ID`, `POOF_ACCESS_CLIENT_SECRET`), sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers.
- The CLI only talks to the JSON API; rendering stays server-side (see §8 fallback if that changes).
- `kind` is inferred from the file extension (`.md` / `.html`); title defaults to the filename or first `# heading`.

## 11. Main flows

1. **Upload (web or CLI)** → render if MD → store blob in R2 → insert `document` → return URL.
2. **Library view** → `/` lists `ORDER BY created_at DESC` → `/d/{id}` embeds sandboxed iframe via minted `o_` token.
3. **Issue share** → insert `share` row → return `poof.5n7.me/v/{token}`.
4. **Shared view** → `/v/{token}` validates share (404 on any failure) → sandboxed iframe → `/raw/s_{token}` → R2 blob.
5. **Revoke** → `revoked=1` → next request 404s immediately.

## 12. Future work (explicitly not now)

- **Physically separate serving origin** (e.g. `poof-v.5n7.me`) if sharing with third parties becomes serious — full cookie-space isolation on top of the CSP sandbox. Near-zero cost with an extra Workers route.
- **Share-side auth** (passcode or Access allowlist) if unlisted+TTL stops being enough.
- **KV read-through cache** for the public path (§5).

## 13. Cost

$0/month realistic. All components in free tiers; R2 egress is free. Only real cost is the domain (~$10/year, already owned).

## 14. Decision summary

| Item              | Decision                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share model       | Unlisted URL + TTL; `share` as its own entity; revocation in initial scope                                                                                    |
| Security boundary | **CSP `sandbox allow-scripts allow-popups` response header** on `/raw/*` (primary) + iframe `sandbox` attribute (defense in depth); never `allow-same-origin` |
| Delivery path     | Single public `/raw/{token}` endpoint; `s_` share tokens (D1) + `o_` owner tokens (HMAC, ~10 min)                                                             |
| Sanitization      | None; all docs treated as untrusted blobs, sandbox is the boundary                                                                                            |
| Rendering         | Write-time `markdown-it` in the Worker; Mermaid + highlight.js lazily loaded client-side inside the sandbox                                                   |
| Errors            | Uniform 404 for missing/expired/revoked                                                                                                                       |
| Tokens            | `crypto.getRandomValues`, 128-bit, base64url                                                                                                                  |
| Auth              | Cloudflare Access (`/` + API); service token for CLI; bypass on `/v/*` `/raw/*`                                                                               |
| Infra / stack     | Cloudflare Workers + R2 + D1 + Access; TypeScript + Hono + wrangler + vitest-pool-workers                                                                     |
| Provisioning      | Idempotent `scripts/bootstrap.sh` + `docs/SETUP.md`; no Terraform until environments multiply; `workers_dev` disabled; Access JWT verified in-Worker          |
| TTL defaults      | Library: none; shares: 1 day (1h/1d/1w selectable)                                                                                                            |
| Headers           | `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on viewer/raw paths                                                                                   |
