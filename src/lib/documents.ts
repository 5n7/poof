import { deleteBlobs } from "./batch";
import { type DocumentKind, defaultMediaType } from "./content";
import {
	type DocumentFileRow,
	type DocumentRow,
	type ResolvedDocument,
	type ShareRow,
	applyNewVersion,
	compareAndSetDocumentTitle,
	deleteDocument,
	deleteVersion,
	getLiveDocument,
	getLiveDocumentAt,
	getVersion,
	getVersionFile,
	insertDocument,
	insertShare,
	insertVersion,
	listVersionFiles,
	listVersionKeys,
	nextVersion,
	setCurrentVersion,
	versionR2Key,
} from "./db";
import { DocumentInputError, MAX_BYTES, MAX_FILES, defaultFilePath, validateFilePath } from "./files";
import { htmlToMarkdown } from "./html-to-markdown";
import { nowSeconds } from "./time";
import { generateAiTitle } from "./title";
import { newShareToken, parseTtl, randomToken } from "./tokens";

export { DocumentInputError, MAX_BYTES, MAX_FILES } from "./files";

/**
 * Shared write operations for the JSON API and MCP tools. Route files parse
 * input and format responses. This module owns the source, blob, and row order
 * defined in SPEC §9.
 *
 * Upload and rollback operations accept a resolved document so adapters can
 * reject missing documents before parsing request bodies. Title operations
 * resolve and recheck their own snapshots around inference and writes. Other
 * operations verify existence while reading or writing the requested id.
 */

/** Attempts at allocating a version number before giving up (see insertVersion). */
const MAX_VERSION_ATTEMPTS = 3;

/**
 * Return a document source's UTF-8 byte length. Adapters use this to enforce the
 * same `MAX_BYTES` limit. `/api` can use `File.size` directly.
 */
export function sourceBytes(source: string | ArrayBuffer): number {
	return typeof source === "string" ? new TextEncoder().encode(source).length : source.byteLength;
}

export interface NewFileInput {
	path: string;
	filename?: string;
	kind: DocumentKind;
	media_type?: string;
	source: string | ArrayBuffer;
}

interface SingleSourceInput {
	filename?: string;
	kind: DocumentKind;
	media_type?: string;
	source: string | ArrayBuffer;
	files?: never;
}

interface FileSetInput {
	files: NewFileInput[];
}

export type NewDocumentInput = (SingleSourceInput | FileSetInput) & {
	title: string;
	expires_at: number | null;
};

export type NewVersionInput = (SingleSourceInput | FileSetInput) & {
	/** null keeps the document's current title. */
	title: string | null;
	delete_paths?: string[];
};

export interface NewVersion {
	version: number;
	title: string;
}

function validateFiles(files: NewFileInput[]): void {
	if (files.length > MAX_FILES) throw new DocumentInputError(`A document supports at most ${MAX_FILES} files.`);
	const paths = new Set<string>();
	let bytes = 0;
	for (const file of files) {
		validateFilePath(file.path);
		if (paths.has(file.path)) throw new DocumentInputError(`Duplicate file path: ${file.path}`);
		paths.add(file.path);
		bytes += sourceBytes(file.source);
	}
	if (bytes > MAX_BYTES)
		throw new DocumentInputError(`Document upload is ${bytes} bytes, over the ${MAX_BYTES}-byte limit.`, 413);
}

function fileRow(id: string, version: number, file: NewFileInput, position: number): DocumentFileRow {
	return {
		document_id: id,
		version,
		path: file.path,
		filename: file.filename ?? file.path,
		kind: file.kind,
		media_type: file.media_type ?? defaultMediaType(file.kind),
		position,
		r2_key: position === 0 ? versionR2Key(id, version) : `doc/${id}/v${version}/${position}`,
	};
}

/** Stage every source reference before uploading, then publish the complete snapshot. */
export async function createDocument(env: Env, now: number, input: NewDocumentInput): Promise<string> {
	const files = input.files ?? [{ ...input, path: defaultFilePath(input.filename, input.kind) }];
	validateFiles(files);
	if (!files.length) throw new DocumentInputError("At least one file is required.");
	const id = randomToken();
	const rows = files.map((file, position) => fileRow(id, 1, file, position));
	const first = rows[0]!;
	await insertDocument(
		env.DB,
		{ ...first, id, title: input.title, created_at: now, expires_at: input.expires_at },
		rows,
		true,
	);
	try {
		for (let i = 0; i < files.length; i++) await env.BLOBS.put(rows[i]!.r2_key, files[i]!.source);
		if (!(await applyNewVersion(env.DB, id, 1, now, input.title, 0)))
			throw new Error("Document disappeared during upload.");
	} catch (err) {
		await deleteBlobs(
			env.BLOBS,
			rows.map((row) => row.r2_key),
		).catch(() => {});
		await deleteDocument(env.DB, id).catch(() => {});
		throw err;
	}
	return id;
}

