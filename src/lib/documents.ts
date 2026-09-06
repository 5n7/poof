import { deleteBlobs } from "./batch";
import { type DocumentKind, defaultMediaType } from "./content";
import {
	type DocumentFileRow,
	type ResolvedDocument,
	type ShareRow,
	applyNewVersion,
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
import { newShareToken, parseTtl, randomToken } from "./tokens";

export { DocumentInputError, MAX_BYTES, MAX_FILES } from "./files";

/**
 * Shared write operations for the JSON API and MCP tools. Route files parse
 * input and format responses. This module owns the source, blob, and row order
 * defined in SPEC §9.
 *
 * Two calling conventions live here and the split is deliberate. A function that
 * reads a document's fields takes an already-resolved `ResolvedDocument`
 * (`addVersion`, `rollbackDocument`), so an adapter can reject a missing
 * document before it spends anything on parsing the request body. One that only
 * needs the document to exist takes an id and checks it by
 * resolving it (`issueShare`, `readVersionContent`) or by reading it off the write
 * (`deleteDocumentWithBlobs`, whose DELETE reports whether a row was there).
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
		if (!(await applyNewVersion(env.DB, doc.id, version, now, input.title, doc.current_version))) {
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
