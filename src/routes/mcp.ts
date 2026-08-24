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
import { nowSeconds } from "../lib/time";
import { resolveNewTitle } from "../lib/title";
import { TTL_KEYS, ttlToSeconds } from "../lib/tokens";

/**
 * `/mcp` — the library the CLI drives (SPEC §10), exposed as MCP tools over
 * Streamable HTTP. The tools are named after the CLI subcommands, so a client
 * namespaces them as `mcp__poof__push` and friends. Sits behind `accessAuth`
 * and `csrfProtection` (both wired in index.ts): an MCP client authenticates
 * exactly like the CLI, with a Cloudflare Access service token.
 *
 * The server runs here, on the Worker, so it cannot read the caller's
 * filesystem — `push`/`update` take content as a string, not a path.
 */
export const mcpRoutes = new Hono<{ Bindings: Env }>();

const KIND = z.enum(["md", "html"]);
// Built from the same table `parseTtl` reads, never hand-copied: two lists that
// must agree only agree until someone adds a TTL to one of them, and the failure
// mode is a silent NaN expiry rather than a rejection.
const TTL = z.enum(TTL_KEYS);

/**
 * Handed to the model once, ahead of any tool call — the things that are
 * expensive to get wrong (leaking the owner URL, re-pushing instead of
 * updating) and that no single tool description is guaranteed to be read for.
 */
const INSTRUCTIONS = `poof stores Markdown/HTML documents and mints short-lived public share links.

Two URL kinds come back and they are NOT interchangeable:
- /d/{id} is the owner view, behind Cloudflare Access. Only the owner can open it. Never hand this URL to a recipient; it will not work for them.
- /v/{token} is the public share view. Anyone holding it can read the document, with no login, until it expires or is revoked. Treat the URL itself as the secret: prefer short share TTLs, and revoke when access should end early.

To share a document you just wrote, call push with share: true and give out the /v/ line only. To revise it afterwards, call update on the SAME id: the /d/ URL and every live share link keep working, so nothing has to be re-issued or re-sent. Do not push a second document and send out a new URL.

An update or rollback is visible immediately to everyone holding a live share link, and there is no way to pin a recipient to an older version. Never update a document to add content one recipient should not see; issue a separate document instead.

Do not push secrets, credentials, or private data that must not leak through a copied link.`;

/** A tool result carrying one text block — the only success shape these tools return. */
function text(body: string): CallToolResult {
	return { content: [{ type: "text", text: body }] };
}

/**
 * A readable tool-level failure. Every foreseeable miss (unknown id, expired
 * document, oversized content) comes back through here rather than as a thrown
 * exception, so the model gets a sentence it can act on.
 */
