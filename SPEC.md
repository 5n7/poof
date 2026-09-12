# poof ephemeral document viewer and sharing tool

_Spec v0.7 adds mixed file sets within one document. Uploads merge by path, file tabs and relative links share one viewer, and versions capture the entire set._

> Throw in a document, view the rendered result, and share it until the link expires. poof runs at `poof.5n7.me` on Cloudflare, with its MCP endpoint at `mcp.poof.5n7.me`.

---

## 1. Purpose

View AI-generated Markdown and HTML design documents or memos in a browser. Most are temporary. Some need a link that works for specific people for a limited time. This is a personal tool designed to stay small and within free service tiers.

## 2. Scope

### In scope

- Upload related files into one document, preserving original bytes and relative paths; browse mixed formats in file tabs
- Personal library (list view, authenticated, owner-only)
- Per-document disposable share links (unlisted URL + TTL), with manual revocation
- **In-place document update**: merge uploaded paths and explicitly delete files while keeping the same `/d/{id}` and the same already-issued share links
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

### Files and versions

The canonical terms are in [CONTEXT.md](CONTEXT.md). A document contains an ordered
set of files. Each file has a unique relative path, original bytes, and its own
kind and media type. The first file opens by default. Existing paths retain their
position on update; new paths append in upload order. Renaming uses an upload at
the new path and an explicit deletion of the old path in the same update.

A version captures the complete file set. Uploading `adr/001.md` changes
that path and retains `overview.md` and `adr/002.md`. Deletions are explicit.
Rollback restores the entire file set and keeps the current document title.
The title changes through an explicit rename or a title supplied in an update. Each version also
records its title at upload time for historical rendering. A share grants access to all files in the
current version, so adding a file makes it available through existing shares.

A document retains between 1 and 100 files. One upload may contain at most 10 MiB
of decoded source bytes across its files. Paths use `/` separators, are at most
512 UTF-8 bytes, and reject absolute paths, empty or dot segments, backslashes,
control characters, `%`, `?`, `#`, and URL scheme prefixes. Matching is case-sensitive.

The original single-file protocol remains supported. An update without explicit
paths replaces the sole file, including its name. On an existing multi-file
document, that protocol merges by filename, or updates the first file when no
filename is supplied. Explicit paths always use merge semantics.

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

- **Hono** on Workers; admin UI is server-rendered Hono JSX + minimal vanilla JS (no frontend framework)
- **TypeScript** everywhere (Worker, admin UI, CLI) in a single repo
- **Vitest + `@cloudflare/vitest-pool-workers`** for tests
- **wrangler** for deploys and D1 migrations

### Repository layout

```
poof/
  cli/            # poof CLI (TypeScript)
  docs/           # SETUP.md (Access, secrets, domain) + MCP-OAUTH-RUNBOOK.md
  migrations/     # D1 migrations
  scripts/        # bootstrap.sh, idempotent resource creation (D1, R2)
  src/            # Worker (Hono app, render pipeline, auth, cron)
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
  updated_at      INTEGER NOT NULL,  -- last version added, rollback, or title change
  current_version INTEGER NOT NULL,  -- pointer into document_version
  expires_at      INTEGER            -- optional owner TTL; NULL = keep forever
);
```

Migration `0002` moved content metadata to `document_version`. Migration `0004` adds an ordered `document_file` manifest for each version. Version rows retain first-file metadata for existing callers. `document` has no blob reference; readers resolve its version and then the selected file.

### `document_version`

```sql
CREATE TABLE document_version (
  document_id TEXT    NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,      -- 1-based, allocated MAX(version)+1
  kind        TEXT    NOT NULL,      -- 'file' | 'html' | 'md' | 'text'
  r2_key      TEXT    NOT NULL,      -- original source blob in R2
  filename    TEXT,
  media_type  TEXT NOT NULL,
  title       TEXT,                 -- title captured for this version
  created_at  INTEGER NOT NULL,
  ready       INTEGER NOT NULL DEFAULT 1, -- set only after every uploaded blob exists
  PRIMARY KEY (document_id, version)
);

-- The weekly orphan sweep probes `r2_key IN (...)` once per R2 listing page;
-- without this index each page is a full table scan.
CREATE INDEX idx_document_version_r2_key ON document_version(r2_key);
```

### `document_file`

```sql
CREATE TABLE document_file (
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL,
  filename TEXT,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (document_id, version, path),
  FOREIGN KEY (document_id, version)
    REFERENCES document_version(document_id, version) ON DELETE CASCADE
);
CREATE INDEX idx_document_file_r2_key ON document_file(r2_key);
```

