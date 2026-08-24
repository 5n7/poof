#!/usr/bin/env bun
// poof CLI — headless upload/share against the poof JSON API.

import { defineCommand, runMain } from "citty";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
	api,
	apiStream,
	loadConfig,
	p,
	type DocumentRow,
	type RollbackResult,
	type ShareResult,
	type UpdateResult,
	type VersionsResult,
} from "./api";

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
 * Reject a malformed version before the network: the server answers 400 for
 * this, but there is no reason to spend a round-trip on a local typo.
 */
function requireVersion(version: string): void {
	if (!/^[1-9][0-9]*$/.test(version)) fail(`invalid version '${version}' (expected a positive integer)`);
}

/**
 * Mirror of `firstMarkdownHeading` in src/lib/title.ts, the only other copy —
 * keep the two in sync. Duplicated rather than imported because this tsconfig
 * narrows `types` and `include`, so the Worker's `Env`/`Ai` globals would fall
 * outside the CLI's program.
 *
 * The two are spelled differently and must still agree exactly, or the CLI and
 * the server would title the same file differently: this scans lines, while the
 * Worker's copy is one regex (it may be handed a 10 MiB push and cannot afford
 * an array of every line). That regex is written around this `split(/\r?\n/)`,
 * down to how a lone `\r` is treated — see the comment on `MD_HEADING` before
 * changing either.
 */
function firstMarkdownHeading(content: string): string | null {
	for (const line of content.split(/\r?\n/)) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
	return null;
}

/** epoch seconds → "YYYY-MM-DD HH:mm" in the machine's local timezone. */
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
		description:
			"Print a document's stored HTML — the rendered blob share links serve, not the Markdown source it came from.",
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
			// Streamed verbatim, with no trailing newline added: `poof cat id > out.html`
			// has to be byte-identical to what /raw serves. `end: false` leaves stdout
			// open for whatever citty does after us; a reader that hangs up (`| head`)
			// surfaces as EPIPE, which is a clean stop, not an error to report.
			await pipeline(Readable.fromWeb(body), process.stdout, { end: false }).catch((err: NodeJS.ErrnoException) => {
				if (err.code !== "EPIPE") throw err;
			});
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

			// UPDATED rather than CREATED, to keep six columns: an un-updated document
			// has updated_at === created_at, and the true creation time is version 1's
			// created_at, visible in `poof versions`.
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
			// Deliberately no firstMarkdownHeading fallback here: push infers a title
			// because a new document has none, but silently renaming an existing
			// document on every content fix would be a surprise. Omitting the field
			// tells the server to keep the current title; --title is the explicit opt-in.
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
			"Ephemeral document viewer & sharing CLI. " +
			"Reads POOF_URL, POOF_ACCESS_CLIENT_ID, and POOF_ACCESS_CLIENT_SECRET from the environment.",
	},
	subCommands: { cat, ls, push, revoke, rm, rollback, share, update, versions },
});

runMain(main);
