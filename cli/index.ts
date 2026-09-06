#!/usr/bin/env bun
// Interactive and headless client for the poof JSON API.

import { defineCommand, runMain } from "citty";
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
	type TitleSnapshot,
	type TitleSuggestion,
	type UpdateResult,
	type VersionsResult,
} from "./api";
import { loginOAuth, logoutOAuth, oauthStatus } from "./auth";
import { openBrowser } from "./browser";
import { appendFiles, collectFiles, deletionPaths } from "./files";
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
		description: "Print source text or readable Markdown for HTML. Use --raw to download original bytes.",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to print.",
			required: true,
		},
		file: { type: "string", description: "File path within the document (default: first file)." },
		raw: {
			type: "boolean",
			description: "Print original stored bytes, including HTML or binary files.",
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
			const params = new URLSearchParams();
			if (args.version !== undefined) params.set("v", args.version);
			if (args.raw) params.set("format", "raw");
			if (args.file !== undefined) params.set("file", args.file);
			const query = params.size ? `?${params}` : "";
			const body = await apiStream(cfg, "GET", p`/api/documents/${args["doc-id"]}/content` + query);
			if (!body) return;
			// Stream without adding a newline so redirected raw output preserves the original bytes. Keep stdout open for citty. Treat EPIPE from `| head` as a
			// normal stop.
			await pipeline(Readable.fromWeb(body), process.stdout, { end: false }).catch((err: NodeJS.ErrnoException) => {
				if (err.code !== "EPIPE") throw err;
			});
		}),
});

const files = defineCommand({
	meta: { name: "files", description: "List file paths in a document version." },
	args: {
		"doc-id": { type: "positional", required: true, description: "Document id to inspect." },
		version: { type: "string", description: "Version to inspect (default: current)." },
	},
	run: ({ args }) =>
		attempt(async () => {
			if (args.version !== undefined) requireVersion(args.version);
			const query = args.version === undefined ? "" : `?v=${args.version}`;
			const result = await api<{ files: { path: string; kind: string; media_type: string }[] }>(
				loadConfig(),
				"GET",
				p`/api/documents/${args["doc-id"]}/files` + query,
			);
			printTable(
				["PATH", "KIND", "MEDIA TYPE"],
				result.files.map((file) => [file.path, file.kind, file.media_type]),
			);
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

const auth = defineCommand({
	meta: {
		name: "auth",
		description: "Manage authentication.",
	},
	subCommands: { login, logout },
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
		description: "Upload files or directories into one document; prints the /d/{id} viewer URL.",
	},
	args: {
		file: {
			type: "positional",
			description: "Files or directories to upload. Accepts additional positional paths.",
			required: true,
		},
		root: { type: "string", description: "Store paths relative to this directory." },
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
			const upload = await collectFiles(args._, args.root);
			const first = upload.files[0];
			const title =
				args.title ??
				(/\.(md|markdown)$/i.test(first.filename)
					? (firstMarkdownHeading(new TextDecoder().decode(first.content)) ?? first.filename)
					: first.filename);

			const cfg = loadConfig();

			const form = new FormData();
			appendFiles(form, upload);
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

const rename = defineCommand({
	meta: {
		name: "rename",
		description: "Change a document title without creating a version or changing its files.",
	},
	args: {
		"doc-id": { type: "positional", description: "Document id to rename.", required: true },
		title: { type: "string", description: "New document title.", required: true },
		"expected-state": {
			type: "string",
			description: "State token returned by suggest-title for saving a reviewed candidate.",
		},
	},
	run: ({ args }) =>
		attempt(async () => {
			const cfg = loadConfig();
			const state =
				args["expected-state"] ?? (await api<TitleSnapshot>(cfg, "GET", p`/api/documents/${args["doc-id"]}`)).state;
			const result = await api<TitleSnapshot>(cfg, "PATCH", p`/api/documents/${args["doc-id"]}/title`, {
				title: args.title,
				expected_state: state,
			});
			process.stdout.write(`${JSON.stringify(result)}\n`);
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
			if (!stored) throw new Error(`Not logged in to ${cfg.url}. Run 'poof auth login'.`);
			process.stdout.write(oauthStatusMessage(cfg.url, stored.expiresAt));
		}),
});

const suggestTitle = defineCommand({
	meta: {
		name: "suggest-title",
		description: "Print an AI title suggestion as JSON without changing the document.",
	},
	args: {
		"doc-id": { type: "positional", description: "Document id to suggest a title for.", required: true },
	},
	run: ({ args }) =>
		attempt(async () => {
			const cfg = loadConfig();
			const id = args["doc-id"];
			const doc = await api<TitleSnapshot>(cfg, "GET", p`/api/documents/${id}`);
			const result = await api<TitleSuggestion>(cfg, "POST", p`/api/documents/${id}/title-suggestion`, {
				expected_state: doc.state,
			});
			process.stdout.write(`${JSON.stringify(result)}\n`);
		}),
});

const update = defineCommand({
	meta: {
		name: "update",
		description: "Merge uploaded files by path into a new version, keeping other files and all share links.",
	},
	args: {
		"doc-id": {
			type: "positional",
			description: "Document id to update.",
			required: true,
		},
		file: {
			type: "positional",
			description: "Files or directories to upload. Accepts additional positional paths.",
			required: false,
		},
		root: { type: "string", description: "Store paths relative to this directory." },
		delete: { type: "string", description: "File path to remove. Repeat for multiple files." },
		title: {
			type: "string",
			description: "New document title (default: keep the current one).",
			valueHint: "t",
		},
	},
	run: ({ args, rawArgs }) =>
		attempt(async () => {
			const removed = deletionPaths(rawArgs);
			const upload = await collectFiles(args._.slice(1), args.root);
			if (!upload.files.length && !removed.length) throw new Error("provide files to upload or --delete paths");

			const cfg = loadConfig();

			const form = new FormData();
			appendFiles(form, upload);
			for (const path of removed) form.append("delete", path);
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
			"Only 'poof auth login' opens a browser. A complete POOF_ACCESS_CLIENT_ID and POOF_ACCESS_CLIENT_SECRET " +
			"pair selects headless service auth.",
	},
	subCommands: {
		auth,
		cat,
		ls,
		files,
		push,
		rename,
		revoke,
		rm,
		rollback,
		share,
		status,
		"suggest-title": suggestTitle,
		update,
		versions,
	},
});

runMain(main);
