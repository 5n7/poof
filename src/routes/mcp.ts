import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { type ShareRow, getLiveDocument, listDocuments, listVersions, revokeShare } from "../lib/db";
import {
	MAX_BYTES,
	addVersion,
	createDocument,
	deleteDocumentWithBlobs,
	issueShare,
	readVersionBlob,
	rollbackDocument,
	sourceBytes,
} from "../lib/documents";
import { canonicalHost } from "../lib/hosts";
import { nowSeconds } from "../lib/time";
import { resolveNewTitle } from "../lib/title";
import { TTL_KEYS, ttlToSeconds } from "../lib/tokens";

/**
 * Expose the document library as MCP tools over Streamable HTTP (SPEC §10).
 * Tool names match the CLI subcommands. `accessAuth` and `csrfProtection` in
 * index.ts protect this route. MCP clients authenticate with Cloudflare Access
 * Managed OAuth, and `accessAuth("mcp")` accepts only a human identity
 * assertion here, never a service token (SPEC §11.2).
 *
 * The server runs here, on the Worker, so it cannot read the caller's
 * filesystem. `push` and `update` take content, not a path.
 */
export const mcpRoutes = new Hono<{ Bindings: Env }>();

const KIND = z.enum(["md", "html"]);
// Build this enum from the same table as `parseTtl` to keep them in sync.
const TTL = z.enum(TTL_KEYS);

/**
 * Give the model the safety rules that apply across tools.
 */
const INSTRUCTIONS = `poof stores Markdown/HTML documents and mints short-lived public share links.

Poof returns two URL types. Do not mix them up:
- /d/{id} is the owner view, behind Cloudflare Access. Only the owner can open it. Never hand this URL to a recipient; it will not work for them.
- /v/{token} is the public share view. Anyone holding it can read the document, with no login, until it expires or is revoked. Treat the URL itself as the secret: prefer short share TTLs, and revoke when access should end early.

To share a new document, call push with share: true and send only the /v/ line. To revise it, call update with the same id. Existing /d/ and /v/ URLs will keep working. Do not create a second document for a revision.

An update or rollback is visible immediately to everyone holding a live share link, and there is no way to pin a recipient to an older version. Never update a document to add content one recipient should not see; issue a separate document instead.

Do not push secrets, credentials, or private data that must not leak through a copied link.`;

/** Return one text block. */
function text(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }] };
}

/**
 * Return an expected tool error without throwing.
 */
