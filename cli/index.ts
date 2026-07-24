#!/usr/bin/env bun
// poof CLI — headless upload/share against the poof JSON API.

import { defineCommand, runMain } from "citty";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { api, loadConfig, type DocumentRow, type ShareResult } from "./api";

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

const ls = defineCommand({
	meta: {
		name: "ls",
		description: "List documents (id, title, kind, created, expires).",
	},
	run: () =>
		attempt(async () => {
			const cfg = loadConfig();
			const { documents } = await api<{ documents: DocumentRow[] }>(cfg, "GET", "/api/documents");

			if (documents.length === 0) {
				process.stdout.write("(no documents)\n");
				return;
			}

			const header = ["ID", "TITLE", "KIND", "CREATED", "EXPIRES"];
			const rows = documents.map((d) => [d.id, d.title, d.kind, formatTime(d.created_at), formatTime(d.expires_at)]);
			const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

			const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
			for (const cells of [header, ...rows]) process.stdout.write(line(cells) + "\n");
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
				const share = await api<ShareResult>(cfg, "POST", `/api/documents/${doc.id}/shares`, body);
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
			await api(cfg, "DELETE", `/api/shares/${args["share-token"]}`);
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
			await api(cfg, "DELETE", `/api/documents/${args["doc-id"]}`);
			process.stdout.write(`deleted ${args["doc-id"]}\n`);
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
			const result = await api<ShareResult>(cfg, "POST", `/api/documents/${args["doc-id"]}/shares`, body);
			process.stdout.write(`${cfg.url}/v/${result.token}\n`);
		}),
});

const main = defineCommand({
	meta: {
		name: "poof",
		description:
			"Ephemeral document viewer & sharing CLI. " +
			"Reads POOF_URL, POOF_ACCESS_CLIENT_ID, and POOF_ACCESS_CLIENT_SECRET from the environment.",
	},
	subCommands: { ls, push, revoke, rm, share },
});

runMain(main);