/** Merge paths into an immutable snapshot; publishing fails if another writer moved the pointer. */
export async function addVersion(
	env: Env,
	doc: ResolvedDocument,
	now: number,
	input: NewVersionInput,
): Promise<NewVersion | null> {
	const previous = await listVersionFiles(env.DB, doc.id, doc.version);
	const legacy = input.files === undefined;
	const files = input.files ?? [
		{
			...input,
			filename: input.filename ?? doc.filename ?? undefined,
			media_type: input.media_type ?? (input.kind === doc.kind ? doc.media_type : defaultMediaType(input.kind)),
			path: input.filename
				? defaultFilePath(input.filename, input.kind)
				: (previous[0]?.path ?? defaultFilePath(null, input.kind)),
		},
	];
	validateFiles(files);
	const deleted = new Set<string>();
	for (const path of input.delete_paths ?? []) {
		validateFilePath(path);
		if (deleted.has(path)) throw new DocumentInputError(`Duplicate deleted path: ${path}`);
		if (!previous.some((file) => file.path === path)) throw new DocumentInputError(`File does not exist: ${path}`);
		if (files.some((file) => file.path === path))
			throw new DocumentInputError(`Cannot upload and delete the same path: ${path}`);
		deleted.add(path);
	}
	if (!files.length && !deleted.size) throw new DocumentInputError("Upload or delete at least one file.");
	const retained = legacy && previous.length === 1 ? [] : previous.filter((file) => !deleted.has(file.path));
	const paths = retained.map((file) => file.path);
	for (const file of files) if (!paths.includes(file.path)) paths.push(file.path);
	if (!paths.length) throw new DocumentInputError("A document must retain at least one file.");
	if (paths.length > MAX_FILES) throw new DocumentInputError(`A document supports at most ${MAX_FILES} files.`);
	const title = input.title ?? doc.title;
	let version = 0;
	let rows: DocumentFileRow[] = [];
	let writes: { row: DocumentFileRow; source: string | ArrayBuffer }[] = [];
	for (let attempt = 1; ; attempt++) {
		version = await nextVersion(env.DB, doc.id);
		writes = [];
		rows = paths.map((path, position) => {
			const file = files.find((item) => item.path === path);
			if (file) {
				const row = fileRow(doc.id, version, file, position);
				writes.push({ row, source: file.source });
				return row;
			}
			return { ...retained.find((item) => item.path === path)!, version, position };
		});
		const first = rows[0]!;
		if (await insertVersion(env.DB, { ...first, title, created_at: now, ready: 0 }, rows)) break;
		if (attempt >= MAX_VERSION_ATTEMPTS)
			throw new DocumentInputError("Document changed during upload. Retry the update.", 409);
	}
	const discard = async () => {
		await deleteBlobs(
			env.BLOBS,
			writes.map(({ row }) => row.r2_key),
		).catch(() => {});
		await deleteVersion(env.DB, doc.id, version).catch(() => {});
	};
	try {
		for (const { row, source } of writes) await env.BLOBS.put(row.r2_key, source);
		if (!(await applyNewVersion(env.DB, doc.id, version, now, input.title, doc.current_version, doc.title))) {
			if (!(await getLiveDocument(env.DB, doc.id, now))) {
				await discard();
				return null;
			}
			throw new DocumentInputError("Document changed during upload. Retry the update.", 409);
		}
	} catch (err) {
		await discard();
		throw err;
	}
	return { version, title };
}

/** Where a document's pointer ended up, and when it last moved. */
export interface RollbackResult {
	current_version: number;
	updated_at: number;
}

/**
 * Point a live document at an existing version. null when that version is not
 * there. Missing documents and versions both return 404.
 * Rolling back to the version already live is an idempotent no-op that must not
 * bump updated_at (SPEC §9).
 */
export async function rollbackDocument(
	env: Env,
	doc: ResolvedDocument,
	version: number,
	now: number,
): Promise<RollbackResult | null> {
	if (doc.current_version === version) {
		return { current_version: doc.current_version, updated_at: doc.updated_at };
	}

	// Pending versions are excluded by getVersion. Verify every source still exists before restoring.
	const target = await getVersion(env.DB, doc.id, version);
	if (!target) return null;
	const files = await listVersionFiles(env.DB, doc.id, version);
	if (!files.length) return null;
	for (const file of files) if (!(await env.BLOBS.head(file.r2_key))) return null;

	// Only move the pointer. No blob needs copying or cleanup.
	const ok = await setCurrentVersion(env.DB, doc.id, version, now);
	if (!ok) return null;
	return { current_version: version, updated_at: now };
}

