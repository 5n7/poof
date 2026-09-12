---
description: Upload, share, or manage poof documents through MCP tools or the CLI.
name: poof
---

# poof documents

poof stores related files unchanged as one document in a private library.
Uploads stay owner-only by default. Create a public share link only when the
user explicitly requests sharing.

The URL identifies who can open it:

- `/d/{id}` is the owner view protected by Cloudflare Access. Return it to the
  owner after an upload. It does not work for recipients.
- `/v/{token}` is the public share view. Anyone with the URL can open it without
  logging in until the share expires or is revoked.

## Two routes, one poof

- Use the **MCP tools** when the tool list contains `mcp__poof__*`. They call
  the deployment directly and need no local installation or environment
  variables.
- Use the **`poof` CLI** when the MCP tools are unavailable.

The tools use the CLI subcommand names, except MCP uses `suggest_title` for the
CLI's `suggest-title`. The commands below therefore apply to both clients. A
few argument shapes differ; see _MCP differences_. URL types, TTLs, and update
behavior remain the same.

## Prerequisites (CLI route only)

The `poof` command must be on PATH (or run `bun <repo>/cli/index.ts`), with
`POOF_URL` set to the deployment, such as `https://poof.5n7.me`.

Run `poof status`. If it says the OAuth login is missing or expired, ask the
user to run `poof auth login`; ordinary document commands never open a browser.

CI and other headless jobs may set both `POOF_ACCESS_CLIENT_ID` and
`POOF_ACCESS_CLIENT_SECRET`. A complete pair selects service authentication.
One missing half is an error, and the CLI never falls back between service
authentication and OAuth.

If a command reports a missing `POOF_URL`, ask the user to set it rather than
guessing a deployment.

## Commands

Spelled as CLI invocations; each corresponds to an MCP tool with the same
meaning.

```sh
poof cat <doc-id> [--file <path>] [--raw] [--version <n>]
poof files <doc-id> [--version <n>]
poof ls
poof push <file-or-directory>... [--root <directory>] [--share] [--share-ttl 1h|1d|1w] [--title <t>] [--ttl 1h|1d|1w]
poof rename <doc-id> --title <t> [--expected-state <token>]
poof revoke <share-token>
poof rm <doc-id>
poof rollback <doc-id> <version>
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof suggest-title <doc-id>
poof update <doc-id> [<file-or-directory>...] [--delete <path>]... [--root <directory>] [--title <t>]
poof versions <doc-id>
```

- `cat` prints original Markdown/text or readable Markdown extracted from HTML.
  Pass `--file <path>` to select a file and `--version <n>` for a past version. Use `--raw` to retrieve original bytes
  for editing HTML or downloading binary files. Default binary output gives
  metadata and a raw-download command.
- `files` lists paths and file types for the current or selected version.
- `ls` lists documents (id, title, kind, current version, last updated,
  expires).
- `push` uploads one or more files into one document. File types may be mixed.
  It prints the `/d/{id}` owner URL. Add `--share` only for an explicit sharing
  request; it also prints the public `/v/{token}` URL.
- `rename` changes only a document's title without creating a version or
  modifying files. Pass `--expected-state` from `suggest-title` when saving a
  reviewed candidate; without it, the CLI reads a fresh snapshot first.
- `revoke` kills one share token immediately (takes the `s_...` token, not
  the document id).
- `rm` deletes a document, all stored files and versions, and all of its shares.
- `rollback` restores the complete file set from a past version and keeps the current
  document title. Same instant effect on live
  share links as `update`.
- `share` issues an additional share link for an existing document.
- `suggest-title` prints a JSON title candidate and `expected_state` without
  changing the document. Review or edit the candidate, then pass its token to
  `rename` to save it.
- `update` merges by path: matching files are replaced, new paths are appended,
  and omitted files remain. Repeat `--delete <path>` for explicit removals.
  A deletion path is required; use `--delete=-draft.md` for names beginning with a dash.
  It prints the same `/d/{id}` URL, then `v{n}`. The title remains unless
  `--title` is given. A document must retain at least one file.
