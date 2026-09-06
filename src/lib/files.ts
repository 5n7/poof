import type { DocumentKind } from "./content";

export const MAX_BYTES = 10 * 1024 * 1024; // Aggregate upload source bytes.
export const MAX_FILES = 100;
export const MAX_PATH_BYTES = 512;
// Account for a filename, path field, and multipart headers for every source.
export const MAX_UPLOAD_BYTES = MAX_BYTES + 64 * 1024 + MAX_FILES * (2 * MAX_PATH_BYTES + 256);

export class DocumentInputError extends Error {
	constructor(
		message: string,
		public readonly status: 400 | 409 | 413 = 400,
	) {
		super(message);
		this.name = "DocumentInputError";
	}
}

/** Stored paths are relative URL paths, with no ambiguous escaping or traversal. */
export function validateFilePath(path: string): string {
	if (
		!path ||
		new TextEncoder().encode(path).length > MAX_PATH_BYTES ||
		/[\\%?#]/.test(path) ||
		/\p{Cc}/u.test(path) ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		/^[a-z][a-z0-9+.-]*:/i.test(path)
	) {
		throw new DocumentInputError(`Invalid file path: ${JSON.stringify(path)}`);
	}
	return path;
}

export function defaultFilePath(filename: string | null | undefined, kind: DocumentKind): string {
	if (filename) {
		try {
			return validateFilePath(filename);
		} catch {
			/* Legacy metadata may contain a non-path name. */
		}
	}
	return `document.${kind === "file" ? "bin" : kind === "text" ? "txt" : kind}`;
}
