#!/usr/bin/env bun
// Interactive and headless client for the poof JSON API.

import { defineCommand, runMain } from "citty";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
	api,
	apiCheck,
	apiStream,
	loadConfig,
	p,
	type DocumentRow,
	type RollbackResult,
	type ShareResult,
	type UpdateResult,
	type VersionsResult,
} from "./api";
import { loginOAuth, logoutOAuth, oauthStatus } from "./auth";
import { openBrowser } from "./browser";
import {
	loginSelectionWarning,
	logoutMessage,
	logoutWarning,
	oauthStatusMessage,
	replacementRevocationWarning,
} from "./messages";

const TTL_OPTIONS = ["1h", "1d", "1w"];

function fail(message: string): never {
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
}

/** Run an API interaction, converting thrown errors into a clean exit. */
function attempt(work: () => Promise<void>): Promise<void> {
	return work().catch((err: Error) => fail(err.message));
}

function kindFromExtension(file: string): "md" | "html" {
	const ext = extname(file).toLowerCase();
	if (ext === ".md" || ext === ".markdown") return "md";
	if (ext === ".html" || ext === ".htm") return "html";
	fail(`cannot infer kind from extension '${ext || "(none)"}' (expected .md/.markdown or .html/.htm)`);
}

/**
 * Reject a malformed version before making a request.
 */
function requireVersion(version: string): void {
	if (!/^[1-9][0-9]*$/.test(version)) fail(`invalid version '${version}' (expected a positive integer)`);
}

/**
 * Mirror `firstMarkdownHeading` in src/lib/title.ts. Keep both copies in sync.
 * Importing the Worker version would pull `Env` and `Ai` globals outside this
 * tsconfig's `types` and `include` settings.
 *
 * This copy scans lines. The Worker uses one regex to avoid allocating an array
 * for a document that may be 10 MiB. Both must treat line breaks, including a
 * lone `\r`, the same way. See `MD_HEADING` before changing either copy.
 */
function firstMarkdownHeading(content: string): string | null {
	for (const line of content.split(/\r?\n/)) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
	return null;
}