- `versions` lists a document's versions, newest first, with `*` on the
  current one. Pass one of its version numbers to `rollback`.

## Options

- `--share-ttl` sets the share link lifetime (default `1d`). Shares always
  expire; there is no forever share.
- `--ttl` sets the document's own lifetime. Omitted means the document is
  kept forever; when it expires, the document and all its shares die.

## File paths and limits

Keep related Markdown, HTML, and assets in one document so relative links work.
A directory input stores its contents relative to that directory. Multiple
inputs use their common parent. Use `--root` to choose the root explicitly and
reuse that root for later updates, such as `poof update <id> adr/001.md --root .`.
The first uploaded file opens by default; directories use sorted traversal.
Directory traversal does not follow symbolic link entries. At most 100 files
may remain in a document, and
one upload may contain at most 10 MiB of decoded source bytes.

An existing single-file document accepts the original replacement flow:
`poof update <id> replacement.html` replaces its sole file, including its name.
Pass `--root` for an explicit path when adding files to a single-file document.
When a document already contains several files, a filename-only upload merges
that name and retains the other files.

## MCP differences

- MCP `rename` requires `expected_state` from `ls` `STATE` or `suggest_title`
  `expected_state`. CLI `rename` fetches a fresh state when `--expected-state`
  is omitted.
- For multiple files, `push` and `update` take `files: [{path, content, encoding?}]`.
  Each entry may set `filename`, `kind`, and `media_type`. Preserve nested paths.
  `update` takes `delete_paths: ["obsolete.md"]` for explicit removal.
  Omit top-level `content` when supplying `files`. Use `files` to list paths and
  `cat` with `file: "adr/001.md"` to read one. Both accept a `version`.
- The existing single-file flow takes `content` as a string. For binary files use
  `encoding: "base64"` and base64-encoded content. The 10 MiB cap applies after
  decoding. Set `filename` and optionally `media_type` to describe the file.
- `kind` accepts `file`, `html`, `md`, or `text`. When omitted, the tools infer
  it from supplied file metadata. Without metadata, `push` defaults to `md`
  for text or `file` for base64, and `update` keeps the current kind.
- `push` without a `title` lets the server name the document from its own
  content, so writing one out and pushing it needs no title argument. It
  falls back to the first `#` heading, then the supplied filename or file path,
  and finally `untitled`. The CLI falls back to the file name.
- `cat` converts HTML to readable Markdown before applying its 128 KiB cap.
  Use `raw: true` to read original text/HTML; binary files always return download
  metadata. A longer text comes back truncated,
  with a notice giving the input size, output limit, and its `/d/{id}` URL.
- URLs come back absolute and ready to paste; the CLI prints paths against
  `POOF_URL`.

## Typical flow

Upload a document for the owner:

```sh
poof push overview.md adr/
```

MCP: `push` with each file as `{path, content}` in `files`, omitting `share`.
Return the `/d/...` owner URL.

When the user explicitly requests sharing, add `--share --share-ttl 1d` to
`push`, or run `poof share <doc-id> --share-ttl 1d` for an existing document.
For MCP, use `push` with `share: true`, or `share` with the existing `id`;
both take `share_ttl: "1d"`. Give recipients the `/v/...` URL only.

To revise a document, edit its source and run:

```sh
poof update <doc-id> adr/001.md --root .
```

MCP: `update` with the same `id` and `files: [{path: "adr/001.md", content: "..."}]`.

Existing owner and share URLs keep working. Recipients with live share links
see the new content on their next load; no new URL is needed.

## Cautions

- Anyone holding a `/v/` URL can read the document until it expires. Treat
  the URL itself as the secret. Prefer short share TTLs, and `revoke` when
  access should end early.
- Do not push secrets, credentials, or private data that must not leak
  through a copied link.
- An `update` (or `rollback`) is visible immediately to everyone holding a
  live share link, and there is no way to pin a recipient to an older
  version. Do not update a document to add content one recipient should not
  see. Issue a separate document instead.
- `versions` and `rollback` are owner-side only. Recipients never see the
  version number or that a history exists.
