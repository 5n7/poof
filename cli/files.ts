import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { MAX_BYTES, MAX_FILES, validateFilePath } from "../src/lib/files";

interface UploadFile {
	path: string;
	filename: string;
	content: Uint8Array<ArrayBuffer>;
}

/** Expand directories in sorted order, preserving paths below the upload root. */
export async function collectFiles(
	inputs: string[],
	root?: string,
): Promise<{ files: UploadFile[]; explicitPaths: boolean }> {
	const paths = inputs.map((input) => resolve(input));
	const entries = await Promise.all(paths.map(async (path) => ({ path, stat: await lstat(path) })));
	let base = root
		? resolve(root)
		: entries.length === 1 && entries[0].stat.isDirectory()
			? paths[0]
			: dirname(paths[0] ?? resolve("."));
	if (!root && entries.length > 1) {
		for (const path of paths) {
			while (relative(base, path).startsWith(`..${sep}`) || relative(base, path) === "..") base = dirname(base);
		}
	}
	const files: UploadFile[] = [];
	const seen = new Set<string>();
	let bytes = 0;
	async function visit(path: string): Promise<void> {
		const local = relative(base, path);
		if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
			throw new Error(`file is outside --root: ${path}`);
		if (local) validateFilePath(local.split(sep).join("/"));
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) throw new Error(`symbolic links are not supported: ${path}`);
		if (stat.isDirectory()) {
			for (const name of (await readdir(path)).sort()) await visit(join(path, name));
			return;
		}
		if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
		const stored = local.split(sep).join("/");
		if (seen.has(stored)) throw new Error(`duplicate upload path: ${stored}`);
		if (files.length >= MAX_FILES) throw new Error(`A document supports at most ${MAX_FILES} files.`);
		if (bytes + stat.size > MAX_BYTES) throw new Error(`Document upload exceeds the ${MAX_BYTES}-byte limit.`);
		const content = new Uint8Array(await readFile(path));
		bytes += content.byteLength;
		if (bytes > MAX_BYTES) throw new Error(`Document upload exceeds the ${MAX_BYTES}-byte limit.`);
		seen.add(stored);
		files.push({ path: stored, filename: basename(path), content });
	}
	for (const path of paths) await visit(path);
	if (inputs.length && !files.length) throw new Error("no files found in the selected directories");
	return {
		files,
		explicitPaths: root !== undefined || inputs.length > 1 || entries.some((entry) => entry.stat.isDirectory()),
	};
}

export function appendFiles(form: FormData, upload: Awaited<ReturnType<typeof collectFiles>>): void {
	for (const file of upload.files) {
		form.append("file", new Blob([file.content]), file.filename);
		if (upload.explicitPaths) form.append("path", file.path);
	}
}

/** Citty keeps only the last repeated string option, so preserve explicit deletions. */
export function deletionPaths(rawArgs: string[]): string[] {
	const { tokens } = parseArgs({
		args: rawArgs,
		options: {
			root: { type: "string" },
			title: { type: "string" },
			delete: { type: "string", multiple: true },
		},
		allowPositionals: true,
		strict: false,
		tokens: true,
	});
	const paths: string[] = [];
	for (const token of tokens) {
		if (token.kind !== "option" || token.name !== "delete") continue;
		if (!token.value || (!token.inlineValue && token.value.startsWith("-")))
			throw new Error("--delete requires a non-empty path. Use --delete=<path> for paths starting with '-'.");
		paths.push(token.value);
	}
	return paths;
}