/** The issued share, or which precondition refused it. */
export type IssueShareResult = { ok: true; share: ShareRow } | { ok: false; reason: "invalid-ttl" | "not-found" };

/**
 * Issue a share token for a live document (SPEC §7).
 *
 * Both preconditions live here rather than in the adapters, and the ORDER
 * between them is part of the contract. Check liveness before parsing the TTL,
 * so a request naming an unknown document with a bad TTL is answered
 * "not there", never "bad TTL". That precedence is what keeps an id's existence
 * out of the reply (SPEC §6.3), and it is the same one
 * `POST /documents/:id/versions` keeps by resolving the document before it reads
 * the body. Split across two adapters it would only hold until one of them
 * parsed its TTL first.
 *
 * `not-found` also covers an owner-expired document. A share for one would 404
 * for the recipient while looking issued to the owner (SPEC §11.5).
 */
export async function issueShare(env: Env, id: string, now: number, ttl: string): Promise<IssueShareResult> {
	if (!(await getLiveDocument(env.DB, id, now))) return { ok: false, reason: "not-found" };

	const ttlSeconds = parseTtl(ttl);
	if (ttlSeconds === null) return { ok: false, reason: "invalid-ttl" };

	const share: ShareRow = {
		token: newShareToken(),
		document_id: id,
		created_at: now,
		expires_at: now + ttlSeconds,
		revoked: 0,
	};
	await insertShare(env.DB, share);
	return { ok: true, share };
}

/**
 * Delete a document, every version's blob, and its shares. Return false when the
 * document was absent. The DELETE reports whether a row existed, so no separate
 * existence check is needed. A miss costs
 * nothing extra: `listVersionKeys` returns [] and `deleteBlobs` skips R2 on an
 * empty list.
 */
export async function deleteDocumentWithBlobs(env: Env, id: string): Promise<boolean> {
	// Read the keys before the row goes: the cascade wipes document_version.
	const keys = await listVersionKeys(env.DB, id);
	const [, existed] = await Promise.all([deleteBlobs(env.BLOBS, keys), deleteDocument(env.DB, id)]);
	return existed;
}

export interface VersionContent {
	filename: string | null;
	media_type: string;
	binary: boolean;
	body: ReadableStream<Uint8Array>;
	size: number;
	source_size: number;
}

/** Read source or an AI-friendly text representation after resolving authorization. */
export async function readVersionContent(
	env: Env,
	id: string,
	version: number | null,
	now: number,
	raw = false,
	path?: string,
): Promise<VersionContent | null> {
	const doc = await getLiveDocumentAt(env.DB, id, version, now);
	if (!doc) return null;
	const file = await getVersionFile(env.DB, id, doc.version, path);
	if (!file) return null;
	const obj = await env.BLOBS.get(file.r2_key);
	if (!obj) return null;
	const metadata = {
		filename: file.filename,
		media_type: file.media_type,
		binary: file.kind === "file",
		source_size: obj.size,
	};
	if (raw || (file.kind !== "html" && file.kind !== "file")) {
		return { ...metadata, body: obj.body, size: obj.size };
	}
	let content: string;
	if (file.kind === "file") {
		await obj.body.cancel();
		content = `File: ${file.filename ?? doc.title}\nMedia type: ${file.media_type}\nSize: ${obj.size} bytes\nBinary content. Use poof cat ${id} --raw --file '${file.path.replaceAll("'", "'\"'\"'")}'${version === null ? "" : ` --version ${version}`} to retrieve the stored file.\n`;
	} else {
		content = htmlToMarkdown(await obj.text());
	}
	const bytes = new TextEncoder().encode(content);
	return { ...metadata, body: new Response(bytes).body!, size: bytes.byteLength };
}

const TITLE_EXCERPT_CHARS = 2000;
const TITLE_SOURCE_BYTES = 64 * 1024;
const TITLE_SOURCE_FILES = 8;

export interface TitleExpectation {
	expected_state: string;
}

export class TitleOperationError extends Error {
	constructor(
		message: string,
		public readonly status: 400 | 404 | 409 | 422 | 503,
	) {
		super(message);
		this.name = "TitleOperationError";
	}
}

/** A concurrency token preserves exact titles without sending them back in mutation requests. */
export async function documentTitleState(doc: { id: string; title: string; current_version: number }): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([doc.id, doc.current_version, doc.title]));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function documentTitleMetadata(doc: Pick<DocumentRow, "id" | "title" | "current_version" | "updated_at">) {
	return {
		id: doc.id,
		title: doc.title,
		current_version: doc.current_version,
		updated_at: doc.updated_at,
		state: await documentTitleState(doc),
	};
}

