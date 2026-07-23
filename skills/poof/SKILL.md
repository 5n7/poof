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
poof share <doc-id> [--share-ttl 1h|1d|1w]
```

- `ls` lists documents (id, title, kind, created, expires).
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
- `share` issues an additional share link for an existing document.

## Typical flow

Sharing a freshly written doc with someone:

```sh
poof push report.md --share --share-ttl 1d
```

Give the recipient the `/v/...` line only. Titles default to the first `#`
heading (Markdown) or the filename, so a `--title` is rarely needed.

## Cautions

- Anyone holding a `/v/` URL can read the document until it expires — treat
  the URL itself as the secret. Prefer short `--share-ttl` values and
  `poof revoke` when access should end early.
- Do not push secrets, credentials, or private data that must not leak
  through a copied link.
- Rendering happens at upload time: fixing a document means editing the
  source file and pushing again (there is no update command; `rm` the old
  document if it should disappear).
