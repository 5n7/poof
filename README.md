<p align="center">
	<img src="assets/logo.png" width="96" alt="poof logo" />
</p>

<h1 align="center">poof</h1>

<p align="center">Disposable viewer &amp; sharing for AI-generated documents.</p>

Push a Markdown or HTML file and get a URL. The library and owner views sit behind
Cloudflare Access; share links (`/v/{token}`) are public, always expire, and
can be revoked at any time.

Documents update in place. A new version keeps the same URLs, so existing share
links show the latest content. The owner can view or restore earlier versions.

## Usage

```sh
poof cat <doc-id>             # print the stored (rendered) HTML
poof ls                       # list documents
poof push report.md --share   # upload + print a share URL (1d TTL)
poof revoke <share-token>     # kill a share link now
poof rm <doc-id>              # delete a document and its shares
poof rollback <doc-id> <n>    # make version n current again
poof share <doc-id>           # issue another share link
poof update <doc-id> file.md  # new version; same URLs keep working
poof versions <doc-id>        # version history, newest first
```

You can also drag and drop a file into the web library or paste one with ⌘V.
A pasted document has no file name, so Workers AI reads the opening and names
it. The same naming process handles an MCP `push` without a title.

## Stack

Cloudflare Workers with Hono, D1, R2, Cloudflare Access, and Workers AI. The
deployment fits within their free tiers.
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

## MCP server

The Worker serves MCP at `/mcp` and uses the same Access service token as the
CLI. No local process is required.

```sh
claude mcp add --transport http poof https://poof.5n7.me/mcp \
  --header "CF-Access-Client-Id: $POOF_ACCESS_CLIENT_ID" \
  --header "CF-Access-Client-Secret: $POOF_ACCESS_CLIENT_SECRET"
```

The tools match the nine CLI commands. `push` and `update` take document content
instead of a file path because the server cannot access your filesystem.
