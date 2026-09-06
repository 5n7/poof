import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_BYTES, MAX_FILES } from "../src/lib/files";
import { collectFiles } from "./files";

test("directory uploads enforce file count and aggregate byte limits locally", async () => {
	const directory = await mkdtemp(join(tmpdir(), "poof-upload-limits-"));
	try {
		const many = join(directory, "many");
		await mkdir(many);
		await Promise.all(Array.from({ length: MAX_FILES + 1 }, (_, i) => writeFile(join(many, `${i}.md`), "")));
		await expect(collectFiles([many])).rejects.toThrow(`at most ${MAX_FILES} files`);
		const large = join(directory, "large.bin");
		await writeFile(large, "");
		await truncate(large, MAX_BYTES + 1);
		await expect(collectFiles([large])).rejects.toThrow("byte limit");
		await truncate(large, MAX_BYTES);
		const extra = join(directory, "extra.txt");
		await writeFile(extra, "x");
		await expect(collectFiles([large, extra])).rejects.toThrow("byte limit");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("directory uploads reject unsafe paths, duplicates, outside roots, and symbolic links", async () => {
	const directory = await mkdtemp(join(tmpdir(), "poof-upload-paths-"));
	try {
		const root = join(directory, "root");
		await mkdir(root);
		const source = join(root, "source.md");
		await writeFile(source, "# Source");
		await expect(collectFiles([source, source])).rejects.toThrow("duplicate upload path");
		await expect(collectFiles([directory], root)).rejects.toThrow("outside --root");
		const unsafe = join(root, "query?.md");
		await writeFile(unsafe, "# Unsafe");
		await expect(collectFiles([unsafe])).rejects.toThrow("Invalid file path");
		const linked = join(root, "linked.md");
		await symlink(source, linked);
		await expect(collectFiles([linked])).rejects.toThrow("symbolic links");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
