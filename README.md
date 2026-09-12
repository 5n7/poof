<p align="center">
	<img src="assets/logo.png" width="96" alt="poof logo" />
</p>

<h1 align="center">poof</h1>

<p align="center">Disposable viewer &amp; sharing for AI-generated documents.</p>

Push related files and get one URL. Browse mixed Markdown, HTML, and assets in
file tabs, with relative links between them. Cloudflare Access protects the
library and owner views. Share links (`/v/{token}`) are public, always expire,
and can be revoked at any time.

Updates keep the same URLs, so existing share links show the latest content. The
owner can view or restore earlier versions.

## Usage

```sh
poof auth login                            # authenticate in a browser
poof auth logout                           # revoke the OAuth grant and forget it locally
poof cat <doc-id>                          # print source text; HTML becomes Markdown
poof cat <doc-id> --file adr/001.md        # select a file
poof cat <doc-id> --raw > file             # download original bytes
poof files <doc-id>                        # list paths in the current version
poof ls                                    # list documents
poof push report.md --share                # upload + print a share URL (1d TTL)
poof push overview.md adr/ --share         # related files in one document
poof rename <doc-id> --title "New title"   # change the title without a new version
poof revoke <share-token>                  # kill a share link now
poof rm <doc-id>                           # delete a document and its shares
poof rollback <doc-id> <n>                 # make version n current again
poof share <doc-id>                        # issue another share link
poof status                                # check the saved login against the API
poof suggest-title <doc-id>                # print an AI candidate as JSON; saves nothing
poof update <doc-id> adr/001.md --root .   # replace this path, retain other files
poof update <doc-id> --delete obsolete.md  # remove a file in a new version
poof versions <doc-id>                     # version history, newest first
```

Set `POOF_URL=https://poof.5n7.me`, then run `poof auth login`. The CLI uses
Cloudflare Access Managed OAuth and saves its tokens in the operating system's
credential manager.

CI and other sessions with no human use an Access service token instead. Set
both `POOF_ACCESS_CLIENT_ID` and `POOF_ACCESS_CLIENT_SECRET`; a complete pair
selects service authentication without reading or falling back to a saved OAuth
grant.

You can also select or drag multiple files into the web library, upload a
folder, or paste a file with ⌘V. A pasted document has no file name, so Workers
AI uses its opening text to name it. The same naming process handles an MCP
`push` without a title.

Choose **Rename** in a document's menu to edit its title. **Suggest with AI**
creates a candidate you can review or edit before saving. Renaming changes the
library and live viewer title without creating a version, changing files, or
changing URLs. Historical versions keep their recorded titles.

`poof suggest-title <doc-id>` returns `title` and an opaque `expected_state`
token as JSON. To save a reviewed candidate, copy the returned token:

```sh
poof rename <doc-id> --title "Chosen title" \
  --expected-state "<returned-token>"
```

If the document changed meanwhile, saving fails without overwriting it. A manual
`rename` without this option reads a fresh snapshot first. Both title commands
print JSON.

Uploads accept up to 100 files and 10 MiB of source bytes per request. A single
directory upload stores paths below that directory. Multiple inputs use their
common parent as the root; `--root` chooses it explicitly. Use the same root
when updating a nested file. Directory traversal uses sorted names and does not
follow symbolic link entries. The first uploaded file opens by default.

Updates replace matching paths, append new paths, and keep files omitted from
the upload. Repeat `--delete` to remove several files. Rollback restores the
entire file set. The document title remains unchanged by rollback. A legacy
single-file update without an explicit path still replaces the sole file,
including its name. Use `--root` to add another path to a single-file document.
A document must retain at least one file.

Links with query parameters open within the content frame and preserve those
parameters; the outer file tab stays selected. Plain file links switch tabs.

## Stack

Cloudflare Workers with Hono, D1, R2, Cloudflare Access, and Workers AI. The
deployment fits within their free tiers. Files retain their original bytes in
storage. The viewer renders Markdown and text on demand, displays supported
media, and offers downloads for other files. HTML runs inside a sandboxed iframe
with a CSP `sandbox` response header as the primary security boundary. `cat`
extracts readable Markdown from HTML and omits scripts and styles.

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

After login, the client exposes the same twelve document tools as the CLI. `push` and
`update` accept `files: [{path, content, encoding?}]` with mixed file types, or
the existing single `content` argument. `update` accepts `delete_paths` for
explicit removals. Use `files` to list paths and `cat` with `file` to read one.
The server receives file contents because it cannot access your filesystem.
`suggest_title` returns a candidate without saving. `rename` accepts `title` and
`expected_state` to save a reviewed title safely. MCP `ls` includes a `STATE`
column for manual renaming without AI.
