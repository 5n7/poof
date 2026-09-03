---
name: poof
description: Share Markdown/HTML documents via disposable links, through the poof MCP tools or the poof CLI. Use when asked to share a document, report, or generated doc with someone as a URL, or to manage previously shared poof documents (list, re-share, revoke, delete).
---

# poof document sharing

poof stores a Markdown or HTML document in a private library and mints
short-lived public share links. Write a document, push it, and send the
recipient a URL. The URL expires on schedule or stops working when revoked.

Two URL kinds come back:

- `/d/{id}` is the owner view protected by Cloudflare Access. Only the owner can
  open it. Never give this URL to someone else; it will not work for them.
- `/v/{token}` is the public share view. Anyone with the URL can open it without
  logging in until the share expires or is revoked.

## Two routes, one poof

- Use the **MCP tools** when the tool list contains `mcp__poof__*`. They call
  the deployment directly and need no local installation or environment
  variables.
- Use the **`poof` CLI** when the MCP tools are unavailable.

The tools use the CLI subcommand names. The commands below therefore apply to
both clients. A few argument shapes differ; see _MCP differences_. URL types,
TTLs, and update behavior remain the same.

## Prerequisites (CLI route only)

The `poof` command must be on PATH (or run `bun <repo>/cli/index.ts`), with
these environment variables set:

- `POOF_URL` sets the deployment base URL, such as `https://poof.5n7.me`.
- `POOF_ACCESS_CLIENT_ID` and `POOF_ACCESS_CLIENT_SECRET` hold the Cloudflare
  Access service token credentials.

Verify with `poof --help`. If a command fails with a config error, ask the
user to set these rather than guessing values.

## Commands

Spelled as CLI invocations; each is also an MCP tool of the same name, with the
same meaning.

```sh
poof cat <doc-id> [--version <n>]
poof ls
poof push <file> [--title <t>] [--ttl 1h|1d|1w] [--share] [--share-ttl 1h|1d|1w]
poof revoke <share-token>
poof rm <doc-id>
poof rollback <doc-id> <version>
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof update <doc-id> <file> [--title <t>]
poof versions <doc-id>
```

- `cat` prints a document's stored HTML to stdout. Pass `--version <n>` for a
  past version. The output is **rendered** HTML, not the Markdown that produced
  it. poof keeps only the rendering. Use it to verify what a recipient sees.
  Never `cat` a document and feed the result back through `update`: that
  replaces the document with its own rendering and destroys the Markdown. To
  change a document, revise the source you wrote and `update` from that.
- `ls` lists documents (id, title, kind, current version, last updated,
  expires).
- `push` uploads a `.md`/`.markdown` or `.html`/`.htm` file (kind inferred
  from the extension) and prints the `/d/{id}` owner URL. With `--share` it
  also issues a share link and prints the `/v/{token}` URL on a second line.
- `--ttl` sets the document's own lifetime. Omitted means the document is
  kept forever; when it expires, the document and all its shares die.
- `--share-ttl` sets the share link lifetime (default `1d`). Shares always
  expire; there is no forever share.
- `revoke` kills one share token immediately (takes the `s_...` token, not
  the document id).
- `rm` deletes a document, its stored blob, and all of its shares.
- `rollback` makes a past version current again. Same instant effect on live
  share links as `update`.
- `share` issues an additional share link for an existing document.
- `update` replaces a document's contents with a new version, keeping the
  same `/d/{id}` and the same share links. Prints the `/d/{id}` URL, then
  `v{n}` on a second line. The title is kept unless `--title` is given; the
  kind may change between versions (`.md` → `.html` is fine).
- `versions` lists a document's versions, newest first, with `*` on the
  current one. Pass one of its version numbers to `rollback`.

## MCP differences

- `push` and `update` take the document **content as a string**, not a file
  path. The server runs on the Worker and cannot see your filesystem. The
  content you just wrote is what you pass; no file has to exist.
- With no path there is no extension to infer `kind` from, so it is an
  explicit `md` | `html` argument. `push` defaults to `md`. On `update`,
  omitting it **keeps the document's current kind**. Pass `kind` only when
  the document should switch between Markdown and HTML.
- `push` without a `title` lets the server name the document from its own
  content, so writing one out and pushing it needs no title argument. It
  falls back to the first `#` heading and then to `untitled`; the CLI, which
  has a file, falls back to the file name instead.
- `cat` output is capped at 128 KiB. A longer document comes back truncated,
  with a notice giving its real size and its `/d/{id}` URL.
- URLs come back absolute and ready to paste; the CLI prints paths against
  `POOF_URL`.

## Typical flow

Sharing a freshly written doc with someone:

```sh
poof push report.md --share --share-ttl 1d
```

MCP: `push` with the document text as `content`, `share: true`, and
`share_ttl: "1d"`.

Give the recipient the `/v/...` line only. A title argument is rarely needed:
the server names an untitled document from its content, and the CLI falls back
to the file name.

To revise a shared document, edit its source and run:

```sh
poof update <doc-id> report.md
```

MCP: `update` with the same `id` and the revised text as `content`.

The recipient sees the new content the next time they load the link they
already have. Do not push a second document and do not re-send a URL.

## Cautions

These cautions apply to both clients. The MCP tools repeat them in their own
descriptions.

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
- Fixing a document means revising the source and running `update` on the same
  document id. The same URL keeps working, so nothing has to be reissued or
  re-sent. Use `push` only when it should genuinely be a separate document,
  and `rm` when the old one should disappear.
