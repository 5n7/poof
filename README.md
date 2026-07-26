<p align="center">
	<img src="assets/logo.png" width="96" alt="poof logo" />
</p>

<h1 align="center">poof</h1>

<p align="center">Disposable viewer &amp; sharing for AI-generated documents.</p>

Push a Markdown/HTML file, get a URL. The library and owner views sit behind
Cloudflare Access; share links (`/v/{token}`) are public, always expire, and
can be revoked instantly.

Documents update in place: a new version keeps the same URLs, so share links
already handed out follow the latest content. Past versions stay around for
the owner to view and roll back to.

## Usage

```sh
poof ls                       # list documents
poof push report.md --share   # upload + print a share URL (1d TTL)
poof revoke <share-token>     # kill a share link now
poof rm <doc-id>              # delete a document and its shares
poof rollback <doc-id> <n>    # make version n current again
poof share <doc-id>           # issue another share link
poof update <doc-id> file.md  # new version; same URLs keep working
poof versions <doc-id>        # version history, newest first
```

Drag & drop or ⌘V on the web library works too.

## Stack

Cloudflare Workers + Hono, D1, R2, Cloudflare Access — all free tier.
Documents are rendered to HTML at upload time and served inside a sandboxed
iframe with a CSP `sandbox` response header as the primary security boundary.

## Setup

See [docs/SETUP.md](docs/SETUP.md) for one-time provisioning, and
[SPEC.md](SPEC.md) for the full design.

## Claude Code skill

```sh
npx skills add 5n7/poof
```

Teaches Claude to share documents with the `poof` CLI.
