import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { seedDoc } from "./helpers";

const BASE = "https://poof.5n7.me";

/** The nine tools, named after the CLI subcommands (SPEC §10). */
const TOOL_NAMES = ["cat", "ls", "push", "revoke", "rm", "rollback", "share", "update", "versions"];

interface ToolAnnotations {
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
	readOnlyHint?: boolean;
}

interface ToolResult {
	content: { text: string; type: string }[];
	isError?: boolean;
}

interface RpcResponse<T> {
	error?: { code: number; message: string };
	id: number;
	jsonrpc: "2.0";
	result: T;
}

let nextId = 1;

/**
 * POST one JSON-RPC message verbatim. The transport answers over SSE (its
 * default), so the response is the single `data:` frame in the body. Takes the
 * whole message so a test can choose its own `id`.
 */
async function rpcRaw<T>(message: object, base = BASE): Promise<RpcResponse<T>> {
	const res = await SELF.fetch(`${base}/mcp`, {
		method: "POST",
		headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
		body: JSON.stringify(message),
	});
	expect(res.status).toBe(200);

	const frame = (await res.text()).split("\n").find((line) => line.startsWith("data:"));
	expect(frame).toBeDefined();
	return JSON.parse(frame!.slice("data:".length)) as RpcResponse<T>;
}

/** One JSON-RPC round trip against `/mcp`, with an id nobody else is using. */
async function rpc<T>(method: string, params?: object): Promise<RpcResponse<T>> {
	return rpcRaw<T>({ jsonrpc: "2.0", id: nextId++, method, params: params ?? {} });
}

/** Call a tool and assert it succeeded, returning its text block. */
async function callTool(name: string, args: object = {}): Promise<string> {
	const { result } = await rpc<ToolResult>("tools/call", { name, arguments: args });
	expect(result.isError, `${name} returned an error: ${result.content[0]?.text}`).toBeFalsy();
	return result.content[0].text;
}

/** Call a tool expecting a tool-level failure, returning its message. */
async function callToolExpectingError(name: string, args: object = {}): Promise<string> {
	const { result } = await rpc<ToolResult>("tools/call", { name, arguments: args });
	expect(result.isError).toBe(true);
	return result.content[0].text;
}

/** The value of a `key: value` line in a tool's text output. */
function field(body: string, prefix: string): string {
	const line = body.split("\n").find((l) => l.startsWith(prefix));
	expect(line, `no line starting with ${prefix} in:\n${body}`).toBeDefined();
	return line!.slice(prefix.length).trim();
}

/** The id out of a `push` result — the first word of its "Created document …" line. */
function createdId(body: string): string {
	return field(body, "Created document ").split(" ")[0];
}

/** The `s_…` token out of a `push --share` or `share` result. */
function shareToken(body: string): string {
	return field(body, "Share token (for the `revoke` tool): ");
}

/** Push a document and hand back both its result text and its id — the run-up to most tests here. */
async function pushDoc(args: object = {}): Promise<{ body: string; id: string }> {
	const body = await callTool("push", { content: "# Doc\n\nbody", ...args });
	return { body, id: createdId(body) };
}

/** A `tools/call` message for `push`, for the tests that need to choose their own JSON-RPC id. */
function pushMessage(title: string, id = 1) {
	return {
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: "push", arguments: { content: `<p>${title}</p>`, kind: "html", title } },
	};
}