export function normalizeDocumentTitle(value: unknown): string {
	if (typeof value !== "string") throw new TitleOperationError("Title must be a string.", 400);
	if (/\p{Cs}/u.test(value)) throw new TitleOperationError("Title contains invalid Unicode characters.", 400);
	for (const ch of value) {
		if (/[\p{Cc}\p{Cf}]/u.test(ch) && !/\s/u.test(ch) && ch !== "\u200c" && ch !== "\u200d")
			throw new TitleOperationError("Title contains unsupported control characters.", 400);
	}
	const title = value.replace(/\s+/gu, " ").trim();
	if (!title || [...title].length > 200)
		throw new TitleOperationError("Use a title between 1 and 200 characters.", 400);
	return title;
}

async function titleSnapshot(env: Env, id: string, expected: TitleExpectation): Promise<ResolvedDocument> {
	const doc = await getLiveDocument(env.DB, id, nowSeconds());
	if (!doc) throw new TitleOperationError("Document not found.", 404);
	if (!expected || typeof expected.expected_state !== "string" || !/^[a-f0-9]{64}$/.test(expected.expected_state))
		throw new TitleOperationError("A valid document state is required.", 400);
	if ((await documentTitleState(doc)) !== expected.expected_state)
		throw new TitleOperationError("The document changed. Reload it before renaming.", 409);
	return doc;
}

/** Keep titles separate from immutable content versions and their stored title snapshots. */
export async function renameDocument(env: Env, id: string, value: unknown, expected: TitleExpectation) {
	const original = await titleSnapshot(env, id, expected);
	const title = normalizeDocumentTitle(value);
	const doc = await compareAndSetDocumentTitle(
		env.DB,
		id,
		title,
		original.current_version,
		original.title,
		nowSeconds(),
	);
	if (!doc) {
		await titleSnapshot(env, id, expected);
		throw new TitleOperationError("The document changed. Reload it before renaming.", 409);
	}
	return documentTitleMetadata(doc);
}

/** Consume only the prefix needed for inference, including empty source objects. */
async function readTitleSource(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let remaining = TITLE_SOURCE_BYTES;
	let text = "";
	try {
		while (remaining > 0) {
			const { value, done } = await reader.read();
			if (done) break;
			const chunk = value.subarray(0, remaining);
			text += decoder.decode(chunk, { stream: true });
			remaining -= chunk.byteLength;
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel();
	}
}

/** Filename labels distinguish files without replacing their content. */
async function documentTitleExcerpt(
	env: Env,
	doc: ResolvedDocument,
): Promise<{ source: string; languageSource: string }> {
	const files = (await listVersionFiles(env.DB, doc.id, doc.current_version))
		.filter((file) => file.kind !== "file")
		.slice(0, TITLE_SOURCE_FILES);
	if (!files.length) throw new TitleOperationError("This document has no readable text to suggest a title from.", 422);
	const instruction = "Name this document as a whole. The following excerpts are its files.\n";
	const budget = Math.floor((TITLE_EXCERPT_CHARS - instruction.length) / files.length);
	const excerpts: string[] = [];
	const content: string[] = [];
	for (const file of files) {
		const obj = await env.BLOBS.get(file.r2_key);
		if (!obj) throw new TitleOperationError("Document content is unavailable.", 404);
		const source = await readTitleSource(obj.body);
		const text = (file.kind === "html" ? htmlToMarkdown(source) : source).trim();
		if (!/[\p{L}\p{N}]/u.test(text)) continue;
		const label = `File: ${file.path.slice(0, 60)}\n`;
		const excerpt = text.slice(0, budget - label.length - 2);
		content.push(excerpt);
		excerpts.push(label + excerpt);
	}
	if (!excerpts.length)
		throw new TitleOperationError("This document has no readable text to suggest a title from.", 422);
	return { source: instruction + excerpts.join("\n\n"), languageSource: content.join("\n\n") };
}

/** Suggestions never persist. Recheck the source snapshot after inference before returning it. */
export async function suggestDocumentTitle(env: Env, id: string, expected: TitleExpectation) {
	const doc = await titleSnapshot(env, id, expected);
	const excerpt = await documentTitleExcerpt(env, doc);
	const title = await generateAiTitle(env, excerpt.source, excerpt.languageSource);
	await titleSnapshot(env, id, expected);
	if (!title) throw new TitleOperationError("Could not suggest a title. Try again or enter your own.", 503);
	try {
		return {
			title: normalizeDocumentTitle(title),
			expected_state: expected.expected_state,
		};
	} catch (error) {
		if (error instanceof TitleOperationError)
			throw new TitleOperationError("Could not suggest a title. Try again or enter your own.", 503);
		throw error;
	}
}