Migration `0004` backfills one file per existing version without rewriting R2.
Unchanged files reuse their original blobs across snapshots. New uploads get
unique version-scoped keys. The file manifest is authoritative for blob
references. Cleanup deduplicates its keys before deleting a document's blobs.
For an existing deployment, follow the controlled migration rollout in
[docs/SETUP.md](docs/SETUP.md#upgrading-to-multi-file-documents) so uploads and
old scheduled cleanup stay paused until the new Worker is active.

The code enforces three rules that the schema cannot express:

1. **`current_version` is a pointer, not a maximum.** After a rollback it trails `MAX(version)`. New versions therefore use `MAX(version) + 1`, never `current_version + 1`. Using the pointer would collide with recorded history after a rollback. The composite primary key turns that collision into an error, and the writer retries with a fresh number. Every document has at least one version. An `EXISTS` clause on the pointer update ensures that `current_version` names a real row.
2. **R2 keys are read, never derived.** New versions, including version 1 of a new document, use a unique source key recorded in the version row. Version 1 rows created before versioning retain the flat `doc/{id}.html` key. The migration backfilled these rows without copying or rewriting objects. The cron's `doc/` prefix covers both key shapes. They cannot collide because one has `.html` directly after the id and the other has `/`.
3. **Rollback moves the pointer and copies nothing.** A restored version keeps its original row and blob, so the history stays a faithful record of what was actually uploaded and unchanged files may share an `r2_key` across snapshots.

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
| `o_`   | Owner view token | Stateless HMAC-signed payload `{document_id, exp, version?}`, TTL ~10 min, secret via `wrangler secret` | Private library viewer `/d/{id}` |
| `s_`   | Share token      | `share` row in D1 (checks `expires_at`, `revoked`); resolves to the **current** version                 | Public shared view `/v/{token}`  |

The Access-protected library page mints an `o_` token when it renders the viewer. Owner views and public shares then use **the same endpoint and headers** without relying on cookies.

**Version pinning lives inside the signed payload, never in a query parameter.** The token authorizes access to `/raw/*`, so accepting `?v=N` would let a share holder enumerate the edit history. Only `/d/{id}?v=N`, which sits behind Access, can mint a pinned token. The pin expires with the token after about 10 minutes.

- An `o_` token pointing at the current version **omits `v` entirely**, so ordinary tokens stay byte-identical to the pre-versioning format and tokens minted before the change keep verifying.
- `s_` tokens have no version field at all: there is structurally no way to ask a share for anything but the current version.

The HMAC authenticates the payload but does not replace validation. After the HMAC check, the Worker rejects a `v` that is not a positive integer, including `0`, `-1`, `1.5`, or `"2"`.

### 6.3 Error responses

Nonexistent, expired, and revoked tokens all return the **same status (404)** with an identical body, so a probe cannot distinguish "never existed" from "existed and expired".

### 6.4 No sanitization

HTML uploads run arbitrary JavaScript by design. Sanitizing only Markdown-derived HTML would create inconsistent behavior without improving the security boundary. **The system treats rendered documents as untrusted and relies on the CSP sandbox.** It has no sanitizer dependency.

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
| `exp`  | present, in the future                       | `hono/jwt` checks expiry only when the claim is present, so a token with no `exp` would never expire |
| `iat`  | present, not in the future                   | Same reason                                                                                          |
| `iss`  | exactly `https://{ACCESS_TEAM_DOMAIN}`       | A token from another Cloudflare team cannot be replayed here                                         |
| `sub`  | present                                      | Both documented assertion payloads include this claim                                                |
| `type` | `"app"`                                      | Cloudflare also issues `"org"` global session tokens, signed by the same team key                    |

The set is the intersection of the two payloads Cloudflare documents, the identity login and the service token, and it applies on both hostnames. `nbf` is not required, because only the identity payload carries one and requiring it would reject every service token; it is still enforced on tokens that do carry it. `sub` must be present, because both payloads document it, but its value is only read below.

The owner routes take either documented assertion. Interactive browser and CLI OAuth logins produce identity assertions, while CI produces a service-token assertion. `POST /mcp` takes an identity assertion only:

| Claim         | MCP requirement                                   |
| ------------- | ------------------------------------------------- |
| `common_name` | absent (it is the service token's Client ID)      |
| `email`       | present and non-empty (service tokens have none)  |
| `sub`         | present and non-empty (a service token's is `""`) |

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

- The sweep checks `document_file.r2_key`, including past snapshots and staged uploads. It reads and deduplicates all keys before deleting a document because the foreign-key cascade removes its version and file rows.
- **`src/lib/batch.ts`** chunks the larger delete and sweep operations. D1 accepts at most 100 bound parameters per statement. An R2 listing page can contain 1000 keys, and `delete()` accepts at most 1000 keys per call.

## 8. Source storage and rendering

Each version records an ordered file manifest. Every uploaded file stores its
original source object in R2, preserving binary bytes, byte-order marks, and
line endings. Each manifest entry records its path, filename, media type, and
display kind. Unchanged files reuse stored objects.

```
[Upload / update]
  any file → store original bytes in R2

[View]
  Markdown → markdown-it → viewer template
  HTML → serve original markup inside the sandbox
  text → escaped preformatted viewer
  supported media → browser preview
  PDF and other files without previews → file details and a download link

[cat]
  Markdown / text → original source
  HTML → readable Markdown without scripts or styles
  binary → metadata and a download command or URL
  format=raw → original stored bytes
```

- Markdown supports CommonMark, tables, strikethrough, Mermaid fences, and code
  highlighting. The viewer loads Mermaid and highlight.js only when needed.
- HTML extraction preserves headings, links, lists, tables, and code while
  omitting document wrappers and non-content scripts/styles. It parses HTML
  without executing it or fetching linked resources.
- Every version carries its own display and source metadata. Updates can change
  file types, and rollback restores the selected version without copying blobs.
- Rendering happens on reads. Large Markdown or HTML documents can use more
  Worker CPU than the previous pre-rendered storage model.

Remove every previously stored Markdown version and its blob before rollout.
Those versions contain rendered HTML, and this implementation expects Markdown
source. Preserve HTML versions and restore a remaining version if the current
version was removed. Delete a document and its shares only when no versions remain.
This is a one-time cleanup outside the schema migration.

Automatic titling lives in `src/lib/title.ts` and runs synchronously for untitled
Markdown uploads before storing the new version. Other file types use the file
name as their fallback title.

The naming process runs only when `title` is absent or blank. A supplied title is used verbatim. `POST /api/documents` uses this fallback order for a single Markdown file; multiple-file API uploads use the first filename. MCP `push` applies the fallback order to its first Markdown file:

1. Workers AI
2. The document's first `#` heading
3. A client-specific fallback

The API uses the uploaded file name as its final fallback. MCP uses the supplied filename or file path, falling back to `untitled` for content without metadata. `resolveNewTitle` validates the final fallback too, which prevents an empty title when multipart data contains `filename=""`. A missing binding, timeout, retired model, or rejected response moves to the next fallback instead of failing the upload.

The model is `@cf/ibm-granite/granite-4.0-h-micro`, and the prompt requests one line. Code chooses the response language. When kana exceed a threshold in the excerpt, the prompt explicitly requests Japanese and includes a Japanese example. This rule exists because the 3B model returned English titles for two of three Japanese documents in production. English excerpts keep the general instruction to match the document language.

The parser takes the first non-empty line and removes `Title:` labels, Markdown markers and links, wrapping quotes, and trailing `.`, `。`, or `!`. It rejects the result instead of truncating it when any of these conditions apply:

- It exceeds 80 code points.
- It reads as a preamble.
- It opens a `<think>` block without closing it. With a 32-token output limit, a reasoning model may stop mid-scratchpad.
- It contains no letter or number.

The parser preserves a trailing `?` and the ideographic space U+3000. It removes invisible format characters because `U+202E`, for example, can reverse the displayed direction of the rest of a library row. ZWNJ and ZWJ remain because they carry meaning in Persian, Devanagari, and emoji sequences.

HTML and other non-Markdown uploads skip Workers AI and fall back to the filename. For untitled Markdown, the Worker sends the first 2000 characters to Workers AI within Cloudflare. The `<document>` delimiter reduces prompt injection ambiguity but is not a security boundary. A document can influence its own title, which is safe because the renderer HTML-escapes the title and D1 stores it in a `TEXT` column.

### Renaming existing documents

A document's title is editable metadata. Rename changes `document.title` and
`updated_at` without uploading a version, changing stored files, or replacing
URLs. The current owner and share viewers show the new title; historical
versions retain their recorded titles. Saving the current title is a no-op and
preserves `updated_at`. A saved title has 1 to 200 Unicode code points.
Whitespace collapses to single spaces, with leading and trailing whitespace
removed. Hidden control characters and invalid Unicode are rejected.

The library's Rename dialog lets the owner edit the title directly or request
an AI suggestion. A suggestion fills the editable field and saves nothing.
Saving is a separate action. AI failure leaves the draft available for manual
editing and reports the failure instead of silently choosing a fallback.

Suggestions read up to 8 readable files in the current version, at most 64 KiB
of source per file. The model receives up to 2000 characters including file
paths as context. Markdown and text use preserved source; HTML uses the
existing readable-content conversion. Binary contents are excluded. Empty or
unreadable documents have no suggestion, but can still be renamed manually.
Automatic naming on upload retains its existing fallback behavior above.

Both suggestion and rename take an opaque `expected_state` token from the
snapshot the caller reviewed. The token is a SHA-256 digest of the document
id, current version, and exact title. Clients copy it without reconstructing
it from display text. Its fixed size also allows shortening legacy long titles.
The service checks that the document is live and unchanged. It rechecks after
inference, and rename uses a guarded update. A stale snapshot returns 409 without overwriting another title or
applying a candidate to changed content.

## 9. HTTP routes

Every route below is on `poof.5n7.me` except `POST /mcp`, which is on `mcp.poof.5n7.me` and is the only path that hostname serves (§6.5). Each hostname has its own Access application, so "Access" in the table means a different audience for the two.

| Route                                                | Auth                         | Purpose                                                                  |
| ---------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `GET /`                                              | Access                       | Library list (newest first), upload UI                                   |
| `GET /api/documents`                                 | Access                       | List documents (incl. `current_version`, `updated_at`; no `r2_key`)      |
| `POST /api/documents`                                | Access (incl. service token) | Upload repeated file/path fields + optional title/TTL; creates version 1 |
| `GET /api/documents/:id`                             | Access                       | Current title and version snapshot for rename                            |
| `DELETE /api/documents/:id`                          | Access                       | Delete document (+every version's blob, cascades shares)                 |
| `GET /api/documents/:id/content`                     | Access                       | Readable content; `?format=raw` returns source; `?v=N` pins a version    |
| `GET /api/documents/:id/files`                       | Access                       | Ordered file metadata without R2 keys; optional `?v=N` pins a version    |
| `GET /api/documents/:id/shares`                      | Access                       | List active shares for a document                                        |
| `POST /api/documents/:id/shares`                     | Access                       | Issue share (TTL param) → returns `/v/{token}` URL                       |
| `PATCH /api/documents/:id/title`                     | Access                       | Save a title against the reviewed title and version                      |
| `POST /api/documents/:id/title-suggestion`           | Access                       | Generate an AI candidate without changing the document                   |
| `GET /api/documents/:id/versions`                    | Access                       | List versions (newest first) + `current_version`; no `r2_key`            |
| `POST /api/documents/:id/versions`                   | Access (incl. service token) | Merge repeated file/path fields, optional delete paths and title         |
| `POST /api/documents/:id/versions/:version/rollback` | Access                       | Point the document at an existing version                                |
| `DELETE /api/shares/:token`                          | Access                       | Revoke (`revoked=1`, immediate)                                          |
| `GET /d/:id`                                         | Access                       | Private viewer page (mints `o_` token, embeds iframe)                    |
| `GET /d/:id?v=N`                                     | Access                       | Read-only view of version N (banner, no Share, no uploader)              |
| `GET /guide`                                         | Access                       | Owner guide page                                                         |
| `POST /mcp`                                          | Access, MCP application      | MCP server (Streamable HTTP): twelve tools over the same core (§11)      |
| `GET /raw/:token`                                    | none (token is the auth)     | Rendered content with sandbox headers; `?format=raw` downloads source    |
| `GET /raw/:token/*`                                  | none (token is the auth)     | Linked file or asset with the same sandbox headers                       |
| `GET /v/:token`                                      | none                         | Public shared viewer page; **always the current version**                |

Weekly Cron cleanup is described in §7.

Version routes follow these rules:

- Multipart uploads use repeated `file` fields with aligned repeated `path` fields. Each path defaults to the corresponding `File.name` when omitted. Updates accept repeated `delete` fields, including a deletion-only request. A request cannot upload and delete the same path. Invalid paths and duplicate paths return 400, oversized uploads return 413, and concurrent updates may return 409 for retry.
- `GET /api/documents/:id/files?v=N` returns ordered file metadata without R2 keys. Omit `v` for the current version. `GET …/content?file=adr/001.md` selects one file and combines with `v` and `format=raw`; the first file is the default.
- Owner viewers accept `/d/{id}?file=path&v=N`. Shared viewers accept `/v/{token}?file=path` for the current version. Both use tabs to switch files without changing the document or share identity. HTML and Markdown relative links resolve within the selected version. `/raw/{token}/{path}` validates the same token for linked files and assets; it never accepts a version query. Selecting a missing path returns 404.
- A document must be **live**, not merely present, to create or list versions. Both requests return 404 for an owner-expired document, as does `POST …/shares`.
- Plain file links, including fragments, select the matching outer tab. Links with a query string navigate within the sandboxed iframe so HTML query parameters and `?format=raw` keep their meaning; these links do not synchronize the outer tab selection. External URLs and external `<base>` URLs retain native browser behavior.
- Writes have three phases. The Worker stages the version and complete file manifest, uploads every new blob, and atomically publishes the current pointer and readiness flag in one guarded transaction. Reads and rollback reject unready versions. Readers see a complete old or new snapshot; an interrupted or conflicting write does not publish a partial file set.
- Rollback uses the `…/versions/:version/rollback` path instead of a `PATCH` to `current_version`. The route verifies that the target exists and matches the verb used by the CLI and UI. A malformed `:version` returns `400 {error:"invalid version"}`. A valid but unknown version returns the standard 404. Rolling back to the live version is an idempotent no-op and does not change `updated_at`.
- `GET …/content` reads its version pin from `?v=N`, while `/raw` rejects that parameter (§6.2). A token authorizes `/raw`, so accepting a version in the URL would let share holders enumerate history. Access authorizes `…/content`, and its URL grants no additional access. A malformed `v` returns `400 {error:"invalid version"}`, and an unknown version returns the standard 404.
- `GET …/content` sends `text/plain; charset=utf-8`, `nosniff`, and a bare `sandbox` CSP. It returns source text or extracted Markdown. With `?format=raw`, it sends `application/octet-stream` and an attachment filename so arbitrary source bytes cannot execute on the owner origin (§6.1).
- `/d/{id}?v=N` is a page rather than an API, so a malformed `v` returns the standard 404 instead of 400. If `v` names the live version, the request uses the normal viewer instead of a read-only view.
- `GET /api/documents/:id` returns `{id,title,current_version,updated_at,state}` for a live document. `POST …/title-suggestion` takes `{expected_state}` and returns `{title,expected_state}` without saving. `PATCH …/title` takes `{title,expected_state}` and returns the updated metadata snapshot. Both reject malformed input with 400, missing or expired documents with the standard 404, and stale snapshots with 409. Suggestion returns 422 when no readable content is available and 503 when AI cannot provide a title.
- **Auto-naming applies only to creation.** On `POST /api/documents`, an absent `title` follows the single-file or multiple-file naming rule from §8. A supplied title is used verbatim. On `POST …/versions`, an absent `title` keeps the current title. Updates must not silently rename the document or change the recipient page's `<title>`. MCP `push` and `update` follow the same rule (§11.4).

**Cloudflare Access configuration.** Two applications, one per hostname (§6.5). The `poof.5n7.me` application allows the owner's exact email through the Cloudflare identity provider, enables Managed OAuth for the CLI, and keeps a Service Auth policy only for CI. The `mcp.poof.5n7.me` application allows the same owner identity and has **no Service Auth policy**. A service token there would skip the account login. Bypass applications cover only `poof.5n7.me/v/*` and `poof.5n7.me/raw/*`. `docs/SETUP.md` and `docs/MCP-OAUTH-RUNBOOK.md` have the configuration.

Viewer pages (`/d/*`, `/v/*`) also send `Referrer-Policy: no-referrer` so links inside documents can't leak token URLs via `Referer`.

## 10. CLI

The CLI is the usual path from AI output to a share link. It is written in TypeScript, lives in `cli/`, and runs through `npx`, `bunx`, or a compiled binary.

```
poof auth login [--new-client] [--no-open]
poof auth logout
poof cat <doc-id> [--file <path>] [--version <n>]
                                # print source text or readable Markdown extracted from HTML
poof cat <doc-id> --raw          # original bytes, suitable for redirecting to a file
poof files <doc-id> [--version <n>] # file paths and types
poof ls                         # list documents
poof push <file-or-directory>... [--root <directory>] [--share [--share-ttl 1d]] [--title <t>] [--ttl <dur>]
                                # upload; prints /d/{id} URL; --share also prints /v/{token}
poof rename <doc-id> --title <t> [--expected-state <token>]
poof revoke <share-token>
poof rm <doc-id>
poof rollback <doc-id> <version>
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof status
poof suggest-title <doc-id>    # JSON candidate and preconditions; does not save
poof update <doc-id> [<file-or-directory>...] [--delete <path>]... [--root <directory>] [--title <t>]
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
- `auth login` discovers OAuth from the protected owner root's `401` challenge, follows RFC 9728
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
- `auth logout` attempts RFC 7009 refresh-token revocation, then deletes local tokens
  even when revocation fails. A remote failure returns nonzero and says that the
  local credential is gone. `status` checks the selected credential against the
  live owner API without opening a browser. If a service pair remains in the
  environment, `auth login` and `auth logout` say that service authentication still wins.
- The CLI only talks to the JSON API; rendering stays server-side (see §8 fallback if that changes).
- Uploads accept mixed extensions and preserve bytes. A single directory stores paths below that directory. Multiple inputs use their common parent; `--root` overrides the root and should be reused for later nested-file updates. Directories traverse sorted names without following symbolic link entries. Explicit file arguments retain their supplied order. The server infers each file's display kind from its filename, media type, and bytes.
- **Rename.** `rename` changes only document metadata and prints the resulting JSON snapshot. Without `--expected-state` it first reads current metadata. Pass the token from `suggest-title` when applying a reviewed candidate. Neither command retries a conflict or applies a generated title automatically.
- **Title.** `push` uses the first Markdown `# heading`, then the file name. `update` keeps the existing title unless the caller passes `--title`. The CLI always resolves and sends a title for `push`, so the server's naming process (§8) does not run. That process handles documents pasted into the web UI and MCP `push` calls without a title (§11.4).
- `ls` columns are `ID TITLE KIND VER UPDATED EXPIRES`. `VER` is `current_version`. `UPDATED` replaces the old `CREATED` to keep six columns. For an unchanged document, `updated_at === created_at`. `poof versions` shows the original creation time in version 1's `created_at`.
- `rollback` validates the version number locally before spending a round-trip, and prints `rolled back {id} to v{n}`.
- `cat` prints original Markdown/text or readable Markdown extracted from HTML. Binary files return metadata and a raw-download command. Use `--raw` for exact stored bytes, including HTML and binary downloads. The CLI validates `--version` locally, combines it with `--raw`, and streams stdout without a trailing newline.
- `update --delete` requires a non-empty path and rejects missing values before making any request. Use `--delete=-draft.md` for names beginning with a dash. Repeated deletion options remain supported; `--` ends option parsing.
- The API serves normal `cat` output as inert `text/plain`; raw downloads use `application/octet-stream` with attachment headers.

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

The twelve tools use the CLI subcommand names from §10, with `suggest_title` using an underscore. Clients add their own namespace. For example, Claude Code exposes `push` as `mcp__poof__push`.

| Tool            | Input                                                                       | Result                                                                     |
| --------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `cat`           | document id, optional file path and version                                 | Readable content, capped at 128 KiB after conversion; optional raw (§11.4) |
| `files`         | document id, optional version                                               | Ordered file paths, kinds, and media types                                 |
| `ls`            | none                                                                        | Documents, newest first, with a STATE token for rename                     |
| `push`          | files or content, optional kind/title, document TTL, share flag + share TTL | New document: `/d/{id}` URL, plus a `/v/{token}` URL when shared           |
| `rename`        | document id, title, expected state token                                    | Change only the document title; return JSON metadata                       |
| `revoke`        | share token                                                                 | The share is dead on the next request                                      |
| `rm`            | document id                                                                 | Document, every version's blob, and all its shares deleted                 |
| `rollback`      | document id, version                                                        | That version becomes current; no blob written                              |
| `share`         | document id, optional share TTL (`1h` / `1d` / `1w`)                        | A `/v/{token}` URL                                                         |
| `suggest_title` | document id                                                                 | JSON title candidate and preconditions; no document change                 |
| `update`        | document id, files or content, optional delete_paths, kind, title           | New version, live immediately; same `/d/{id}` and same share links         |
| `versions`      | document id                                                                 | Version history, newest first, with the current one marked                 |

`rename` requires `expected_state` from the `STATE` column of `ls` or from `suggest_title`. The suggestion tool reads its own current snapshot and returns the token with the candidate. Display formatting can alter title whitespace or joiners, so callers must copy the token rather than derive a precondition from the displayed title. Both return expected failures as tool errors.

The tools follow the CLI semantics. Both support `file`, `html`, `md`, and `text` kinds, 10 MiB cap, 1h/1d/1w share TTLs, 1-day default, and library/share URL model from §3.

Expected failures return **tool results, not exceptions**. An unknown id, expired document, or oversized input produces a one-sentence `isError` text block that tells the caller what to do next.

**The tools distinguish "no such document" from "no such version". The JSON API returns the same 404 for both (§9).** This does not weaken §6.3. Uniform errors protect the public `/raw` and `/v` routes, where the token grants access and probes must not distinguish missing, expired, or revoked tokens.

Tool calls have already passed Access (§11.2), and the owner can inspect the whole library with `ls`. The distinction tells an agent what to do next. "No live document with that id" points to `ls`, while "no version N of document X" points to `versions`. Missing and expired documents still share one message because both require the same response.

### 11.4 Where the tools differ from the CLI

**Files or single content.** MCP `push` and `update` accept `files: [{path, content, encoding?, kind?, filename?, media_type?}]`. Each entry supplies its own relative path and bytes. `update` accepts `delete_paths` and retains files omitted from the upload. `files` lists paths for `cat`'s optional `file` argument. Calls with both top-level `content` and `files` are rejected. The original single-file protocol accepts a `content` string. Text uses the default `encoding: "utf8"`; binary files use `encoding: "base64"`. Invalid base64 is rejected, and the upload cap counts decoded bytes. Optional `filename` and `media_type` fields supply file metadata.

An explicit `kind` chooses `file`, `html`, `md`, or `text`. Otherwise supplied metadata determines the kind. Without metadata, `push` defaults to `md` for text or `file` for base64; `update` keeps the current kind. Untitled Markdown uses the naming process in §8, ending with the filename or `untitled`. Other kinds use the filename or `untitled` directly. An omitted update title preserves the current title.

**Absolute URLs.** Tool results return full owner and share URLs, such as `https://poof.5n7.me/d/{id}`. The JSON API returns relative paths (§9), which the CLI joins to `POOF_URL`. MCP clients have no equivalent variable and often paste tool output directly into messages or comments.

They are built from `OWNER_HOST`, **not from the request origin**. The server answers on `mcp.poof.5n7.me`, which serves no `/d` or `/v` path (§6.5), so a URL built from the request would hand the model, and then the recipient it was passed to, a link that 404s. Only the scheme and any port come from the request, which keeps `wrangler dev` producing `http://localhost:8787` URLs.

**Bounded `cat` output.** The tool converts HTML to readable Markdown, then caps text at **128 KiB** of UTF-8. Smaller results return in full. Larger ones return the beginning of the text plus a notice with the input size, output limit, and absolute owner-only `/d/{id}` URL.

`poof cat` and `GET /api/documents/:id/content` remain uncapped streams (§9). Writing a 10 MiB document to a file or terminal is reasonable, but placing it in a model's context is not. The limit therefore belongs in the MCP adapter, not the shared core (§11.5).

The cap counts emitted UTF-8 bytes after decoding, including replacement characters for invalid input, and avoids splitting a character. HTML parsing reads the full source before conversion, so styles cannot consume the output budget and hide the document body. `raw: true` returns original text/HTML under the same cap. Binary files always return metadata and an owner-only raw download URL instead of binary content.

**Agent instructions.** The server's `instructions` and tool descriptions make uploads owner-only by default. Return `/d/{id}` for ordinary uploads; create a public `/v/{token}` link only when the user explicitly requests sharing. Revisions use `update` on the existing id; updates and rollbacks immediately affect all live shares. Treat share URLs as secrets and keep secrets out of shared content. For HTML edits, `cat` with `raw: true` retrieves source markup; default `cat` output is a readable extraction.

### 11.5 One core, two adapters

The tools and JSON API share one implementation of the rules. `src/lib/` contains document creation, version creation, title suggestion and rename, rollback, and share creation. `src/routes/api.ts` adapts multipart input to JSON output. The MCP layer adapts tool arguments to text output. Keeping the version numbering from §5 and the three-phase write from §9 in one place prevents the two clients from drifting.

Limits live where their reason applies. The 10 MiB upload cap (§9) applies to the sum of decoded file bytes in each upload and protects R2, so `src/lib/` enforces it. Both adapters check size first and return their native error form, either `413` from `/api` or `isError` from `/mcp`. The core exception protects future adapters that forget the check.

The 128 KiB `cat` cap (§11.4) protects a model's context rather than stored data. Only the MCP adapter enforces it.

The tools do not call the Worker's `/api/*` routes over HTTP. Doing so would add a second authenticated request to every tool call, and since §6.5 the API is not on the hostname the tools answer on, so the call would have to leave and come back through a different Access application. Direct function calls reuse the same code without either cost.

## 12. Main flows

1. **Upload (web, CLI, or MCP `push`)** → preserve source → insert `document` + version 1 rows → store blob in R2 → return URL.
2. **Library view** → `/` lists `ORDER BY created_at DESC` → `/d/{id}` embeds sandboxed iframe via minted `o_` token.
3. **Issue share** → insert `share` row → return `poof.5n7.me/v/{token}`.
4. **Shared view** → `/v/{token}` validates share (404 on any failure) → joins to the document's **current** version → sandboxed iframe → `/raw/s_{token}` → R2 blob.
5. **Revoke** → `revoked=1` → next request 404s immediately.
6. **Update** → `poof update {id} file.md` (or the `update` tool, or drop/⌘V on `/d/{id}`) → stage version `MAX+1` → put blob → move `current_version` → **every existing share link serves the new content on its next load** with the same token.
7. **Rollback** → `poof versions {id}` to pick a number (or the versions modal on `/d/{id}`) → `poof rollback {id} N` → one guarded `UPDATE` of the pointer, no blob written → live share links follow immediately, and a later update is numbered `MAX+1`, not `N+1`.

## 13. Future work (explicitly not now)

- **Physically separate serving origin** such as `poof-v.5n7.me` if third-party sharing grows. This would isolate cookies in addition to the CSP sandbox and require one extra Workers route.
- **Share-side auth** (passcode or Access allowlist) if unlisted+TTL stops being enough.
- **Per-share version pinning.** A share could keep serving the version against which it was issued. The schema can support this with a nullable `share.version`, but it conflicts with §3's rule that an existing link shows fixes. A pinned share could silently diverge from the document.
- **Version diffs** in the owner UI (v2 vs v3). Needs a diff renderer and a second read path, and so far reading the two versions side by side has been enough.
- **KV read-through cache** for the public path (§5).

## 14. Cost

The expected service cost is $0 per month. All components fit their free tiers, and R2 egress is free. The domain costs about $10 per year and is already owned.

Workers AI is the only metered addition. Auto-naming uses about 3 to 5 neurons for an untitled Markdown document. The prompt contains at most about 2000 characters, and output is capped at 32 tokens on the smallest text model. The free allowance is 10,000 neurons per day. Inference runs for untitled Markdown creation and explicit title-suggestion requests. Renaming manually uses no AI. CLI `poof push` resolves and sends its title locally.

## 15. Decision summary

| Item              | Decision                                                                                                                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | Cloudflare Access on both hostnames, each validated against its own AUD; separate Managed OAuth grants for the interactive CLI and MCP clients, optional owner-app service token for CI, bypass on `poof.5n7.me/v/*` `/raw/*`                                                                                                                 |
| Delivery path     | Single public `/raw/{token}` endpoint; `s_` share tokens (D1) + `o_` owner tokens (HMAC, ~10 min)                                                                                                                                                                                                                                             |
| Errors            | Uniform 404 for missing/expired/revoked                                                                                                                                                                                                                                                                                                       |
| Headers           | `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` on viewer/raw paths                                                                                                                                                                                                                                                                   |
| Host isolation    | One Worker, two hostnames dispatched before routing: `poof.5n7.me` serves the web, API, and public paths; `mcp.poof.5n7.me` serves `POST /mcp` and nothing else. Any other host gets 404. Blank or duplicated host vars answer 503 (§6.5).                                                                                                    |
| Infra / stack     | Cloudflare Workers + R2 + D1 + Access; TypeScript + Hono + wrangler + vitest-pool-workers                                                                                                                                                                                                                                                     |
| JWT verification  | `Cf-Access-Jwt-Assertion` only, RS256 against the team JWKS, pinned `iss`, route-specific `aud`, and required `exp` / `iat` / `sub` / `type: "app"`. `nbf` is checked when present but never required. `/mcp` additionally requires an identity assertion and refuses service tokens (§6.6).                                                  |
| MCP auth          | Its own Access application and AUD tag, authenticated with Managed OAuth (authorization code + PKCE) and **no Service Auth policy**, enforced again in-Worker by refusing service-token assertions, plus the shared CSRF guard.                                                                                                               |
| MCP server        | Worker-hosted at `POST mcp.poof.5n7.me/mcp` with Streamable HTTP (`@hono/mcp`). It creates a server per request and issues no session id because isolates are not sticky. The path is exact; other methods return `405` with `Allow: POST` and the server offers no SSE stream.                                                               |
| MCP tools         | Twelve, matching CLI names with underscores; `push`/`update` take files or content; `files` lists paths; file metadata determines omitted `kind`, falling back to md/file on push and current kind on update; `cat` capped at 128 KiB after conversion; results carry absolute `OWNER_HOST` URLs; one shared core in `src/lib/`, two adapters |
| Provisioning      | Idempotent `scripts/bootstrap.sh` + `docs/SETUP.md` + `docs/MCP-OAUTH-RUNBOOK.md`; no Terraform until environments multiply; `workers_dev` disabled; Access JWT verified in-Worker                                                                                                                                                            |
| Renaming          | Editable document metadata; AI suggestions require a separate save; state tokens bind saves to the reviewed title and version; no new version or file changes.                                                                                                                                                                                |
| Rendering         | View-time `markdown-it` in the Worker; Mermaid + highlight.js lazily loaded client-side inside the sandbox                                                                                                                                                                                                                                    |
| Rollback          | `POST …/versions/:version/rollback`; pointer move only, no blob copied; already-current is an idempotent no-op                                                                                                                                                                                                                                |
| Sanitization      | None; all docs treated as untrusted blobs, sandbox is the boundary                                                                                                                                                                                                                                                                            |
| Security boundary | **CSP `sandbox allow-scripts allow-popups` response header** on `/raw/*`, plus the iframe `sandbox` attribute. Never add `allow-same-origin`.                                                                                                                                                                                                 |
| Share model       | Unlisted URL + TTL; `share` as its own entity; revocation in initial scope                                                                                                                                                                                                                                                                    |
| Share on update   | Shares **follow the current version**. An update reaches every live link without reissuing it. Per-share pinning is out of scope (§13).                                                                                                                                                                                                       |
| Titling           | Create-only when `title` is absent: Workers AI → first `#` heading → client fallback. `/api` uses the file name, and MCP `push` uses `untitled`. It runs synchronously so the create response contains the selected title. Failures use the next fallback.                                                                                    |
| Tokens            | `crypto.getRandomValues`, 128-bit, base64url                                                                                                                                                                                                                                                                                                  |
| TTL defaults      | Library: none; shares: 1 day (1h/1d/1w selectable)                                                                                                                                                                                                                                                                                            |
| Version viewing   | Owner-only: `/d/{id}?v=N` (read-only, behind Access) via an `o_` token with the version **inside the signed payload**; `/raw` never accepts a `v` query param                                                                                                                                                                                 |
| Versioning        | Document = stable identity + ordered immutable versions; `document_file` records each snapshot, with first-file metadata on `document_version` for compatibility; `current_version` is a pointer, next = `MAX+1`                                                                                                                              |