/** Format epoch seconds as local `YYYY-MM-DD HH:mm`. */
function formatTime(seconds: number | null): string {
	if (seconds == null) return "-";
	const d = new Date(seconds * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Column-aligned plain-text table, shared so every listing lines up the same. */
function printTable(header: string[], rows: string[][]): void {
	// Bun.stringWidth counts display columns, so double-width CJK titles stay aligned.
	const widths = header.map((h, i) => Math.max(Bun.stringWidth(h), ...rows.map((r) => Bun.stringWidth(r[i]))));
	const line = (cells: string[]) =>
		cells.map((cell, i) => cell + " ".repeat(widths[i] - Bun.stringWidth(cell))).join("  ");
	for (const cells of [header, ...rows]) process.stdout.write(line(cells) + "\n");
}

const cat = defineCommand({
	meta: {
		name: "cat",
		description: "Print the stored HTML served by share links. Poof does not keep the original Markdown.",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to print.",
			required: true,
		},
		version: {
			type: "string",
			description: "Version to print (default: the current one; see 'poof versions').",
			valueHint: "n",
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			if (args.version !== undefined) requireVersion(args.version);

			const cfg = loadConfig();
			// The version is validated above, so it needs no encoding of its own.
			const query = args.version === undefined ? "" : `?v=${args.version}`;
			const body = await apiStream(cfg, "GET", p`/api/documents/${args["doc-id"]}/content` + query);
			if (!body) return;
			// Stream without adding a newline so redirected output matches `/raw` byte
			// for byte. Keep stdout open for citty. Treat EPIPE from `| head` as a
			// normal stop.
			await pipeline(Readable.fromWeb(body), process.stdout, { end: false }).catch((err: NodeJS.ErrnoException) => {
				if (err.code !== "EPIPE") throw err;
			});
		}),
});

const login = defineCommand({
	meta: {
		name: "login",
		description: "Log in through Cloudflare Access Managed OAuth.",
	},
	args: {
		"new-client": {
			type: "boolean",
			description: "Replace the saved OAuth client registration and callback port.",
		},
		open: {
			type: "boolean",
			default: true,
			description: "Open the authorization URL in a browser (disable with --no-open).",
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			if (args.open !== false && !process.stdin.isTTY) {
				throw new Error("login requires a terminal; pass --no-open to print the authorization URL explicitly");
			}
			const cfg = loadConfig();
			const selectionWarning = loginSelectionWarning(cfg.auth.type);
			if (selectionWarning) process.stderr.write(selectionWarning);
			const result = await loginOAuth(cfg.url, {
				newClient: args["new-client"] === true,
				onAuthorization: async (url) => {
					process.stderr.write(`Authorize poof in your browser:\n${url}\n`);
					if (args.open !== false && !openBrowser(url)) {
						process.stderr.write("Could not open a browser. Open the URL above manually.\n");
					}
				},
			});
			if (result.replacementRevocationFailed) process.stderr.write(replacementRevocationWarning());
			process.stdout.write(`logged in to ${result.resource}\n`);
		}),
});

const logout = defineCommand({
	meta: {
		name: "logout",
		description: "Revoke the OAuth grant and delete its local tokens.",
	},
	run: () =>
		attempt(async () => {
			const cfg = loadConfig();
			const result = await logoutOAuth(cfg.url);
			if (result.revocationError) {
				process.stderr.write(logoutWarning(cfg.auth.type));
				throw result.revocationError;
			}
			process.stdout.write(logoutMessage(cfg.auth.type, cfg.url, result.hadTokens));
		}),
});

const ls = defineCommand({
	meta: {
		name: "ls",
		description: "List documents (id, title, kind, version, updated, expires).",
	},
	run: () =>
		attempt(async () => {
			const cfg = loadConfig();
			const { documents } = await api<{ documents: DocumentRow[] }>(cfg, "GET", "/api/documents");

			if (documents.length === 0) {
				process.stdout.write("(no documents)\n");
				return;
			}

			// Show UPDATED to keep the table to six columns. For an unchanged document,
			// updated_at equals created_at. `poof versions` shows version 1's timestamp.
			printTable(
				["ID", "TITLE", "KIND", "VER", "UPDATED", "EXPIRES"],
				documents.map((d) => [
					d.id,
					d.title,
					d.kind,
					`v${d.current_version}`,
					formatTime(d.updated_at),
					formatTime(d.expires_at),
				]),
			);
		}),
});

const push = defineCommand({
	meta: {
		name: "push",
		description:
			"Upload a Markdown/HTML file; prints the /d/{id} viewer URL. " +
			"kind is inferred from the extension (.md/.markdown, .html/.htm).",
	},
	args: {
		file: {
			type: "positional",
			description: "File to upload.",
			required: true,
		},
		title: {
			type: "string",
			description: "Document title (default: first '# ' heading or filename).",
			valueHint: "t",
		},
		ttl: {
			type: "enum",
			options: TTL_OPTIONS,
			description: "Document TTL (default: keep forever).",
			valueHint: "dur",
		},
		share: {
			type: "boolean",
			description: "After push, issue a share link and print its /v/{token} URL.",
		},
		"share-ttl": {
			type: "enum",
			options: TTL_OPTIONS,
			description: "Share TTL (default: 1d).",
			valueHint: "dur",
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			// Infer kind and read the file before touching the network, so bad input
			// fails fast without an API round-trip.
			const kind = kindFromExtension(args.file);
			let content: string;
			try {
				content = await readFile(args.file, "utf8");
			} catch (err) {
				fail(`cannot read file '${args.file}': ${(err as Error).message}`);
			}

			const filename = basename(args.file);
			const title = args.title ?? (kind === "md" ? (firstMarkdownHeading(content) ?? filename) : filename);

			const cfg = loadConfig();

			const form = new FormData();
			form.append("file", new Blob([content]), filename);
			form.append("kind", kind);
			form.append("title", title);
			if (args.ttl) form.append("ttl", args.ttl);

			const doc = await api<DocumentRow>(cfg, "POST", "/api/documents", form);
			process.stdout.write(`${cfg.url}/d/${doc.id}\n`);

			if (args.share) {
				const body = args["share-ttl"] ? { ttl: args["share-ttl"] } : {};
				const share = await api<ShareResult>(cfg, "POST", p`/api/documents/${doc.id}/shares`, body);
				process.stdout.write(`${cfg.url}/v/${share.token}\n`);
			}
		}),
});

const revoke = defineCommand({
	meta: {
		name: "revoke",
		description: "Revoke a share token.",
	},
	args: {
		"share-token": {
			type: "positional",
			description: "Share token to revoke.",
			required: true,
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			const cfg = loadConfig();
			await api(cfg, "DELETE", p`/api/shares/${args["share-token"]}`);
			process.stdout.write(`revoked ${args["share-token"]}\n`);
		}),
});

const rm = defineCommand({
	meta: {
		name: "rm",
		description: "Delete a document (removes its blob and cascades shares).",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to delete.",
			required: true,
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			const cfg = loadConfig();
			await api(cfg, "DELETE", p`/api/documents/${args["doc-id"]}`);
			process.stdout.write(`deleted ${args["doc-id"]}\n`);
		}),
});