function failure(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** The uniform "isn't there", matching the API's undifferentiated 404 (SPEC §6.3). */
function missing(id: string): CallToolResult {
	return failure(`No live document with id ${id} — it may never have existed, or its TTL has passed.`);
}

/** Reject an oversized source with a readable message, before the core throws. */
function tooLarge(source: string): CallToolResult | null {
	return sourceBytes(source) > MAX_BYTES ? failure(`Content exceeds the ${MAX_BYTES}-byte limit.`) : null;
}

/**
 * The two result lines that name a URL. Built here rather than written out at
 * each call site: the warning attached to each one is the whole defense against
 * handing a recipient a URL that will not work for them (or that works for far
 * too long), and three copies of it drift — they already had, with `push` and
 * `share` disagreeing on the wording.
 */
function ownerLine(origin: string, id: string): string {
	return `Owner URL — Cloudflare Access only, never send this to a recipient: ${origin}/d/${id}`;
}

function shareLines(origin: string, row: ShareRow): string[] {
	return [
		`Share URL — hand out this one only, expires ${formatTime(row.expires_at)}: ${origin}/v/${row.token}`,
		`Share token (for the \`revoke\` tool): ${row.token}`,
	];
}

/** epoch seconds → ISO-8601 UTC; "never" for a document with no TTL. */
function formatTime(seconds: number | null): string {
	return seconds === null ? "never" : new Date(seconds * 1000).toISOString();
}

/**
 * Tab-separated listing with a header row — one shape for both `ls` and
 * `versions`.
 *
 * Cells are flattened to single-space-separated text first. Titles are arbitrary
 * user input (only `.trim()`ed on the way in), so a tab or newline in one would
 * otherwise split a row and silently shift every later column — a model reading
 * the output would attribute a document's kind or expiry to the wrong row.
 */
function table(header: string[], rows: string[][]): string {
	const cell = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ");
	return [header, ...rows].map((cells) => cells.map(cell).join("\t")).join("\n");
}

/**
 * Cap on what `cat` hands back, well under the MAX_BYTES a document may reach.
 * Deliberately adapter-level and not in `lib/documents`: the limit exists
 * because this output lands in a model's context window, which is a property of
 * this surface alone. `GET /api/documents/:id/content` streams the same blob to
 * a file descriptor and is right not to cap it.
 *
 * Truncating the tail is safe here rather than merely tolerable, because of how
 * `wrapViewerHtml` lays a document out: the stylesheet, `<title>` and opening
 * content sit at the head, and the mermaid/highlight.js loader `<script>` sits
 * at the very end. A cut tail therefore costs machinery, not reader-visible
 * content — and `cat` exists to answer "what does the recipient see".
 */
const CAT_MAX_BYTES = 128 * 1024; // 128 KiB

/**
 * Decode at most `cap` bytes off a stream, then stop pulling — so an oversized
 * document is never buffered whole just to be thrown away. Cancelling the reader
 * also stops the transfer, which is why this beats fetching everything and
 * slicing.
 *
 * The decoder runs in streaming mode and is never flushed: a cap can land
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
 * Every tool below carries `annotations` — the MCP hints a client may surface as
 * a "read-only" or "destructive" label, or read to decide what to confirm before
 * running. They are advisory by specification: a client is told to treat them as
 * untrusted input, so nothing here is enforced by them. The enforcement is in the
 * handlers, and these only describe it.
 *
 * Only the hints that carry information are written, because the defaults are not
 * neutral. `destructiveHint` and `idempotentHint` are defined solely when
 * `readOnlyHint` is false, so the reading tools state neither — a value there is
 * noise a reader has to decide whether to believe.
 *
 * `openWorldHint: false` on all nine. Its default is true, meaning the tool may
 * reach into an open-ended world of external entities; poof's world is closed —
 * every tool acts on the owner's own library and nothing beyond it.
 */

/**
 * Build the server for one request. Nothing is held across requests on purpose:
 * a Workers isolate serves many requests concurrently, so a module-level
 * `McpServer` would let one caller's transport answer another caller's request.
 */
function buildServer(c: Context<{ Bindings: Env }>): McpServer {
	const server = new McpServer({ name: "poof", version: "1.0.0" }, { instructions: INSTRUCTIONS });
	// Absolute, from the request: what comes back has to be a URL the caller can
	// paste into a message, not the relative /d/{id} the JSON API returns.
	const origin = new URL(c.req.url).origin;

	server.registerTool(
		"cat",
		{
			annotations: { openWorldHint: false, readOnlyHint: true },
			description:
				"Print a document's stored HTML. This is the RENDERED blob that share links serve, not the Markdown source it came from — poof keeps only the rendering. Use it to check what a recipient actually sees. Never feed this output back into `update`: that replaces the document with its own rendering and destroys the source. To change a document, edit the source you wrote and `update` from that.",
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
					`The whole thing is at ${origin}/d/${id} — owner-only, do not send that URL to a recipient.]`,
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
				"Create a document from Markdown/HTML content and return its owner URL. With share: true it also issues a public share link and returns the /v/{token} URL — give the recipient that line and only that line; the /d/{id} owner URL is behind Cloudflare Access and will not work for anyone else. Anyone holding the /v/ URL can read the document until the share expires or is revoked, so treat it as the secret it is. To revise a document you have already shared, call `update` on its id; do not push a second document and send out a new URL.",
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
				// Neither refusal is reachable — the document was created three lines up
				// and `share_ttl` came through the TTL enum — but the core owns them now,
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
				"Delete a document, every version's stored blob, and all of its share links. Irreversible. Use `update` when a document merely needs fixing — its URL keeps working — and `rm` only when the old one should genuinely disappear.",
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
				"Issue a public share link for an existing document and return its /v/{token} URL. That URL, and only that URL, is what a recipient gets — /d/{id} is Access-protected and will not work for them. Anyone holding the /v/ URL can read the document until it expires or is revoked, so treat the URL itself as the secret: prefer a short share_ttl, and `revoke` when access should end early.",
			inputSchema: {
				id: z.string().describe("Document id to share."),
				// `share_ttl`, not `ttl`, to match `push` and both CLI subcommands'
				// `--share-ttl` (SPEC §11.3). A lone `ttl` reads better here — this tool
				// has no other lifetime to disambiguate from — but the cost of the third
				// spelling is not a caller having to look it up: zod objects drop unknown
				// keys silently, so a caller who knows the CLI passes `share_ttl`, it is
				// thrown away, and the default 1d is issued instead of the hour they
				// asked for. A wrong-looking success is worse than a rejection.
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
			// `destructiveHint: false` is deliberate and is the one value here that
			// reads wrong at first glance. An update is live to every share holder the
			// moment it lands, which invites calling it destructive — but the hint asks
			// whether the tool destroys what is already there, not how far the change
			// reaches. It does not: a version is appended, every earlier one is kept
			// (SPEC §5), and `rollback` puts any of them back. `rm` is the destructive
			// one. Do not flip this because the blast radius is wide.
			annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false, readOnlyHint: false },
			description:
				"Replace a document's contents with a new version, keeping the same /d/{id} and the same share links. This is how a document that has already been sent gets revised: nothing is re-issued and nothing is re-sent, and the recipient sees the new content the next time they open the link they already have. Pass the edited SOURCE you wrote — never the output of `cat`, which is the rendered HTML and would overwrite the document with its own rendering. The title is kept unless one is given, and the kind may change between versions. Every live share holder sees the change immediately and there is no per-recipient version pinning, so never use `update` to add content one recipient should not see.",
			inputSchema: {
				content: z.string().describe("The new document source: Markdown, or HTML when kind is 'html'."),
				id: z.string().describe("Document id to update."),
				// No default here, unlike push — the asymmetry is deliberate, do not
				// "fix" it for consistency. kind is per version (SPEC §5), so an explicit
				// value still changes it; the question is only what *silence* means. push
				// has no prior kind to fall back on, so "md" is a harmless default there.
				// update does, and defaulting to "md" would re-render an HTML document's
				// markup as Markdown — live to every share holder, no error anywhere, and
				// the one wrong value the enum cannot reject. Omission is precisely the
				// case a describe() cannot reach, so the default has to be the document.
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

			// doc.kind is the current version's kind (joined on current_version), which
			// is exactly what "keep the document's kind" means.
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
				"List a document's versions, newest first, with '*' on the current one — the numbers to feed `rollback`. Owner-side only: recipients never see a version number or that a history exists.",
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
 * POST is the whole surface (SPEC §9), so every other method is a 405 carrying
 * `Allow: POST` — the signal the MCP spec mandates, not a bare fall-through 404.
 *
 * GET looks like a documented MCP method and answering it 405 looks like a bug
 * until you read why: the spec explicitly permits 405 for GET when a server
 * offers no SSE stream at the endpoint, and a stateless server offers none. With
 * no session there are no server-initiated messages, so the stream this would
 * open could never carry anything — it would just hold a Worker connection open
 * on 30s keep-alive pings for zero capability. DELETE is the same story: it
 * terminates a session, and there is no session to terminate.
 */
mcpRoutes.all("/", (c) => c.text("Method Not Allowed", 405, { Allow: "POST" }));
