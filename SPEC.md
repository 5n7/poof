# poof ephemeral document viewer and sharing tool

_Spec v0.6 gives the interactive CLI a Managed OAuth grant from the owner Access application. CI keeps a service token. The MCP server remains on its own hostname and audience, and the document versioning and CSP sandbox decisions remain unchanged._

> Throw in a document, view the rendered result, and share it until the link expires. poof runs at `poof.5n7.me` on Cloudflare, with its MCP endpoint at `mcp.poof.5n7.me`.

---

## 1. Purpose

View AI-generated Markdown and HTML design documents or memos in a browser. Most are temporary. Some need a link that works for specific people for a limited time. This is a personal tool designed to stay small and within free service tiers.

## 2. Scope

### In scope

- Upload Markdown / HTML documents and view them in the browser
- Personal library (list view, authenticated, owner-only)
- Per-document disposable share links (unlisted URL + TTL), with manual revocation
- **In-place document update**: replace the contents while keeping the same `/d/{id}` and the same already-issued share links
- **Version history**: past versions are retained, viewable, and restorable by the owner
- JavaScript execution inside documents (interactive charts, tabs, widgets)
- **Mermaid rendering** in Markdown code fences (`` ```mermaid ``)
- **CLI** for interactive or headless upload/share (`poof push design.md --share`)
- **MCP server** hosted by the Worker, exposing the same operations as tools to AI agents

### Out of scope (for now)

- Multi-user upload (owner is the only uploader)
- Viewer authentication for shares (unlisted + TTL is the accepted trade-off)
- Per-share version pinning and version diffs (future work, §13)
- Physically separate serving origin (future work, §13)

## 3. Core model: library and shares

| Surface                  | Nature                               | Auth                | TTL      |
| ------------------------ | ------------------------------------ | ------------------- | -------- |
| **A. Library (private)** | Your documents. Persistent entities. | Yes (owner only)    | Optional |
| **B. Disposable shares** | Links to a specific document.        | None (unlisted URL) | Required |

A share is **its own entity (`share`)**, not an attribute of a document. Share links expire or get revoked independently. A document can have several links for different recipients or deadlines. Revoking a share does not affect the document.

**Documents are mutable, versions are not.** A document has a stable id, title, and TTL. Its content is an ordered sequence of immutable versions plus a pointer to the live one. `/d/{id}` and every `/v/{token}` resolve that pointer **at request time**, so existing links show updates without being reissued. Recipients always see the current version and never see version numbers or history. Only the owner can view or restore past versions (§9).

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
  scripts/        # bootstrap.sh, idempotent resource creation (D1, R2)
  docs/           # SETUP.md (Access, secrets, domain) + MCP-OAUTH-RUNBOOK.md
  wrangler.jsonc
```

### Infrastructure management

- `wrangler.jsonc` declares all bindings, routes, and cron triggers.
- **`scripts/bootstrap.sh`** creates the D1 database and R2 bucket. It skips resources that already exist, so the repository records the required resources without Terraform state. Revisit Terraform or OpenTofu only if the project gains more environments.
- Configure the Cloudflare Access applications, Managed OAuth, and the optional CI service token in the Zero Trust dashboard. **`docs/SETUP.md`** lists each step, and **`docs/MCP-OAUTH-RUNBOOK.md`** covers the separate MCP application.
- `workers_dev` and `preview_urls` are disabled because the default `*.workers.dev` route would bypass Access. The Worker serves only the two hostnames it is configured with and refuses every other host (§6.5). It also validates the Access JWT in `Cf-Access-Jwt-Assertion` against the route's own audience (§6.6).

## 5. Data model (D1, single store)

### `document`

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

Migration `0002` moved `kind` and `r2_key` from this table into `document_version`, which is now the **only authoritative record of blobs**. `document` has no `current_r2_key` mirror. Adding one would force the orphan sweep to combine references from two tables, and drift between them could delete live blobs. Each view request uses one JOIN on a composite primary key and adds no round trips.

### `document_version`

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

The code enforces three rules that the schema cannot express:

1. **`current_version` is a pointer, not a maximum.** After a rollback it trails `MAX(version)`. New versions therefore use `MAX(version) + 1`, never `current_version + 1`. Using the pointer would collide with recorded history after a rollback. The composite primary key turns that collision into an error, and the writer retries with a fresh number. Every document has at least one version. An `EXISTS` clause on the pointer update ensures that `current_version` names a real row.
2. **R2 keys are read, never derived.** New versions, including version 1 of a new document, use `doc/{id}/v{n}.html`. Version 1 rows created before versioning retain the flat `doc/{id}.html` key. The migration backfilled these rows without copying or rewriting objects. The cron's `doc/` prefix covers both key shapes. They cannot collide because one has `.html` directly after the id and the other has `/`.
3. **Rollback moves the pointer and copies nothing.** A restored version keeps its original row and blob, so the history stays a faithful record of what was actually uploaded and no two rows ever share an `r2_key`.

`expires_at` applies to the **document**. When it passes, the document and all versions expire together. Versions have no individual TTL.

### `share`

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

The project uses one D1 store for these reasons:

1. Every store would still need read-time expiry checks. KV's native TTL would only replace the weekly cleanup `DELETE`.
2. `share → document` is a real relation. D1 enforces the foreign key and `ON DELETE CASCADE`.
3. Listing and revocation need queries and strong consistency. SQL handles both, and revocation takes effect immediately. KV deletes can lag by up to 60 seconds.
4. One store keeps the deployment small.

> If the public view path becomes busy across regions, add KV as a read-through cache in front of D1. This is an additive change and does not belong in the initial implementation.

### Token generation

Both `document.id` and `share.token` use **16 random bytes from `crypto.getRandomValues`, encoded as base64url**. The result has about 22 characters and 128 bits of entropy.

## 6. Delivery path and security model

Uploaded documents can run arbitrary JavaScript, so their HTML must never execute in the real `poof.5n7.me` origin.

### 6.1 CSP `sandbox` response header

All raw document HTML is served from a single endpoint, and every response carries:

```
Content-Security-Policy: sandbox allow-scripts allow-popups
Referrer-Policy: no-referrer
X-Robots-Tag: noindex
```

The **CSP `sandbox` directive is the primary defense**. It forces an opaque origin even when someone opens the URL directly in the address bar. Scripts run, but they cannot access cookies, storage, or the real origin. A malicious document therefore cannot reach the Access-protected admin pages.

Viewer pages also put the equivalent sandbox attribute on the iframe:

```html
<iframe sandbox="allow-scripts allow-popups" src="/raw/{token}"></iframe>
```

> Warning: never add `allow-same-origin` to the header or attribute. Combining it with `allow-scripts` neutralizes the sandbox.

The opaque origin imposes two accepted limits. Accessing `localStorage` or `document.cookie` throws inside documents. `target="_blank"` works only because the policy includes `allow-popups`.

### 6.2 Unified raw endpoint, two token kinds

A sandboxed iframe has an opaque origin, so its subresource/navigation requests are treated as cross-site and **SameSite cookies (including Access's `CF_Authorization`) are not sent**. Therefore the raw endpoint must not sit behind Access. Instead, `GET /raw/{token}` is public and validates one of two token kinds:

| Prefix | Kind             | Backing                                                                                                 | Used by                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `s_`   | Share token      | `share` row in D1 (checks `expires_at`, `revoked`); resolves to the **current** version                 | Public shared view `/v/{token}`  |
| `o_`   | Owner view token | Stateless HMAC-signed payload `{document_id, exp, version?}`, TTL ~10 min, secret via `wrangler secret` | Private library viewer `/d/{id}` |

The Access-protected library page mints an `o_` token when it renders the viewer. Owner views and public shares then use **the same endpoint and headers** without relying on cookies.

**Version pinning lives inside the signed payload, never in a query parameter.** The token authorizes access to `/raw/*`, so accepting `?v=N` would let a share holder enumerate the edit history. Only `/d/{id}?v=N`, which sits behind Access, can mint a pinned token. The pin expires with the token after about 10 minutes.

- `s_` tokens have no version field at all: there is structurally no way to ask a share for anything but the current version.
- An `o_` token pointing at the current version **omits `v` entirely**, so ordinary tokens stay byte-identical to the pre-versioning format and tokens minted before the change keep verifying.

The HMAC authenticates the payload but does not replace validation. After the HMAC check, the Worker rejects a `v` that is not a positive integer, including `0`, `-1`, `1.5`, or `"2"`.

### 6.3 Error responses

Nonexistent, expired, and revoked tokens all return the **same status (404)** with an identical body, so a probe cannot distinguish "never existed" from "existed and expired".

### 6.4 No sanitization

HTML uploads run arbitrary JavaScript by design. Sanitizing only Markdown-derived HTML would create inconsistent behavior without improving the security boundary. **The system treats every document as an untrusted HTML blob and relies on the CSP sandbox.** It has no sanitizer dependency.

### 6.5 Two hostnames, two Access applications

One Worker serves two hostnames, and `src/index.ts` picks the surface from the request host before any route matches:

| Hostname          | Var          | Serves                                            | Access application |
| ----------------- | ------------ | ------------------------------------------------- | ------------------ |
| `poof.5n7.me`     | `OWNER_HOST` | `/`, `/api/*`, `/d/*`, and public `/v/*` `/raw/*` | `ACCESS_AUD`       |
| `mcp.poof.5n7.me` | `MCP_HOST`   | `POST /mcp`, and nothing else                     | `ACCESS_MCP_AUD`   |

Both applications use Managed OAuth, but their grants remain separate. The owner application authorizes browser sessions and the CLI against the library and JSON API. Its optional Service Auth policy exists only for CI and other headless jobs. The MCP application authorizes hosted clients against `POST /mcp` and has no Service Auth policy. Separate hostnames and audiences keep an MCP grant away from `GET /api/documents/:id/content` and keep an owner CLI grant away from MCP tools.

Isolation is structural rather than a rule applied per route. Each hostname gets its own Hono app, and the MCP app registers exactly one path, so `mcp.poof.5n7.me/raw/{token}` returns 404 for a live token: the route does not exist there to be reached. A route added to the owner app cannot appear on the MCP hostname by accident, because nothing mounts it there.

The audience is per route. `accessAuth` takes the application it is protecting and validates `aud` against that application's tag. A token minted for the MCP application presents itself at `/api/*` and gets 403, and the reverse holds too (§6.6).

An unrecognized host is served nothing. Both hostnames are named explicitly and anything else returns 404. `workers_dev` and `preview_urls` are already off, so no third hostname should arrive. If one does, through a zone route added by hand or a hostname moved between Workers, it arrives with no Access application in front of it, and falling back to the owner app would put the library one misconfigured DNS record from public.

Configuration failures close the surface, and how much they close depends on which value is wrong. A missing, blank, or malformed `MCP_HOST` or `OWNER_HOST`, or a pair naming one host, answers `503 Service Unavailable` to every request, because host isolation is what decides which surface a request reaches at all. A missing or blank `ACCESS_TEAM_DOMAIN` or route audience closes only what `accessAuth` guards. Two equal AUD tags close both surfaces, since equal tags mean one application and there is no half of that worth serving. The status is 503 rather than 403 because nothing is wrong with the request, and because 403 is what a rejected token already returns, which would make the two failures indistinguishable in the logs.

Missing and blank end the same way by construction. `wrangler types` declares every var as a required `string`, but a var dropped from `wrangler.jsonc` reaches the Worker with no property at all, and `undefined.trim()` would be a 500 where the 503 belongs. `configured()` in `src/lib/hosts.ts` collapses both to `""`.

During a new rollout, `ACCESS_MCP_AUD` stays blank until the MCP Access application exists and its configuration has been checked. That closes `POST /mcp` and nothing else: `accessAuth` is mounted on the exact path `/mcp`, so `/mcp` answers 503 while every other path on `mcp.poof.5n7.me` answers 404 for the ordinary reason that no route is mounted there.

Hostnames are normalized before anything compares them (`src/lib/hosts.ts`), and the two comparisons need different answers. Whether the vars name one host or two is decided on DNS identity alone (`hostIdentity`), with the port discarded. Including the port would make the answer depend on the request's scheme: `OWNER_HOST=example` against `MCP_HOST=example:443` collapses to one host over HTTPS, where 443 is the default and drops, and stays two strings over HTTP, where it does not. One DNS name cannot be two isolated surfaces on either scheme.

Matching a request to a surface uses the full authority (`canonicalHost`), so a configured non-default port still routes, which is what lets `wrangler dev` serve both surfaces from its single port: `localhost:8787` is the owner host and `127.0.0.1:8787` the MCP host. Case and the trailing DNS root label normalize away in both comparisons. A value that is not a bare authority is `null` and fails closed, including one carrying a `/`, `?`, or `#` with nothing after it, since `poof.5n7.me/` names the same host `poof.5n7.me` does and accepting both would give one host two spellings that compare unequal.

### 6.6 Access JWT verification

Access runs in front of both hostnames in production. The Worker verifies the token again, which is what stops a request that reached it some other way.

The Worker reads `Cf-Access-Jwt-Assertion` and never the `CF_Authorization` cookie. Cloudflare guarantees the header, and service-token clients send no cookie at all. The two authentication methods produce the same token _format_, signed by the same key and verified by one code path, but not the same _claims_: an interactive login carries `email`, `nbf`, `country`, `identity_nonce`, and a UUID `sub`, while a service token carries `common_name` and `"sub": ""`. Verification is therefore shared and acceptance is not, which is what the per-route branch below acts on.

Beyond a valid RS256 signature from the team's JWKS, the Worker requires:

| Claim  | Requirement                                  | Why                                                                                                  |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `aud`  | contains the **route's own** application tag | The boundary in §6.5                                                                                 |
| `iss`  | exactly `https://{ACCESS_TEAM_DOMAIN}`       | A token from another Cloudflare team cannot be replayed here                                         |
| `exp`  | present, in the future                       | `hono/jwt` checks expiry only when the claim is present, so a token with no `exp` would never expire |
| `iat`  | present, not in the future                   | Same reason                                                                                          |
| `type` | `"app"`                                      | Cloudflare also issues `"org"` global session tokens, signed by the same team key                    |

The set is the intersection of the two payloads Cloudflare documents, the identity login and the service token, and it applies on both hostnames. `nbf` is not required, because only the identity payload carries one and requiring it would reject every service token; it is still enforced on tokens that do carry it. `sub` must be present, because both payloads document it, but its value is only read below.

The owner routes take either documented assertion. Interactive browser and CLI OAuth logins produce identity assertions, while CI produces a service-token assertion. `POST /mcp` takes an identity assertion only:

| Claim         | MCP requirement                                   |
| ------------- | ------------------------------------------------- |
| `common_name` | absent (it is the service token's Client ID)      |
| `sub`         | present and non-empty (a service token's is `""`) |
| `email`       | present and non-empty (service tokens have none)  |

This is the Worker-side half of "the MCP application has no Service Auth policy" (§11.2). The policy is the primary control. This still refuses a static credential if such a policy is added by hand, or if the endpoint is pointed at an application that has one. All three signals are checked rather than any one, because a single check is a single point of failure on a boundary whose job is keeping a static credential out. `country` and `identity_nonce` are identity-only too and are deliberately not required. They add no discrimination beyond `email` and `sub`, and each further requirement is another way for a legitimate login to be refused if Cloudflare omits one.

`DEV_DISABLE_ACCESS=1` skips this check and nothing else. Host and path isolation still apply with it set, so a local MCP client still cannot reach `/api/*`. The comparison is against the exact string `"1"`, and setting it in production would make every unauthenticated request the owner.

## 7. TTL enforcement (two layers)

### Defaults

- **Library**: no default TTL (keep forever). `expires_at` optional.
- **Shares**: default TTL **1 day**; selectable at issue time (1h / 1d / 1w).

### Enforcement

1. **Read-time validation is authoritative.** `/raw/{token}` and `/v/{token}` check `expires_at`, `revoked`, and existence on every request. Invalid requests return 404 immediately.
2. **Background cleanup reclaims storage.** A weekly Cron Trigger deletes expired `share` rows and expired `document` rows. It also deletes every R2 blob for those documents, relies on cascades for their shares, and sweeps orphaned R2 objects. Read-time checks reject expired rows before the cron removes them.

Two details the versioned schema forces:

- The sweep reads its reference set from **`document_version.r2_key`**, not `document`. Otherwise it would treat every non-current version as an orphan. It reads a document's version keys **before** deleting the row because the foreign-key cascade also deletes `document_version` rows.
- **`src/lib/batch.ts`** chunks the larger delete and sweep operations. D1 accepts at most 100 bound parameters per statement. An R2 listing page can contain 1000 keys, and `delete()` accepts at most 1000 keys per call.

## 8. Rendering pipeline (write-time, single path)

Free-tier Workers allow 10ms CPU per request, so rendering happens **once per version at write time**, never at view time:

```
[Upload / update]
  md   → markdown-it → wrap in viewer template → store final HTML in R2
  html → store as-is in R2
        (everything converges to "one HTML blob per version")

[View]
  resolve the version → fetch blob from R2 → serve with sandbox headers. Near-zero CPU.
```

- **Converter.** `markdown-it` provides CommonMark, tables, and strikethrough. There is no sanitizer (§6.4). Typical documents of tens of kilobytes render in well under 10ms. If a document exceeds the CPU budget, move Markdown rendering into the clients and send final HTML. The API already accepts `kind` and raw content, so this change would not break it.
- **Viewer template.** Markdown uses minimal GitHub-style CSS and a small inline loader. HTML uploads remain unchanged. The loader fetches client-side libraries only when the document needs them.
  - Mermaid fences render as escaped `<pre class="mermaid">` elements. If those elements exist, the loader fetches an SRI-pinned mermaid.js file from a CDN.
  - If code blocks exist, the loader fetches highlight.js in the same way.
  - Both libraries run inside the sandbox.
- **Per version.** An update renders and stores a new blob without changing existing blobs. Rollback renders nothing (§5). Because each version stores its own `kind`, an update may switch a document between Markdown and HTML.

**Automatic titling** lives in `src/lib/title.ts` and runs before rendering. Markdown stores the title in the blob's `<title>`, so a later `waitUntil` callback cannot set it. The Workers AI call is therefore synchronous.

The naming process runs only when `title` is absent or blank. A supplied title is used verbatim. `POST /api/documents` and the MCP `push` tool both use this fallback order:

1. Workers AI
2. The document's first `#` heading
3. A client-specific fallback

The API uses the uploaded file name as its final fallback. MCP has no file name, so it uses `untitled`. `resolveNewTitle` validates the final fallback too, which prevents an empty title when multipart data contains `filename=""`. A missing binding, timeout, retired model, or rejected response moves to the next fallback instead of failing the upload.

The model is `@cf/ibm-granite/granite-4.0-h-micro`, and the prompt requests one line. Code chooses the response language. When kana exceed a threshold in the excerpt, the prompt explicitly requests Japanese and includes a Japanese example. This rule exists because the 3B model returned English titles for two of three Japanese documents in production. English excerpts keep the general instruction to match the document language.

The parser takes the first non-empty line and removes `Title:` labels, Markdown markers and links, wrapping quotes, and trailing `.`, `。`, or `!`. It rejects the result instead of truncating it when any of these conditions apply:

- It exceeds 80 code points.
- It reads as a preamble.
- It opens a `<think>` block without closing it. With a 32-token output limit, a reasoning model may stop mid-scratchpad.
- It contains no letter or number.

The parser preserves a trailing `?` and the ideographic space U+3000. It removes invisible format characters because `U+202E`, for example, can reverse the displayed direction of the rest of a library row. ZWNJ and ZWJ remain because they carry meaning in Persian, Devanagari, and emoji sequences.

HTML uploads skip Workers AI. Extracting text from arbitrary HTML would require sanitizer-like parsing, and poof has no sanitizer (§6.4). For untitled Markdown, the Worker sends the first 2000 characters to Workers AI within Cloudflare. The `<document>` delimiter reduces prompt injection ambiguity but is not a security boundary. A document can influence its own title, which is safe because the renderer HTML-escapes the title and D1 stores it in a `TEXT` column.

## 9. HTTP routes

Every route below is on `poof.5n7.me` except `POST /mcp`, which is on `mcp.poof.5n7.me` and is the only path that hostname serves (§6.5). Each hostname has its own Access application, so "Access" in the table means a different audience for the two.

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
| `POST /mcp`                                          | Access, MCP application      | MCP server (Streamable HTTP): nine tools over the same core (§11)   |
| `GET /d/:id`                                         | Access                       | Private viewer page (mints `o_` token, embeds iframe)               |
| `GET /d/:id?v=N`                                     | Access                       | Read-only view of version N (banner, no Share, no uploader)         |
| `GET /v/:token`                                      | none                         | Public shared viewer page; **always the current version**           |
| `GET /raw/:token`                                    | none (token is the auth)     | Raw HTML blob with sandbox headers (§6)                             |
| Cron (weekly)                                        | N/A                          | Cleanup (§7)                                                        |

Version routes follow these rules:

- A document must be **live**, not merely present, to create or list versions. Both requests return 404 for an owner-expired document, as does `POST …/shares`.
- Writes have three phases. The Worker stages the row, puts the blob, and performs one guarded `UPDATE` as the atomic cutover. Readers therefore see either the old version or the new version, never a pointer to a missing blob.
- Rollback uses the `…/versions/:version/rollback` path instead of a `PATCH` to `current_version`. The route verifies that the target exists and matches the verb used by the CLI and UI. A malformed `:version` returns `400 {error:"invalid version"}`. A valid but unknown version returns the standard 404. Rolling back to the live version is an idempotent no-op and does not change `updated_at`.
- `GET …/content` reads its version pin from `?v=N`, while `/raw` rejects that parameter (§6.2). A token authorizes `/raw`, so accepting a version in the URL would let share holders enumerate history. Access authorizes `…/content`, and its URL grants no additional access. A malformed `v` returns `400 {error:"invalid version"}`, and an unknown version returns the standard 404.
- `GET …/content` sends `text/plain; charset=utf-8`, `nosniff`, and a bare `sandbox` CSP. Its body contains untrusted HTML on the real origin. These headers make browsers render it as text instead of executing markup (§6.1).
- `/d/{id}?v=N` is a page rather than an API, so a malformed `v` returns the standard 404 instead of 400. If `v` names the live version, the request uses the normal viewer instead of a read-only view.
- **Auto-naming applies only to creation.** On `POST /api/documents`, an absent `title` starts the naming process from §8. A supplied title is used verbatim. On `POST …/versions`, an absent `title` keeps the current title. Updates must not silently rename the document or change the recipient page's `<title>`. MCP `push` and `update` follow the same rule (§11.4).

**Cloudflare Access configuration.** Two applications, one per hostname (§6.5). The `poof.5n7.me` application allows the owner's exact email through the Cloudflare identity provider, enables Managed OAuth for the CLI, and keeps a Service Auth policy only for CI. The `mcp.poof.5n7.me` application allows the same owner identity and has **no Service Auth policy**. A service token there would skip the account login. Bypass applications cover only `poof.5n7.me/v/*` and `poof.5n7.me/raw/*`. `docs/SETUP.md` and `docs/MCP-OAUTH-RUNBOOK.md` have the configuration.

Viewer pages (`/d/*`, `/v/*`) also send `Referrer-Policy: no-referrer` so links inside documents can't leak token URLs via `Referer`.

## 10. CLI

The CLI is the usual path from AI output to a share link. It is written in TypeScript, lives in `cli/`, and runs through `npx`, `bunx`, or a compiled binary.

```
poof cat <doc-id> [--version <n>]
                                # print the stored (rendered) HTML to stdout
poof login [--new-client] [--no-open]
poof logout
poof ls                         # list documents
poof push <file> [--title <t>] [--ttl <dur>] [--share [--share-ttl 1d]]
                                # upload; prints /d/{id} URL; --share also prints /v/{token}
poof revoke <share-token>
poof rm <doc-id>
poof rollback <doc-id> <version>
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof status
poof update <doc-id> <file> [--title <t>]
                                # new version of an existing document; prints /d/{id} then v{n}
poof versions <doc-id>          # VER / KIND / CREATED / CURRENT, newest first, '*' marks current
```

- `POOF_URL` is required and must be an HTTPS origin. Service authentication
  also accepts literal `http://localhost` and `http://127.0.0.1` origins for
  local development. OAuth remains HTTPS-only. A complete
  `POOF_ACCESS_CLIENT_ID` and `POOF_ACCESS_CLIENT_SECRET` pair selects service
  authentication for CI or another headless job. One missing half is an error.
  Without the pair, the CLI uses Managed OAuth and never falls back to service
  authentication.
- `login` discovers OAuth from the protected owner root's `401` challenge, follows RFC 9728
  and RFC 8414 metadata, registers a public client for the exact owner resource,
  and completes authorization code + PKCE S256 on an exact random callback path
  at `127.0.0.1`. The saved client registration, callback port, and optional
  tokens share one credential-manager record scoped to the canonical
  `POOF_URL`. `--new-client` replaces it only after authorization and token
  exchange succeed; denial leaves the previous grant intact. `--no-open` leaves
  browser launch to the user. Non-interactive input must pass `--no-open`
  explicitly. The callback accepts one code or one error only, with one matching
  state, on the exact saved `127.0.0.1` authority and path.
- DCR, authorization, code exchange, and refresh requests send the canonical
  resource. A token response may omit `resource`; when present, it must
  normalize to the same value.
- OAuth tokens live only in the operating system's credential manager through
  `Bun.secrets`. Each encrypted record repeats its resource, issuer, and client
  id and must match the strictly validated registration before use. One lock
  per canonical resource serializes every credential mutation. Release checks a
  random owner token, and waiters do not delete locks they do not own.
- Ordinary commands refresh within 60 seconds of token expiry but never open a
  browser. A rejected safe read gets one forced refresh and retry. Writes are
  never replayed automatically; after refreshing a rejected write, the CLI asks
  the caller to rerun it.
- `logout` attempts RFC 7009 refresh-token revocation, then deletes local tokens
  even when revocation fails. A remote failure returns nonzero and says that the
  local credential is gone. `status` checks the selected credential against the
  live owner API without opening a browser. If a service pair remains in the
  environment, login and logout say that service authentication still wins.
- The CLI only talks to the JSON API; rendering stays server-side (see §8 fallback if that changes).
- `kind` is inferred from the file extension (`.md` / `.html`) on both `push` and `update`, so a document may switch between Markdown and HTML from one version to the next.
- **Title.** `push` uses the first Markdown `# heading`, then the file name. `update` keeps the existing title unless the caller passes `--title`. The CLI always resolves and sends a title for `push`, so the server's naming process (§8) does not run. That process handles documents pasted into the web UI and MCP `push` calls without a title (§11.4).
- `ls` columns are `ID TITLE KIND VER UPDATED EXPIRES`. `VER` is `current_version`. `UPDATED` replaces the old `CREATED` to keep six columns. For an unchanged document, `updated_at === created_at`. `poof versions` shows the original creation time in version 1's `created_at`.
- `rollback` validates the version number locally before spending a round-trip, and prints `rolled back {id} to v{n}`.
- `cat` prints **rendered HTML, not Markdown source**. The system retains only the rendered blob (§8), so Markdown comes back inside the viewer template. Do not pass this output to `update`; doing so would replace the document with its rendering and lose the source. The CLI validates `--version` locally and writes the body to stdout without adding a trailing newline. `poof cat {id} > out.html` is therefore byte-identical to the `/raw` response.
- The API returns `cat` content as `text/plain`, even though the body contains HTML. The response comes from the real `poof.5n7.me` origin and must remain inert if opened in a browser (§6.1, §9). The content type does not affect the CLI.

## 11. MCP server

The Worker hosts an **MCP server** at `POST https://mcp.poof.5n7.me/mcp`. It gives AI agents the same operations as the CLI without running `poof` in a shell. One deployment handles both `/api/*` and `/mcp`, on two hostnames (§6.5), so there is no local MCP process to install or maintain.

### 11.1 Transport and stateless operation

The server uses **Streamable HTTP** through `@hono/mcp`'s `StreamableHTTPTransport` and `@modelcontextprotocol/sdk`. It is mounted as a regular Hono route. stdio requires a local process, so it does not apply here. The deprecated HTTP+SSE transport needs another endpoint and a long-lived connection, which a request-scoped Worker isolate cannot guarantee. The implementation adds `@hono/mcp`, `@modelcontextprotocol/sdk`, and `zod` for tool input schemas. They add about 196 KB gzipped to the bundle. It needs neither Durable Objects nor `nodejs_compat`.

**Each request creates a new `McpServer` and transport, and the server issues no session id.** Cloudflare creates, reuses, and discards isolates outside the Worker's control. A module-scoped server could be shared by unrelated requests in one isolate and missing from another. Every tool call is already a self-contained API operation, so there is no cross-call state to retain. Per-request construction costs one constructor call and schema registration, not another network request.

**The route accepts only `POST`.** Every other method returns `405` with an `Allow: POST` header. Streamable HTTP defines a `GET` that opens an SSE stream for server-initiated messages, but this stateless server has no messages to initiate. The stream would remain open only for keep-alive pings.

The MCP specification permits a server without an SSE stream to answer `GET` with `405`. The reference client treats this as "an expected case that should not trigger an error" in `@modelcontextprotocol/sdk/client/streamableHttp.js`. It handles `405` on `DELETE` in the same way when the server has no explicit session termination. POST-only operation is therefore part of the implemented negotiation path.

The Worker registers the 405 response explicitly. With only `post("/")`, Hono would return its fallback **404** for `GET`, which incorrectly reports a missing endpoint. An `all("/")` handler after the POST route returns the required status and `Allow: POST` header. The route table in §9 names the method for the same reason.

The path is exact. Hono matches `/mcp` and answers 404 for `/mcp/`, `/mcp//`, and `/mcp/anything`, so the endpoint is registered with clients as `https://mcp.poof.5n7.me/mcp` with no trailing slash. A tolerant match would be worse than an inconvenient one. The `accessAuth` and `csrfProtection` middleware are registered on the exact path `/mcp`, so any spelling the router accepted but the middleware did not would be an unguarded endpoint. Nothing else on that hostname is served either, so a wrong spelling fails as a 404 rather than reaching a different route.

### 11.2 Auth

`/mcp` sits behind **its own Cloudflare Access application** on its own hostname (§6.5), validated against `ACCESS_MCP_AUD`. It uses the same `accessAuth` middleware as `/api/*`, parameterized with the application it is protecting, and the same `csrfProtection` guard for state-changing requests. Both guards live beside the route registration in `src/index.ts`, and the shared CSRF guard lives in `src/lib/http.ts`.

Clients authenticate with Access Managed OAuth, an authorization code flow with PKCE that a hosted client such as ChatGPT can complete on its own. Cloudflare issues the client an opaque access token, checks it at the edge, and passes the origin the same `Cf-Access-Jwt-Assertion` the Worker already verifies (§6.6). The MCP application has no Service Auth policy: a service token there would be a second credential that skips the account login and the MFA behind it, and it would be reusable by anything that read it out of a config file. The Worker refuses service-token assertions at `/mcp` independently of that policy (§6.6), so the boundary survives a policy added by hand. `docs/MCP-OAUTH-RUNBOOK.md` has the setup.

The CLI still talks only to the owner JSON API. Its OAuth grant comes from the owner application and carries `ACCESS_AUD`; MCP clients receive a different grant carrying `ACCESS_MCP_AUD`. CI may use the owner application's Service Auth policy. Revoking one application does not revoke the other's grants.

`/v/*` and `/raw/*` remain public on the owner hostname. They are not served on the MCP hostname at all, so a tool caller who somehow escaped the tool set still could not read a blob from the host it called. A share link still grants only read access to the current version of one document.

### 11.3 Tools

The nine tools use the CLI subcommand names from §10. Clients add their own namespace. For example, Claude Code exposes `push` as `mcp__poof__push`.

| Tool       | Input                                                                                     | Result                                                                |
| ---------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `cat`      | document id, optional version                                                             | The stored (rendered) HTML of that version, capped at 128 KiB (§11.4) |
| `ls`       | none                                                                                      | Documents, newest first, as `poof ls` shows them                      |
| `push`     | content, kind, optional title, document TTL, share flag + share TTL                       | New document: `/d/{id}` URL, plus a `/v/{token}` URL when shared      |
| `revoke`   | share token                                                                               | The share is dead on the next request                                 |
| `rm`       | document id                                                                               | Document, every version's blob, and all its shares deleted            |
| `rollback` | document id, version                                                                      | That version becomes current; no blob written                         |
| `share`    | document id, optional share TTL (`1h` / `1d` / `1w`)                                      | A `/v/{token}` URL                                                    |
| `update`   | document id, content, optional kind (default: the document's current one), optional title | New version, live immediately; same `/d/{id}` and same share links    |
| `versions` | document id                                                                               | Version history, newest first, with the current one marked            |

The tools follow the CLI semantics. Both use the same `md` and `html` kinds, 10 MiB cap, 1h/1d/1w share TTLs, 1-day default, and library/share URL model from §3.

Expected failures return **tool results, not exceptions**. An unknown id, expired document, or oversized input produces a one-sentence `isError` text block that tells the caller what to do next.

**The tools distinguish "no such document" from "no such version". The JSON API returns the same 404 for both (§9).** This does not weaken §6.3. Uniform errors protect the public `/raw` and `/v` routes, where the token grants access and probes must not distinguish missing, expired, or revoked tokens.

Tool calls have already passed Access (§11.2), and the owner can inspect the whole library with `ls`. The distinction tells an agent what to do next. "No live document with that id" points to `ls`, while "no version N of document X" points to `versions`. Missing and expired documents still share one message because both require the same response.

### 11.4 Where the tools differ from the CLI

**Content instead of a path.** The Worker cannot access the caller's filesystem, so MCP `push` and `update` accept document **content as a string**. They cannot infer `kind` from a file extension and instead accept `md` or `html`.

When MCP `push` omits `title`, it uses the server-side naming process from §8. Workers AI runs first, then the first `#` heading, then `untitled`. The API uses the same module but ends with the file name because it receives one. An omitted title on `update` keeps the current title (§9).

**Omitted `kind`.** The tools use the best available evidence. `push` has no file extension or document history, so it defaults to `md`. `update` inherits the document's current kind. An explicit `kind` can still switch a document between Markdown and HTML because §5 stores it per version. The CLI always has a file extension and needs no fallback.

Defaulting `update` to `md` would silently reinterpret HTML as Markdown when the caller omits `kind`. The resulting version would be valid and immediately visible through every share link (§3). Inheriting the current kind avoids that failure. The enum rejects misspelled values such as `markdown` or `txt` before the handler runs.

**Absolute URLs.** Tool results return full owner and share URLs, such as `https://poof.5n7.me/d/{id}`. The JSON API returns relative paths (§9), which the CLI joins to `POOF_URL`. MCP clients have no equivalent variable and often paste tool output directly into messages or comments.

They are built from `OWNER_HOST`, **not from the request origin**. The server answers on `mcp.poof.5n7.me`, which serves no `/d` or `/v` path (§6.5), so a URL built from the request would hand the model, and then the recipient it was passed to, a link that 404s. Only the scheme and any port come from the request, which keeps `wrangler dev` producing `http://localhost:8787` URLs.

**Bounded `cat` output.** The tool caps output at **128 KiB**. Smaller documents return unchanged. Larger ones return the beginning of the blob plus a notice with the total size and absolute owner-only `/d/{id}` URL.

`poof cat` and `GET /api/documents/:id/content` remain uncapped streams (§9). Writing a 10 MiB document to a file or terminal is reasonable, but placing it in a model's context is not. The limit therefore belongs in the MCP adapter, not the shared core (§11.5).

For `wrapViewerHtml` output, the beginning contains reader-visible content. Truncation usually drops the Mermaid and highlight.js loader at the end (§8). The adapter pulls the stream to the limit and then cancels it, so it never buffers the full oversized blob.

**Tool descriptions include the cautions.** The server's `instructions` block tells the model that `/d/{id}` is owner-only, `/v/{token}` is a secret, revisions use `update` on the existing id, updates and rollbacks affect every live share link immediately, and shared documents must contain no secrets. Individual tool descriptions repeat the warning relevant to that operation. In particular, `cat` returns rendered output rather than source and must not feed an `update`.

### 11.5 One core, two adapters

The tools and JSON API share one implementation of the rules. `src/lib/` contains document creation, version creation, rollback, and share creation. `src/routes/api.ts` adapts multipart input to JSON output. The MCP layer adapts tool arguments to text output. Keeping the version numbering from §5 and the three-phase write from §9 in one place prevents the two clients from drifting.

Limits live where their reason applies. The 10 MiB upload cap (§9) applies to every document and protects R2, so `src/lib/` enforces it. Both adapters check size first and return their native error form, either `413` from `/api` or `isError` from `/mcp`. The core exception protects future adapters that forget the check.

The 128 KiB `cat` cap (§11.4) protects a model's context rather than stored data. Only the MCP adapter enforces it.

The tools do not call the Worker's `/api/*` routes over HTTP. Doing so would add a second authenticated request to every tool call, and since §6.5 the API is not on the hostname the tools answer on, so the call would have to leave and come back through a different Access application. Direct function calls reuse the same code without either cost.

## 12. Main flows

1. **Upload (web, CLI, or MCP `push`)** → render if MD → insert `document` + version 1 rows → store blob in R2 → return URL.
2. **Library view** → `/` lists `ORDER BY created_at DESC` → `/d/{id}` embeds sandboxed iframe via minted `o_` token.
3. **Issue share** → insert `share` row → return `poof.5n7.me/v/{token}`.
4. **Shared view** → `/v/{token}` validates share (404 on any failure) → joins to the document's **current** version → sandboxed iframe → `/raw/s_{token}` → R2 blob.
5. **Revoke** → `revoked=1` → next request 404s immediately.
6. **Update** → `poof update {id} file.md` (or the `update` tool, or drop/⌘V on `/d/{id}`) → render → stage version `MAX+1` → put blob → move `current_version` → **every existing share link serves the new content on its next load** with the same token.
7. **Rollback** → `poof versions {id}` to pick a number (or the versions modal on `/d/{id}`) → `poof rollback {id} N` → one guarded `UPDATE` of the pointer, no blob written → live share links follow immediately, and a later update is numbered `MAX+1`, not `N+1`.

## 13. Future work (explicitly not now)

- **Physically separate serving origin** such as `poof-v.5n7.me` if third-party sharing grows. This would isolate cookies in addition to the CSP sandbox and require one extra Workers route.
- **Share-side auth** (passcode or Access allowlist) if unlisted+TTL stops being enough.
- **Per-share version pinning.** A share could keep serving the version against which it was issued. The schema can support this with a nullable `share.version`, but it conflicts with §3's rule that an existing link shows fixes. A pinned share could silently diverge from the document.
- **Retain source blobs** beside rendered blobs. This would allow `poof cat --source {id} > report.md`, local editing, and `poof update`. Today §8 stores only rendered HTML, so CLI and MCP `cat` cannot recover Markdown (§11.4). The change would add an R2 object per version and a schema column. It can wait until server-side source editing is needed.
- **Version diffs** in the owner UI (v2 vs v3). Needs a diff renderer and a second read path, and so far reading the two versions side by side has been enough.
- **KV read-through cache** for the public path (§5).

## 14. Cost

The expected service cost is $0 per month. All components fit their free tiers, and R2 egress is free. The domain costs about $10 per year and is already owned.

Workers AI is the only metered addition. Auto-naming uses about 3 to 5 neurons for an untitled Markdown document. The prompt contains at most about 2000 characters, and output is capped at 32 tokens on the smallest text model. The free allowance is 10,000 neurons per day. Inference runs only for a document pasted into the web UI or an MCP `push` without `title`. CLI `poof push` resolves and sends its title locally.

## 15. Decision summary

| Item              | Decision                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Share model       | Unlisted URL + TTL; `share` as its own entity; revocation in initial scope                                                                                                                                                                                                                   |
| Versioning        | Document = stable identity + ordered immutable versions; `document_version` is the only source of truth for blobs; `current_version` is a pointer, next = `MAX+1`                                                                                                                            |
| Share on update   | Shares **follow the current version**. An update reaches every live link without reissuing it. Per-share pinning is out of scope (§13).                                                                                                                                                      |
| Rollback          | `POST …/versions/:version/rollback`; pointer move only, no blob copied; already-current is an idempotent no-op                                                                                                                                                                               |
| Version viewing   | Owner-only: `/d/{id}?v=N` (read-only, behind Access) via an `o_` token with the version **inside the signed payload**; `/raw` never accepts a `v` query param                                                                                                                                |
| Security boundary | **CSP `sandbox allow-scripts allow-popups` response header** on `/raw/*`, plus the iframe `sandbox` attribute. Never add `allow-same-origin`.                                                                                                                                                |
| Delivery path     | Single public `/raw/{token}` endpoint; `s_` share tokens (D1) + `o_` owner tokens (HMAC, ~10 min)                                                                                                                                                                                            |
| Sanitization      | None; all docs treated as untrusted blobs, sandbox is the boundary                                                                                                                                                                                                                           |
| Rendering         | Write-time `markdown-it` in the Worker; Mermaid + highlight.js lazily loaded client-side inside the sandbox                                                                                                                                                                                  |
| Titling           | Create-only when `title` is absent: Workers AI → first `#` heading → client fallback. `/api` uses the file name, and MCP `push` uses `untitled`. It runs synchronously because rendering writes the title into the blob. Failures use the next fallback.                                     |
| Errors            | Uniform 404 for missing/expired/revoked                                                                                                                                                                                                                                                      |
| Tokens            | `crypto.getRandomValues`, 128-bit, base64url                                                                                                                                                                                                                                                 |
| Host isolation    | One Worker, two hostnames dispatched before routing: `poof.5n7.me` serves the web, API, and public paths; `mcp.poof.5n7.me` serves `POST /mcp` and nothing else. Any other host gets 404. Blank or duplicated host vars answer 503 (§6.5).                                                   |
| MCP server        | Worker-hosted at `POST mcp.poof.5n7.me/mcp` with Streamable HTTP (`@hono/mcp`). It creates a server per request and issues no session id because isolates are not sticky. The path is exact; other methods return `405` with `Allow: POST` and the server offers no SSE stream.              |
| MCP auth          | Its own Access application and AUD tag, authenticated with Managed OAuth (authorization code + PKCE) and **no Service Auth policy**, enforced again in-Worker by refusing service-token assertions, plus the shared CSRF guard.                                                              |
| MCP tools         | Nine, named after the CLI subcommands; `push`/`update` take content, not a file path; an omitted `kind` means `md` on `push` and the document's current kind on `update`; `cat` capped at 128 KiB; results carry absolute `OWNER_HOST` URLs; one shared core in `src/lib/`, two adapters     |
| Auth              | Cloudflare Access on both hostnames, each validated against its own AUD; separate Managed OAuth grants for the interactive CLI and MCP clients, optional owner-app service token for CI, bypass on `poof.5n7.me/v/*` `/raw/*`                                                                |
| JWT verification  | `Cf-Access-Jwt-Assertion` only, RS256 against the team JWKS, pinned `iss`, route-specific `aud`, and required `exp` / `iat` / `sub` / `type: "app"`. `nbf` is checked when present but never required. `/mcp` additionally requires an identity assertion and refuses service tokens (§6.6). |
| Infra / stack     | Cloudflare Workers + R2 + D1 + Access; TypeScript + Hono + wrangler + vitest-pool-workers                                                                                                                                                                                                    |
| Provisioning      | Idempotent `scripts/bootstrap.sh` + `docs/SETUP.md` + `docs/MCP-OAUTH-RUNBOOK.md`; no Terraform until environments multiply; `workers_dev` disabled; Access JWT verified in-Worker                                                                                                           |
| TTL defaults      | Library: none; shares: 1 day (1h/1d/1w selectable)                                                                                                                                                                                                                                           |
| Headers           | `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on viewer/raw paths                                                                                                                                                                                                                  |