const rollback = defineCommand({
	meta: {
		name: "rollback",
		description: "Make a past version current again (share links follow it immediately).",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to roll back.",
			required: true,
		},
		version: {
			type: "positional",
			description: "Version number to restore (see 'poof versions').",
			required: true,
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			requireVersion(args.version);

			const cfg = loadConfig();
			const result = await api<RollbackResult>(
				cfg,
				"POST",
				p`/api/documents/${args["doc-id"]}/versions/${args.version}/rollback`,
			);
			process.stdout.write(`rolled back ${args["doc-id"]} to v${result.current_version}\n`);
		}),
});

const share = defineCommand({
	meta: {
		name: "share",
		description: "Issue a share link for a document; prints its /v/{token} URL.",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to share.",
			required: true,
		},
		"share-ttl": {
			type: "enum",
			options: TTL_OPTIONS,
			description: "Share TTL (default: 1d).",
			valueHint: "dur",
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			const cfg = loadConfig();
			const body = args["share-ttl"] ? { ttl: args["share-ttl"] } : {};
			const result = await api<ShareResult>(cfg, "POST", p`/api/documents/${args["doc-id"]}/shares`, body);
			process.stdout.write(`${cfg.url}/v/${result.token}\n`);
		}),
});

const status = defineCommand({
	meta: {
		name: "status",
		description: "Check the configured authentication against the owner API.",
	},
	run: () =>
		attempt(async () => {
			const cfg = loadConfig();
			await apiCheck(cfg);
			if (cfg.auth.type === "service") {
				process.stdout.write(`service authentication is valid for ${cfg.url}\n`);
				return;
			}
			const stored = await oauthStatus(cfg.url);
			if (!stored) throw new Error(`Not logged in to ${cfg.url}. Run 'poof login'.`);
			process.stdout.write(oauthStatusMessage(cfg.url, stored.expiresAt));
		}),
});

const update = defineCommand({
	meta: {
		name: "update",
		description:
			"Replace a document's contents with a new version, keeping its /d/{id} and share links. " +
			"kind is inferred from the extension (.md/.markdown, .html/.htm).",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to update.",
			required: true,
		},
		file: {
			type: "positional",
			description: "File to upload as the new version.",
			required: true,
		},
		title: {
			type: "string",
			description: "New document title (default: keep the current one).",
			valueHint: "t",
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			// Same fail-fast order as push: infer kind and read the file before touching
			// the network, so bad input fails without an API round-trip.
			const kind = kindFromExtension(args.file);
			let content: string;
			try {
				content = await readFile(args.file, "utf8");
			} catch (err) {
				fail(`cannot read file '${args.file}': ${(err as Error).message}`);
			}

			const cfg = loadConfig();

			const form = new FormData();
			form.append("file", new Blob([content]), basename(args.file));
			form.append("kind", kind);
			// Do not infer a title during updates. Omitting the field keeps the current
			// title. The user must pass --title to rename the document.
			if (args.title) form.append("title", args.title);

			const result = await api<UpdateResult>(cfg, "POST", p`/api/documents/${args["doc-id"]}/versions`, form);
			process.stdout.write(`${cfg.url}/d/${result.id}\n`);
			process.stdout.write(`v${result.version}\n`);
		}),
});

const versions = defineCommand({
	meta: {
		name: "versions",
		description: "List a document's versions, newest first ('*' marks the current one).",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to inspect.",
			required: true,
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			const cfg = loadConfig();
			const result = await api<VersionsResult>(cfg, "GET", p`/api/documents/${args["doc-id"]}/versions`);

			printTable(
				["VER", "KIND", "CREATED", "CURRENT"],
				result.versions.map((v) => [
					`v${v.version}`,
					v.kind,
					formatTime(v.created_at),
					v.version === result.current_version ? "*" : "",
				]),
			);
		}),
});

const main = defineCommand({
	meta: {
		name: "poof",
		description:
			"CLI for viewing and sharing temporary documents. Reads POOF_URL and uses stored OAuth by default. " +
			"Only 'poof login' opens a browser. A complete POOF_ACCESS_CLIENT_ID and POOF_ACCESS_CLIENT_SECRET " +
			"pair selects headless service auth.",
	},
	subCommands: { cat, login, logout, ls, push, revoke, rm, rollback, share, status, update, versions },
});

runMain(main);
