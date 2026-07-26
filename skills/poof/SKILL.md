---
name: poof
description: Share Markdown/HTML documents via disposable links using the poof CLI. Use when asked to share a document, report, or generated doc with someone as a URL, or to manage previously shared poof documents (list, re-share, revoke, delete).
---

# poof — disposable document sharing

poof uploads a Markdown or HTML file to a private library and mints short-lived
public share links. It is built for AI-generated documents: write a doc, push
it, hand the recipient a URL that later expires or can be revoked instantly.

Two URL kinds come back:

- `/d/{id}` — owner view, protected by Cloudflare Access. Only the owner can
  open it. Never give this URL to someone else; it will not work for them.
- `/v/{token}` — public share view. Works for anyone who has the URL, no
  login, until the share expires or is revoked.

## Prerequisites

The `poof` command must be on PATH (or run `bun <repo>/cli/index.ts`), with
these environment variables set:

- `POOF_URL` — base URL of the deployment (e.g. `https://poof.5n7.me`)
- `POOF_ACCESS_CLIENT_ID` / `POOF_ACCESS_CLIENT_SECRET` — Cloudflare Access
  service token credentials

Verify with `poof --help`. If a command fails with a config error, ask the
user to set these rather than guessing values.

## Commands

```sh
poof ls
poof push <file> [--title <t>] [--ttl 1h|1d|1w] [--share] [--share-ttl 1h|1d|1w]
poof revoke <share-token>
poof rm <doc-id>
poof rollback <doc-id> <version>
poof share <doc-id> [--share-ttl 1h|1d|1w]
poof update <doc-id> <file> [--title <t>]
poof versions <doc-id>
```

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
  current one — the numbers to feed `rollback`.

## Typical flow

Sharing a freshly written doc with someone:

```sh
poof push report.md --share --share-ttl 1d
```

Give the recipient the `/v/...` line only. Titles default to the first `#`
heading (Markdown) or the filename, so a `--title` is rarely needed.

Iterating after feedback — edit the source file, then:

```sh
poof update <doc-id> report.md
```

The recipient sees the new content the next time they load the link they
already have. Do not push a second document and do not re-send a URL.

## Cautions

- Anyone holding a `/v/` URL can read the document until it expires — treat
  the URL itself as the secret. Prefer short `--share-ttl` values and
  `poof revoke` when access should end early.
- Do not push secrets, credentials, or private data that must not leak
  through a copied link.
- An `update` (or `rollback`) is visible immediately to everyone holding a
  live share link, and there is no way to pin a recipient to an older
  version. Do not update a document to add content one recipient should not
  see — issue a separate document instead.
- `versions` and `rollback` are owner-side only. Recipients never see the
  version number or that a history exists.
- Fixing a document means editing the source file and running
  `poof update <doc-id> <file>` — the same URL keeps working, so nothing has
  to be re-issued or re-sent. Use `push` only when it should genuinely be a
  separate document, and `rm` when the old one should disappear.
