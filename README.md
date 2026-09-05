<p align="center">
	<img src="assets/logo.png" width="96" alt="poof logo" />
</p>

<h1 align="center">poof</h1>

<p align="center">Disposable viewer &amp; sharing for AI-generated documents.</p>

Push a Markdown or HTML file and get a URL. Cloudflare Access protects the
library and owner views. Share links (`/v/{token}`) are public, always expire,
and can be revoked at any time.

Updates keep the same URLs, so existing share links show the latest content. The
owner can view or restore earlier versions.

## Usage

```sh
poof cat <doc-id>             # print the stored (rendered) HTML
poof login                    # authenticate in a browser
poof logout                   # revoke the OAuth grant and forget it locally
poof ls                       # list documents
poof push report.md --share   # upload + print a share URL (1d TTL)
poof revoke <share-token>     # kill a share link now
poof rm <doc-id>              # delete a document and its shares
poof rollback <doc-id> <n>    # make version n current again
poof share <doc-id>           # issue another share link
poof status                   # check the saved login against the API
poof update <doc-id> file.md  # new version; same URLs keep working
poof versions <doc-id>        # version history, newest first
```

Set `POOF_URL=https://poof.5n7.me`, then run `poof login`. The CLI uses
Cloudflare Access Managed OAuth and saves its tokens in the operating system's
credential manager.

CI and other sessions with no human use an Access service token instead. Set
both `POOF_ACCESS_CLIENT_ID` and `POOF_ACCESS_CLIENT_SECRET`; a complete pair
selects service authentication without reading or falling back to a saved OAuth
grant.

You can also drag and drop a file into the web library or paste one with ⌘V.
A pasted document has no file name, so Workers AI uses its opening text to name
it. The same naming process handles an MCP `push` without a title.

## Stack

Cloudflare Workers with Hono, D1, R2, Cloudflare Access, and Workers AI. The
deployment fits within their free tiers.
Documents are rendered to HTML at upload time and served inside a sandboxed
iframe with a CSP `sandbox` response header as the primary security boundary.

## Setup

See [docs/SETUP.md](docs/SETUP.md) for one-time provisioning, and
[SPEC.md](SPEC.md) for the full design.

## Agent skill

The `skills/poof/SKILL.md` skill works with Claude Code, Codex, and other agents
that support the Agent Skills format. It teaches agents to share documents with
the `poof` CLI or MCP tools.

Install it with either of these CLIs:

```sh
gh skills add 5n7/poof poof
npx skills add 5n7/poof
```

## MCP server

MCP has its own hostname, `mcp.poof.5n7.me`, which serves `POST /mcp` and
nothing else. It sits behind a second Cloudflare Access application that
authenticates clients with Managed OAuth, so each client logs in through
Cloudflare with a separate grant. The CLI's OAuth token belongs to the owner
application and cannot open the MCP endpoint. No local process is required.

Register it with an OAuth-capable client. Claude Code prompts for the Cloudflare
login on first use:

```sh
claude mcp add --transport http poof https://mcp.poof.5n7.me/mcp
```

Codex separates registration from login:

```sh
codex mcp add poof --url https://mcp.poof.5n7.me/mcp
codex mcp login poof
```

Set `ACCESS_MCP_AUD` only after creating and checking the Access application in
[docs/MCP-OAUTH-RUNBOOK.md](docs/MCP-OAUTH-RUNBOOK.md). While it is blank,
`POST /mcp` returns `503 Service Unavailable`. Once configured, the endpoint
accepts a human OAuth login and no other credential.

After login, the client exposes the same nine tools as the CLI. `push` and
`update` take document content instead of a file path because the server cannot
access your filesystem.
