export type DocumentKind = "file" | "html" | "md" | "text";

export interface FileType {
	kind: DocumentKind;
	media_type: string;
}

const TYPES: Record<string, string> = {
	avif: "image/avif",
	bash: "text/plain",
	c: "text/plain",
	conf: "text/plain",
	cpp: "text/plain",
	css: "text/css",
	csv: "text/csv",
	gif: "image/gif",
	go: "text/plain",
	h: "text/plain",
	htm: "text/html",
	html: "text/html",
	ico: "image/x-icon",
	ini: "text/plain",
	java: "text/plain",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "text/javascript",
	json: "application/json",
	jsx: "text/javascript",
	kt: "text/plain",
	log: "text/plain",
	m4a: "audio/mp4",
	markdown: "text/markdown",
	md: "text/markdown",
	mjs: "text/javascript",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
	ogg: "audio/ogg",
	pdf: "application/pdf",
	png: "image/png",
	py: "text/plain",
	rb: "text/plain",
	rs: "text/plain",
	sh: "text/plain",
	sql: "text/plain",
	svg: "image/svg+xml",
	swift: "text/plain",
	tex: "text/plain",
	toml: "text/plain",
	ts: "text/plain",
	tsv: "text/tab-separated-values",
	tsx: "text/plain",
	txt: "text/plain",
	wav: "audio/wav",
	webm: "video/webm",
	webp: "image/webp",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	zip: "application/zip",
	zsh: "text/plain",
};

export function isDocumentKind(value: unknown): value is DocumentKind {
	return value === "file" || value === "html" || value === "md" || value === "text";
}

export function isTextMediaType(value: string): boolean {
	return (
		value.startsWith("text/") ||
		/^(application\/(json|xml|javascript)|image\/svg\+xml)$/.test(value) ||
		/\+(json|xml)$/.test(value)
	);
}

/** Infer display behavior without decoding or modifying the file bytes. */
export function inferFileType(filename: string, mediaType = ""): FileType {
	const extension = filename.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? "";
	const supplied = mediaType.split(";")[0].trim().toLowerCase();
	const media_type =
		(Object.hasOwn(TYPES, extension) ? TYPES[extension] : undefined) ??
		(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(supplied) ? supplied : "application/octet-stream");
	if (media_type === "text/markdown") return { kind: "md", media_type };
	if (media_type === "text/html") return { kind: "html", media_type };
	return { kind: isTextMediaType(media_type) ? "text" : "file", media_type };
}

/** Recognize UTF-8 text only when metadata did not identify a binary format. */
export function inferFileBytes(filename: string, mediaType: string, source: ArrayBufferLike): FileType {
	const inferred = inferFileType(filename, mediaType);
	if (inferred.media_type !== "application/octet-stream") return inferred;
	const bytes = new Uint8Array(source);
	if (bytes.some((byte) => byte === 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) return inferred;
	try {
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		return { kind: "text", media_type: "text/plain" };
	} catch {
		// Invalid UTF-8 remains a binary file. Its original bytes are still stored.
	}
	return inferred;
}

export function defaultMediaType(kind: DocumentKind): string {
	return { file: "application/octet-stream", html: "text/html", md: "text/markdown", text: "text/plain" }[kind];
}

/** Keep download names in a quoted ASCII fallback plus an encoded UTF-8 parameter. */
export function attachmentDisposition(filename: string | null): string {
	const name = filename || "document";
	const fallback = name.replace(/[^a-zA-Z0-9._-]/g, "_");
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