function failure(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Match the API's uniform 404 response (SPEC §6.3). */
function missing(id: string): CallToolResult {
	return failure(`No live document with id ${id}. It may never have existed, or its TTL has passed.`);
}

/** Reject an oversized source with a readable message, before the core throws. */
function tooLarge(source: string): CallToolResult | null {
	return sourceBytes(source) > MAX_BYTES ? failure(`Content exceeds the ${MAX_BYTES}-byte limit.`) : null;
}

/**
 * Build owner and share URLs from `OWNER_HOST`, never the MCP request host.
 * Preserve the request scheme for local development. The guard matters because
 * assigning an empty host is a no-op and would return a broken MCP-host URL.
 */
function ownerOrigin(c: Context<{ Bindings: Env }>): string {
	const url = new URL(c.req.url);
	const host = canonicalHost(c.env.OWNER_HOST, url.protocol);
	if (host === null) throw new Error("OWNER_HOST is missing, blank, or not a host");

	url.host = host;
	return url.origin;
}

/**
 * Format owner and share URLs consistently across tools.
 */
function ownerLine(origin: string, id: string): string {
	return `Owner URL. Cloudflare Access only. Never send this URL to a recipient: ${origin}/d/${id}`;
}

function shareLines(origin: string, row: ShareRow): string[] {
	return [
		`Share URL. Hand out this URL only. It expires ${formatTime(row.expires_at)}: ${origin}/v/${row.token}`,
		`Share token (for the \`revoke\` tool): ${row.token}`,
	];
}

/** Format epoch seconds as ISO-8601 UTC, or "never" when no TTL is set. */
function formatTime(seconds: number | null): string {
	return seconds === null ? "never" : new Date(seconds * 1000).toISOString();
}

/**
 * Build a tab-separated table for `ls` and `versions`.
 *
 * Cells are flattened to single-space-separated text first. Titles are arbitrary
 * user input (only `.trim()`ed on the way in), so a tab or newline in one would
 * otherwise split a row and shift later columns.
 */
function table(header: string[], rows: string[][]): string {
	const cell = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	return [header, ...rows].map((cells) => cells.map(cell).join("\t")).join("\n");
}

/**
 * Limit `cat` output because it enters a model's context. The API endpoint
 * streams the same blob to a file and does not need this limit.
 *
 * `wrapViewerHtml` puts styles, the title, and content first. Its loader script
 * comes last, so truncation preserves the start of the visible document.
 */
const CAT_MAX_BYTES = 128 * 1024; // 128 KiB

/**
 * Decode at most `cap` bytes and stop the transfer without buffering the full
 * document.
 *
 * Do not flush the streaming decoder because a cap can land
 * mid-codepoint, and flushing would turn the dangling bytes into a U+FFFD at the
 * tail. Not flushing drops the incomplete sequence instead.
 */
async function readCapped(stream: ReadableStream, cap: number): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let out = "";
	let seen = 0;
	try {
		while (seen < cap) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value as Uint8Array;
			const take = Math.min(chunk.length, cap - seen);
			out += decoder.decode(chunk.subarray(0, take), { stream: true });
			seen += take;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return out;
}

/**
 * Tool annotations tell clients whether an operation reads or destroys data.
 * They are advisory. Handlers enforce access and data changes.
 *
 * Only the hints that carry information are written, because the defaults are not
 * neutral. `destructiveHint` and `idempotentHint` are defined solely when
 * `readOnlyHint` is false, so the reading tools state neither. A value there is
 * noise a reader has to decide whether to believe.
 *
 * `openWorldHint: false` on all nine. Its default is true, meaning the tool may
 * reach external entities. Every poof tool acts only on the owner's library.
 */

/**
 * Build a new server for each request. A Workers isolate handles concurrent
 * requests. A module-level `McpServer` could send a response through another
 * caller's transport.
 */
function buildServer(c: Context<{ Bindings: Env }>): McpServer {
	const server = new McpServer({ name: "poof", version: "1.0.0" }, { instructions: INSTRUCTIONS });
	const origin = ownerOrigin(c);

	server.registerTool(
		"cat",
		{
			annotations: { openWorldHint: false, readOnlyHint: true },
			description:
				"Print the stored HTML served by share links. Poof does not keep the original Markdown. Use this to inspect what recipients see. Do not pass this output to `update`, or the rendered HTML will replace the source. Edit your source and pass that to `update` instead.",
			inputSchema: {
				id: z.string().describe("Document id."),
				version: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Version to read (default: the current one; see the `versions` tool)."),
			},
		},
		async ({ id, version }) => {
			const obj = await readVersionBlob(c.env, id, version ?? null, nowSeconds());
			if (!obj) return version === undefined ? missing(id) : failure(`No version ${version} of document ${id}.`);

			// The common case: the whole document fits, so nothing is touched.
			if (obj.size <= CAT_MAX_BYTES) return text(await obj.text());

			const head = await readCapped(obj.body, CAT_MAX_BYTES);
			return text(
				[
					head,
					"",
					`[truncated: this document is ${obj.size} bytes and only the first ${CAT_MAX_BYTES} are shown.`,
					`The whole thing is at ${origin}/d/${id}. This URL is owner-only. Do not send it to a recipient.]`,
				].join("\n"),
			);
		},
	);

	server.registerTool(
		"ls",
		{
			annotations: { openWorldHint: false, readOnlyHint: true },
			description:
				"List the documents in the library: id, title, kind, current version, last update, and expiry. This is the private owner-side library; nothing here is visible to a recipient.",
			inputSchema: {},
		},
		async () => {
			const documents = await listDocuments(c.env.DB);
			if (documents.length === 0) return text("(no documents)");
			return text(
				table(
					["ID", "TITLE", "KIND", "VERSION", "UPDATED", "EXPIRES"],
					documents.map((d) => [
						d.id,
						d.title,
						d.kind,
						`v${d.current_version}`,
						formatTime(d.updated_at),
						formatTime(d.expires_at),
					]),
				),
			);
		},
	);

	server.registerTool(
		"push",
		{
			annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
			description:
				"Create a document from Markdown or HTML and return its owner URL. With share: true, also create a public /v/{token} URL. Send recipients only the /v/ URL. The /d/{id} URL requires Cloudflare Access. Anyone with the /v/ URL can read the document until expiry or revocation. Treat the /v/ URL itself as a secret. Revise a shared document with `update`; do not create a replacement.",
			inputSchema: {
				content: z.string().describe("The document source: Markdown, or HTML when kind is 'html'."),
				kind: KIND.default("md").describe("How to treat the content: 'md' is rendered, 'html' is stored as-is."),
				share: z.boolean().default(false).describe("Also issue a public share link and return its /v/{token} URL."),
				share_ttl: TTL.default("1d").describe(
					"Share link lifetime. Only takes effect when share is true; it is ignored otherwise. Shares always expire; there is no forever share. Prefer the shortest that works.",
				),
				title: z
					.string()
					.optional()
					.describe("Document title. Omit it and poof names the document from its own content."),
				ttl: TTL.optional().describe(
					"The document's own lifetime (default: kept forever). When it passes, the document and every one of its shares die.",
				),
			},
		},
		async ({ content, kind, share, share_ttl, title, ttl }) => {
			const oversized = tooLarge(content);
			if (oversized) return oversized;

			const now = nowSeconds();
			const expires_at = ttl === undefined ? null : now + ttlToSeconds(ttl);
			// The same naming chain the API create route runs (SPEC §8), with the one
			// difference this adapter has to supply: an MCP client pushes content, not a
			// file, so there is no file name to end on and the terminal is "untitled".
			// `||` rather than `??` keeps a whitespace-only title counting as absent,
			// matching what `readUpload` does with a blank multipart field. It runs after
			// tooLarge above, so the model never reads a document that is about to be
			// refused.
			const resolved = title?.trim() || (await resolveNewTitle(c.env, { fallback: "untitled", kind, source: content }));
			const id = await createDocument(c.env, now, { expires_at, kind, source: content, title: resolved });

			const lines = [
				`Created document ${id} (v1, ${kind}, title ${JSON.stringify(resolved)}, expires ${formatTime(expires_at)}).`,
				ownerLine(origin, id),
			];
			if (share) {
				// Neither refusal is reachable. The document was just created and
				// `share_ttl` came through the TTL enum, but the core owns them now,
				// so say what happened rather than drop the line and read as "no share
				// was asked for".
				const issued = await issueShare(c.env, id, now, share_ttl);
				lines.push(
					issued.ok
						? shareLines(origin, issued.share).join("\n")
						: `No share link was issued (${issued.reason}); call \`share\` with this id to retry.`,
				);
			} else {
				lines.push("No share link yet: call `share` with this id when there is someone to send it to.");
			}
			return text(lines.join("\n"));
		},
	);

	server.registerTool(
		"revoke",
		{
			annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
			description:
				"Revoke one share token immediately: its /v/ URL 404s from the next load on. Takes the s_… share token, not a document id. The document and its other share links are untouched.",
			inputSchema: { token: z.string().describe("Share token to revoke (the s_… value, not a document id).") },
		},
		async ({ token }) => {
			if (!(await revokeShare(c.env.DB, token))) return failure(`No share token ${token}.`);
			return text(`Revoked ${token}. Any /v/ URL using it 404s from now on.`);
		},
	);

	server.registerTool(
		"rm",
		{
			// Idempotent despite a second call coming back as an error result: the hint
			// asks about effect on the environment, not about the response, and there is
			// nothing left to delete. `revoke` is the same shape for the same reason.
			annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
			description:
				"Permanently delete a document, every stored version, and all share links. Use `update` to fix a document without changing its URL. Use `rm` only when the document should disappear.",
			inputSchema: { id: z.string().describe("Document id to delete.") },
		},
		async ({ id }) => {
			if (!(await deleteDocumentWithBlobs(c.env, id))) return missing(id);
			return text(`Deleted document ${id}: its blobs and all of its share links are gone.`);
		},
	);

	server.registerTool(
		"rollback",
		{
			// A pointer move and nothing else: no blob is written (SPEC §11.3), so the
			// version being left behind survives and this destroys nothing. Idempotent
			// because `rollbackDocument` returns the document unchanged when the target
			// is already current, so repeating the call costs a read and no write.
			annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false, readOnlyHint: false },
			description:
				"Make a past version current again (see the `versions` tool for the numbers). Same instant effect on live share links as `update`: everyone holding one sees the restored content on their next load, and there is no way to pin a recipient to another version.",
			inputSchema: {
				id: z.string().describe("Document id to roll back."),
				version: z.number().int().min(1).describe("Version number to restore (see the `versions` tool)."),
			},
		},
		async ({ id, version }) => {
			const now = nowSeconds();
			const doc = await getLiveDocument(c.env.DB, id, now);
			if (!doc) return missing(id);

			const result = await rollbackDocument(c.env, doc, version, now);
			if (!result) return failure(`No version ${version} of document ${id}.`);
			return text(`Rolled back ${id} to v${result.current_version}. Live share links serve it from their next load.`);
		},
	);

	server.registerTool(
		"share",
		{
			annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
			description:
				"Create a public /v/{token} URL for a document. Send recipients only that URL. The /d/{id} URL requires Cloudflare Access. Anyone with the /v/ URL can read the document until expiry or revocation. Treat the /v/ URL itself as a secret. Use a short share_ttl and call `revoke` when access should end early.",
			inputSchema: {
				id: z.string().describe("Document id to share."),
				// Match `push` and the CLI's `--share-ttl` spelling (SPEC §11.3). Zod
				// silently drops unknown keys, so using `ttl` here could turn a requested
				// one-hour share into the default one-day share.
				share_ttl: TTL.default("1d").describe(
					"Share link lifetime. Shares always expire; there is no forever share. Prefer the shortest that works.",
				),
			},
		},
		// Annotated, like the `/api` share handler, so the switch below is exhaustive:
		// an unphrased refusal has to be a type error, not a dropped branch.
		async ({ id, share_ttl }): Promise<CallToolResult> => {
			const issued = await issueShare(c.env, id, nowSeconds(), share_ttl);
			if (issued.ok) return text(shareLines(origin, issued.share).join("\n"));
			switch (issued.reason) {
				// Unreachable: `share_ttl` came through the TTL enum. Answered anyway,
				// because the core is what enumerates the refusals and the type is what
				// keeps this branch from being quietly dropped.
				case "invalid-ttl":
					return failure(`Invalid share ttl ${JSON.stringify(share_ttl)}.`);
				case "not-found":
					return missing(id);
			}
		},
	);

	server.registerTool(
		"update",
		{
			// Updates reach every share holder immediately, but they append a version
			// and keep earlier versions (SPEC §5). MCP defines destructiveHint by data
			// loss, so this remains false. `rm` is the destructive operation.
			annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
			description:
				"Add a version while keeping the same /d/{id} and share links. Recipients see the new content on their next load. Pass your edited source, not the rendered HTML from `cat`. The current title and kind remain unless you provide replacements. All live share links update at once, with no per-recipient version pinning. Use a separate document for content that some recipients must not see.",
			inputSchema: {
				content: z.string().describe("The new document source: Markdown, or HTML when kind is 'html'."),
				id: z.string().describe("Document id to update."),
				// Unlike push, update has no default. An omitted kind keeps the current
				// value. Defaulting to "md" would render an HTML document as Markdown and
				// publish the mistake to every share holder.
				kind: KIND.optional().describe(
					"How to treat the content: 'md' is rendered, 'html' is stored as-is. Omit to keep the document's current kind; pass it explicitly to change the kind for this and later versions.",
				),
				title: z.string().optional().describe("New document title (default: keep the current one)."),
			},
		},
		async ({ content, id, kind, title }) => {
			const oversized = tooLarge(content);
			if (oversized) return oversized;

			const now = nowSeconds();
			// getLiveDocument, not getDocument: no new versions for owner-expired documents.
			const doc = await getLiveDocument(c.env.DB, id, now);
			if (!doc) return missing(id);

			// doc.kind comes from the version joined on current_version.
			const resolved = kind ?? doc.kind;
			const added = await addVersion(c.env, doc, now, {
				kind: resolved,
				source: content,
				title: title?.trim() || null,
			});
			if (!added) return missing(id);

			return text(
				[
					`Updated ${id} to v${added.version} (${resolved}, title ${JSON.stringify(added.title)}).`,
					ownerLine(origin, id),
					"Every live share link already serves the new content; there is nothing to re-issue or re-send.",
				].join("\n"),
			);
		},
	);

	server.registerTool(
		"versions",
		{
			annotations: { openWorldHint: false, readOnlyHint: true },
			description:
				"List a document's versions from newest to oldest. '*' marks the current version. Pass a version number to `rollback`. Only the owner can see this history.",
			inputSchema: { id: z.string().describe("Document id to inspect.") },
		},
		async ({ id }) => {
			const doc = await getLiveDocument(c.env.DB, id, nowSeconds());
			if (!doc) return missing(id);

			const versions = await listVersions(c.env.DB, id);
			return text(
				table(
					["VERSION", "KIND", "CREATED", "CURRENT"],
					versions.map((v) => [
						`v${v.version}`,
						v.kind,
						formatTime(v.created_at),
						v.version === doc.current_version ? "*" : "",
					]),
				),
			);
		},
	);

	return server;
}

/**
 * Stateless Streamable HTTP: a fresh server and transport per request, with no
 * session id, so a `tools/call` needs no `initialize` handshake before it and
 * nothing has to survive between two requests that may land on different
 * isolates.
 */
mcpRoutes.post("/", async (c) => {
	const server = buildServer(c);
	const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined });
	await server.connect(transport);
	// Every branch of handleRequest answers; the `| undefined` in its signature is
	// unreachable, and a 500 is the honest fallback should that ever change.
	return (await transport.handleRequest(c)) ?? c.text("Internal Server Error", 500);
});

/**
 * POST is the only supported method (SPEC §9). Other methods return 405 with
 * the `Allow: POST` header required by MCP.
 *
 * GET looks like a documented MCP method and answering it 405 looks like a bug
 * until you read why: the spec explicitly permits 405 for GET when a server
 * offers no SSE stream at the endpoint, and a stateless server offers none. With
 * no session there are no server-initiated messages, so the stream this would
 * open could never carry anything. It would hold a Worker connection open
 * on 30s keep-alive pings for zero capability. DELETE is the same story: it
 * terminates a session, and there is no session to terminate.
 */
mcpRoutes.all("/", (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }));