describe("MCP endpoint", () => {
	it("answers initialize with the server's identity and instructions", async () => {
		const { result } = await rpc<{
			instructions: string;
			protocolVersion: string;
			serverInfo: { name: string; version: string };
		}>("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});

		expect(result.serverInfo.name).toBe("poof");
		expect(result.protocolVersion).toBeTruthy();
		// The two mistakes the instructions exist to prevent.
		expect(result.instructions).toContain("/v/{token}");
		expect(result.instructions).toContain("Never hand this URL to a recipient");
	});

	it("lists all nine tools with descriptions", async () => {
		const { result } = await rpc<{ tools: { description: string; name: string }[] }>("tools/list");
		expect(result.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
		for (const tool of result.tools) expect(tool.description.length).toBeGreaterThan(0);
	});

	// The hints a client reads to label a tool "read-only" or to ask before running
	// a destructive one. Pinned per tool because the two ways of getting it wrong
	// cost in opposite directions: a destructive tool that claims to be read-only
	// runs with no prompt at all, and a reading tool that claims to be destructive
	// trains the caller to click through the prompts that do matter.
	it("annotates every tool with its behavior hints", async () => {
		const { result } = await rpc<{ tools: { annotations?: ToolAnnotations; name: string }[] }>("tools/list");
		const annotationsOf = (name: string) => result.tools.find((t) => t.name === name)!.annotations;

		// The other two hints are defined only when readOnlyHint is false, so these
		// must not state them: an absent hint is not the same claim as a false one.
		for (const name of ["cat", "ls", "versions"]) {
			expect(annotationsOf(name), name).toMatchObject({ readOnlyHint: true });
			expect(annotationsOf(name), name).not.toHaveProperty("destructiveHint");
			expect(annotationsOf(name), name).not.toHaveProperty("idempotentHint");
		}

		// The writing tools, one row each. `revoke` and `rm` are the only two that may
		// carry destructiveHint: true — `update` appends a version and `rollback` moves
		// a pointer, neither of which destroys anything.
		const writes: [name: string, destructiveHint: boolean, idempotentHint: boolean][] = [
			["push", false, false],
			["revoke", true, true],
			["rm", true, true],
			["rollback", false, true],
			["share", false, false],
			["update", false, false],
		];
		for (const [name, destructiveHint, idempotentHint] of writes) {
			expect(annotationsOf(name), name).toMatchObject({ destructiveHint, idempotentHint, readOnlyHint: false });
		}

		// Every tool acts on the owner's own library and nothing outside it, which the
		// hint's default of true would deny.
		for (const name of TOOL_NAMES) expect(annotationsOf(name), name).toMatchObject({ openWorldHint: false });
	});

	// The asymmetry is load-bearing, so it is pinned in the schema rather than
	// left to prose: push has no prior kind and defaults to "md", while update
	// must carry no default at all, because a default there is what silently
	// re-renders an HTML document as Markdown for every share holder.
	it("gives push's kind a default and update's none", async () => {
		const { result } = await rpc<{
			tools: { inputSchema: { properties: Record<string, { default?: string; description: string }> }; name: string }[];
		}>("tools/list");
		const kindOf = (name: string) => result.tools.find((t) => t.name === name)!.inputSchema.properties.kind;

		expect(kindOf("push").default).toBe("md");

		const update = kindOf("update");
		expect(update).not.toHaveProperty("default");
		expect(update.description).toContain("Omit to keep the document's current kind");
	});

	// The test that actually pins per-request construction, and it does so without
	// depending on two requests overlapping in time.
	//
	// Every tool closes over `origin`, read from the request being served. A
	// server built once and reused would have captured whichever request built it,
	// so a later caller arriving on a different host would be handed the *first*
	// caller's origin — a wrong, and possibly foreign, URL to pass to a recipient.
	// Rebuilding per request is what makes that impossible.
	//
	// Verified to discriminate: hoisting the server to module scope makes this
	// fail, while the two tests below still pass.
	it("builds the server per request, so each caller gets its own origin", async () => {
		const here = await rpcRaw<ToolResult>(pushMessage("Origin Default"));
		expect(here.result.content[0].text).toContain(`${BASE}/d/`);

		const ALT = "https://alt.example";
		const there = await rpcRaw<ToolResult>(pushMessage("Origin Alt"), ALT);
		const text = there.result.content[0].text;
		expect(text).toContain(`${ALT}/d/`);
		expect(text).not.toContain(BASE);
	});

	// A weaker property than the origin test above, kept because a colliding id is
	// the routine case (clients number their own ids from 1) and both callers must
	// still be answered. Note this does NOT prove per-request construction on its
	// own: this harness serializes the two fetches, so a module-level server
	// passes it too.
	it("answers two concurrent requests that share a JSON-RPC id", async () => {
		const [a, b] = await Promise.all([
			rpcRaw<ToolResult>(pushMessage("Concurrent A")),
			rpcRaw<ToolResult>(pushMessage("Concurrent B")),
		]);

		// Each answered its own caller, under the id that caller sent.
		expect(a.id).toBe(1);
		expect(b.id).toBe(1);
		expect(a.result.isError).toBeFalsy();
		expect(b.result.isError).toBeFalsy();

		const texts = [a.result.content[0].text, b.result.content[0].text];
		expect(texts.some((t) => t.includes('title "Concurrent A"'))).toBe(true);
		expect(texts.some((t) => t.includes('title "Concurrent B"'))).toBe(true);

		// Two distinct documents, so neither response is the other one echoed.
		const ids = texts.map((t) => createdId(t));
		expect(ids[0]).not.toBe(ids[1]);
	});

	// The whole point of stateless mode: each request builds its own server and
	// transport, so nothing may depend on an `initialize` having come first. A
	// regression here breaks every client that does not reuse one HTTP exchange.
	it("serves tools/list and tools/call with no preceding initialize", async () => {
		const { result: list } = await rpc<{ tools: { name: string }[] }>("tools/list");
		expect(list.tools).toHaveLength(TOOL_NAMES.length);

		const pushed = await callTool("push", { content: "# Stateless\n\nno handshake" });
		expect(pushed).toContain("Created document ");
	});

	// Holds the whole result body on purpose: this is the test that pins the shape
	// of what `push` prints, not just that it worked.
	it("push creates a document and returns an absolute owner URL", async () => {
		const { body, id } = await pushDoc({ content: "# Inferred Title\n\nbody text" });

		expect(body).toContain(`${BASE}/d/${id}`);
		// Title inference matches `poof push`: the first '# ' heading.
		expect(body).toContain('title "Inferred Title"');
		expect(body).toContain("expires never");
		// No share was asked for, so no /v/ URL may appear.
		expect(body).not.toContain("/v/");

		// The document really is in the library, at version 1.
		const listing = await callTool("ls");
		expect(listing).toContain(id);

		const versions = await callTool("versions", { id });
		expect(versions).toContain("v1\tmd\t");
	});

	it("push with share: true also returns the public /v/ URL", async () => {
		const before = (Date.now() / 1000) | 0;
		const { body } = await pushDoc({
			content: "# Shared\n\nfor a recipient",
			share: true,
			share_ttl: "1h",
			ttl: "1w",
		});

		const token = shareToken(body);
		expect(token.startsWith("s_")).toBe(true);
		expect(body).toContain(`${BASE}/v/${token}`);
		expect(body).not.toContain("expires never");

		// The link is live and serves the rendered document to an anonymous reader.
		const raw = await SELF.fetch(`${BASE}/raw/${token}`);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toContain("<h1>Shared</h1>");

		// share_ttl 1h, not the 1d default.
		const share = await env.DB.prepare("SELECT expires_at FROM share WHERE token = ?")
			.bind(token)
			.first<{ expires_at: number }>();
		expect(share!.expires_at).toBeGreaterThanOrEqual(before + 3600);
		expect(share!.expires_at).toBeLessThanOrEqual(before + 3600 + 5);
	});

	it("push accepts an explicit title and html kind", async () => {
		const { body, id } = await pushDoc({ content: "<h1>Raw</h1>", kind: "html", title: "Explicit" });
		expect(body).toContain('title "Explicit"');

		// html is stored as-is: no viewer wrapper around it.
		expect(await callTool("cat", { id })).toBe("<h1>Raw</h1>");
	});

	it("cat returns the stored rendered HTML, current version by default", async () => {
		const { id } = await pushDoc({ content: "# Rendered\n\nsome text" });

		const html = await callTool("cat", { id });
		expect(html).toContain("<h1>Rendered</h1>");
		expect(html).toContain("<title>Rendered</title>");
		// It is the rendering, not the Markdown that produced it.
		expect(html).not.toContain("# Rendered");
	});

	// The behavior the schema assertion above exists to protect. An omitted kind
	// used to mean "md", which re-rendered an HTML document's markup as Markdown
	// with no error and instant effect on every share link.
	it("update keeps the document's kind when none is given", async () => {
		const { id } = await pushDoc({ content: "<p>original</p>", kind: "html", title: "Kept" });

		const updated = await callTool("update", { content: "<p>revised</p>", id });
		expect(updated).toContain("(html,");

		// Stored as-is: no viewer wrapper, and the markup is not escaped into text.
		const html = await callTool("cat", { id });
		expect(html).toBe("<p>revised</p>");
		expect(await callTool("versions", { id })).toContain("v2\thtml\t");
	});

	it("update changes the kind when one is given explicitly", async () => {
		const { id } = await pushDoc({ content: "<p>as html</p>", kind: "html", title: "Switching" });

		const updated = await callTool("update", { content: "# Now Markdown\n\nbody", id, kind: "md" });
		expect(updated).toContain("(md,");

		const html = await callTool("cat", { id });
		expect(html).toContain("<h1>Now Markdown</h1>");
		expect(await callTool("versions", { id })).toContain("v2\tmd\t");
	});

	// The cap is adapter-only: it exists because this output lands in a model's
	// context, not because the document is too big to serve.
	it("cat truncates an oversized document and says so", async () => {
		// Comfortably past the 128 KiB cap, stored as html so the body is the blob.
		const big = `<p>${"x".repeat(200 * 1024)}</p>`;
		const { id } = await pushDoc({ content: big, kind: "html", title: "Big" });

		const out = await callTool("cat", { id });
		expect(out).toContain("[truncated:");
		// The true total, not the capped length, and where the whole thing lives.
		expect(out).toContain(`${big.length} bytes`);
		expect(out).toContain(`${BASE}/d/${id}`);
		expect(out).toContain("do not send that URL to a recipient");
		// The head survived and the cap actually bit.
		expect(out.startsWith("<p>xxx")).toBe(true);
		expect(out.length).toBeLessThan(big.length);

		// The API content route is deliberately uncapped — it streams to a file
		// descriptor, so `poof cat big > out.html` must stay byte-exact.
		const api = await SELF.fetch(`${BASE}/api/documents/${id}/content`);
		expect((await api.text()).length).toBe(big.length);
	});

	// The cap counts bytes, so it can land mid-codepoint. The streaming decoder is
	// never flushed, which drops the dangling bytes instead of emitting U+FFFD —
	// asserted here because it is invisible until someone cats a CJK document.
	it("cat cuts multibyte content on a character boundary", async () => {
		// "あ" is 3 UTF-8 bytes, and 128 KiB is not a multiple of 3, so the cap
		// necessarily falls inside a character.
		const big = "あ".repeat(60 * 1024);
		const { id } = await pushDoc({ content: big, kind: "html", title: "Multibyte" });

		const out = await callTool("cat", { id });
		const head = out.slice(0, out.indexOf("\n\n[truncated:"));
		expect(head).not.toContain("�");
		expect(head).toBe("あ".repeat(head.length));
		// 128 KiB / 3 bytes, rounded down — the last whole character that fits.
		expect(head.length).toBe(Math.floor((128 * 1024) / 3));
	});

	it("cat does not truncate a document that fits", async () => {
		const { id } = await pushDoc({ content: "<p>small</p>", kind: "html", title: "Small" });

		const out = await callTool("cat", { id });
		expect(out).toBe("<p>small</p>");
		expect(out).not.toContain("[truncated:");
	});

	it("update adds a version that every live share link follows", async () => {
		const { body, id } = await pushDoc({ content: "# Doc\n\nfirst", share: true });
		const token = shareToken(body);

		const updated = await callTool("update", { content: "# Doc\n\nsecond", id });
		expect(updated).toContain(`Updated ${id} to v2`);
		// The title is kept when none is given.
		expect(updated).toContain('title "Doc"');
		expect(updated).toContain(`${BASE}/d/${id}`);

		// Same token, new content — nothing was re-issued.
		const raw = await SELF.fetch(`${BASE}/raw/${token}`);
		expect(await raw.text()).toContain("second");

		const versions = await callTool("versions", { id });
		const rows = versions.split("\n");
		expect(rows[0]).toBe("VERSION\tKIND\tCREATED\tCURRENT");
		// Newest first, '*' on the current one.
		expect(rows[1].startsWith("v2\t")).toBe(true);
		expect(rows[1].endsWith("\t*")).toBe(true);
		expect(rows[2].startsWith("v1\t")).toBe(true);
		expect(rows[2].endsWith("\t")).toBe(true);

		// cat can still read the superseded version.
		expect(await callTool("cat", { id, version: 1 })).toContain("first");
	});

	it("rollback makes a past version current again", async () => {
		const { id } = await pushDoc({ content: "# Roll\n\nv1 body" });
		await callTool("update", { content: "# Roll\n\nv2 body", id });

		const rolled = await callTool("rollback", { id, version: 1 });
		expect(rolled).toContain(`Rolled back ${id} to v1`);
		expect(await callTool("cat", { id })).toContain("v1 body");
	});

	it("share issues an extra link and revoke kills it immediately", async () => {
		const { id } = await pushDoc({ content: "# Shareable\n\nbody" });

		const shared = await callTool("share", { id, share_ttl: "1d" });
		const token = shareToken(shared);
		expect(shared).toContain(`${BASE}/v/${token}`);
		expect((await SELF.fetch(`${BASE}/raw/${token}`)).status).toBe(200);

		expect(await callTool("revoke", { token })).toContain(`Revoked ${token}`);
		expect((await SELF.fetch(`${BASE}/raw/${token}`)).status).toBe(404);
	});

	// The lifetime is spelled `share_ttl` on both `share` and `push`, matching the
	// CLI's `--share-ttl` on both subcommands (SPEC §11.3). Asserted against the
	// stored row and with a value that is NOT the 1d default, because the failure
	// mode of a third spelling is silent: zod drops an unrecognized key without an
	// error, so a caller's `1h` would come back as a day-long link and any test
	// that only checks "a link was issued" would still pass.
	it("share honors an explicit share_ttl", async () => {
		const { id } = await pushDoc({ content: "# Timed\n\nbody" });

		const before = (Date.now() / 1000) | 0;
		const token = shareToken(await callTool("share", { id, share_ttl: "1h" }));

		const share = await env.DB.prepare("SELECT expires_at FROM share WHERE token = ?")
			.bind(token)
			.first<{ expires_at: number }>();
		expect(share!.expires_at).toBeGreaterThanOrEqual(before + 3600);
		expect(share!.expires_at).toBeLessThanOrEqual(before + 3600 + 5);
	});

	it("rm deletes the document and cascades its shares", async () => {
		const { body, id } = await pushDoc({ content: "# Doomed\n\nbody", share: true });
		const token = shareToken(body);

		expect(await callTool("rm", { id })).toContain(`Deleted document ${id}`);
		expect((await SELF.fetch(`${BASE}/raw/${token}`)).status).toBe(404);
		expect(await callTool("ls")).not.toContain(id);
	});

	it("ls reports an empty-safe listing shape", async () => {
		const { id } = await pushDoc({ content: "# Listed\n\nbody", ttl: "1d" });

		const listing = await callTool("ls");
		expect(listing.split("\n")[0]).toBe("ID\tTITLE\tKIND\tVERSION\tUPDATED\tEXPIRES");
		const row = listing
			.split("\n")
			.find((l) => l.startsWith(id))!
			.split("\t");
		expect(row).toHaveLength(6);
		expect(row[1]).toBe("Listed");
		expect(row[2]).toBe("md");
		expect(row[3]).toBe("v1");
		expect(row[5]).not.toBe("never");
	});

	// Titles are arbitrary user input, and the listing is tab-separated: an
	// embedded tab or newline would split the row and shift every later column,
	// so a model would read this document's kind or expiry off the wrong one.
	it("flattens control characters in a title so ls columns cannot shift", async () => {
		const title = "tab\there\nand newline";
		const { id } = await pushDoc({ content: "<p>x</p>", kind: "html", title });

		const row = (await callTool("ls"))
			.split("\n")
			.find((l) => l.startsWith(id))!
			.split("\t");
		expect(row).toHaveLength(6);
		expect(row[1]).toBe("tab here and newline");
		expect(row[2]).toBe("html");
	});
});

// The owner-TTL split is deliberate and was previously untested: the five tools
// that act on a document resolve it with getLiveDocument/getLiveDocumentAt and
// refuse an expired one, while `rm` uses getDocument so the owner can still
// clean up before the weekly sweep reaches it.
describe("MCP owner-TTL gating", () => {
	/** Seed a document whose owner TTL has already passed. */
	async function expiredDoc(): Promise<string> {
		const id = `mcp_expired_${crypto.randomUUID().slice(0, 8)}`;
		const now = (Date.now() / 1000) | 0;
		await seedDoc(id, { title: "expired", body: "<p>gone</p>", createdAt: now - 7200, expiresAt: now - 3600 });
		return id;
	}

	it("refuses cat, rollback, share, update and versions on an expired document", async () => {
		const id = await expiredDoc();

		// `share` is the one with teeth: resolving with getDocument here would mint
		// a live token for a dead document, so the owner hands out a URL that 404s
		// for the recipient while looking successful on this side.
		const calls: [string, object][] = [
			["cat", { id }],
			["rollback", { id, version: 1 }],
			["share", { id }],
			["update", { content: "<p>new</p>", id }],
			["versions", { id }],
		];
		for (const [name, args] of calls) {
			const message = await callToolExpectingError(name, args);
			expect(message, `${name} did not refuse the expired document`).toContain(id);
		}

		// Nothing was issued as a side effect of the refusals.
		const shares = await env.DB.prepare("SELECT COUNT(*) AS n FROM share WHERE document_id = ?")
			.bind(id)
			.first<{ n: number }>();
		expect(shares!.n).toBe(0);
	});

	it("still lets rm delete an expired document", async () => {
		const id = await expiredDoc();
		expect(await callTool("rm", { id })).toContain(`Deleted document ${id}`);
		// Gone for real, not merely hidden behind the TTL filter.
		const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM document WHERE id = ?").bind(id).first<{ n: number }>();
		expect(row!.n).toBe(0);
	});
});

describe("MCP tool errors", () => {
	it("reports an unknown id as a tool error, not a transport failure", async () => {
		const message = await callToolExpectingError("cat", { id: "does_not_exist" });
		expect(message).toContain("does_not_exist");

		for (const name of ["rm", "share", "update", "versions"]) {
			const args = name === "update" ? { content: "# x", id: "does_not_exist" } : { id: "does_not_exist" };
			expect(await callToolExpectingError(name, args)).toContain("does_not_exist");
		}
	});

	it("reports an unknown version and an unknown share token", async () => {
		const { id } = await pushDoc({ content: "# Errors\n\nbody" });

		expect(await callToolExpectingError("cat", { id, version: 99 })).toContain("No version 99");
		expect(await callToolExpectingError("rollback", { id, version: 99 })).toContain("No version 99");
		expect(await callToolExpectingError("revoke", { token: "s_nope" })).toContain("s_nope");
	});

	it("rejects content over the 10 MiB limit", async () => {
		const tooBig = "a".repeat(10 * 1024 * 1024 + 1);
		expect(await callToolExpectingError("push", { content: tooBig })).toContain("exceeds");

		const { id } = await pushDoc({ content: "# Small\n\nbody" });
		expect(await callToolExpectingError("update", { content: tooBig, id })).toContain("exceeds");
	});

	it("rejects a bad ttl through the tool's input schema", async () => {
		const { result } = await rpc<ToolResult>("tools/call", {
			name: "push",
			arguments: { content: "# Bad ttl", ttl: "1y" },
		});
		expect(result.isError).toBe(true);
	});
});

// POST is the whole surface (SPEC §9). A stateless server has no SSE stream to
// offer on GET and no session for DELETE to terminate, so both get the 405 the
// MCP spec permits — with Allow, so a client is told what the endpoint takes
// rather than left to guess at a 404.
describe("MCP method handling", () => {
	for (const method of ["GET", "DELETE"]) {
		it(`answers ${method} /mcp with 405 and Allow: POST`, async () => {
			const res = await SELF.fetch(`${BASE}/mcp`, {
				method,
				headers: { Accept: "application/json, text/event-stream" },
			});
			expect(res.status).toBe(405);
			expect(res.headers.get("Allow")).toBe("POST");
		});
	}

	it("still serves POST", async () => {
		const { result } = await rpc<{ tools: { name: string }[] }>("tools/list");
		expect(result.tools).toHaveLength(TOOL_NAMES.length);
	});
});

// The global test env sets DEV_DISABLE_ACCESS="1" (auth skipped). To exercise
// the real Access-enforcement path we call the worker directly with the flag
// cleared, keeping the live DB/BLOBS bindings.
describe("MCP behind Access (DEV_DISABLE_ACCESS unset)", () => {
	const accessEnv: Env = { ...env, DEV_DISABLE_ACCESS: "" };

	it("rejects /mcp without the Cf-Access-Jwt-Assertion header (403)", async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch!(
			new Request(`${BASE}/mcp`, {
				method: "POST",
				headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			}),
			accessEnv,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});
});

describe("MCP CSRF protection", () => {
	it("rejects a cross-site POST even though auth passes (403)", async () => {
		const res = await SELF.fetch(`${BASE}/mcp`, {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"Sec-Fetch-Site": "cross-site",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});
});
