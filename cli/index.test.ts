import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(
	args: string[],
	environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stdoutBytes: Uint8Array; stderr: string }> {
	const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
		cwd: `${import.meta.dir}/..`,
		env: { ...process.env, POOF_URL: "https://poof.example", ...environment },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdoutBuffer, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
	]);
	const stdoutBytes = new Uint8Array(stdoutBuffer);
	return { exitCode, stdout: new TextDecoder().decode(stdoutBytes), stdoutBytes, stderr };
}

test("top-level help lists explicit authentication commands", async () => {
	const result = await run(["--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("login|logout|ls");
	expect(result.stdout).toContain("Only 'poof login' opens a browser");
	expect(result.stderr).toBe("");
});

test("login refuses non-TTY execution unless --no-open is explicit", async () => {
	const result = await run(["login"]);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("pass --no-open");
	expect(result.stderr).not.toContain("Authorize poof");
});

test("--no-open bypasses the TTY guard without opening a browser", async () => {
	const result = await run(["login", "--no-open"], { POOF_URL: "https://127.0.0.1:1" });
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).not.toContain("login requires a terminal");
	expect(result.stderr).not.toContain("Authorize poof");
});

test("login help documents --no-open", async () => {
	const result = await run(["login", "--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("--no-open");
});

test("push and update upload original bytes for every file extension", async () => {
	const uploads: { path: string; filename: string; bytes: number[]; kind: string | File | null }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const form = await request.formData();
			const file = form.get("file") as File;
			uploads.push({
				path: new URL(request.url).pathname,
				filename: file.name,
				bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
				kind: form.get("kind"),
			});
			return Response.json({ id: "doc", version: 2 });
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "poof-cli-files-"));
	try {
		const environment = {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		};
		for (const [filename, bytes] of [
			["source.md", [239, 187, 191, 35, 32, 65, 13, 10]],
			["unknown.bin", [0, 255, 128, 65]],
			["Dockerfile", [70, 82, 79, 77, 32, 120, 10]],
		] as const) {
			const path = join(directory, filename);
			await writeFile(path, new Uint8Array(bytes));
			for (const command of [
				["push", path],
				["update", "doc", path],
			]) {
				const result = await run(command, environment);
				expect(result.exitCode).toBe(0);
				expect(result.stderr).toBe("");
				expect(uploads.at(-1)).toMatchObject({ filename, bytes: [...bytes], kind: null });
			}
		}
		expect(uploads.map((upload) => upload.path)).toEqual([
			"/api/documents",
			"/api/documents/doc/versions",
			"/api/documents",
			"/api/documents/doc/versions",
			"/api/documents",
			"/api/documents/doc/versions",
		]);
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});

test("cat combines raw and version options and streams without adding bytes", async () => {
	const urls: string[] = [];
	const source = "\ufeff# Exact\r\n\u0000";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			urls.push(request.url);
			return new Response(source);
		},
	});
	try {
		const environment = {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		};
		const result = await run(["cat", "doc", "--raw", "--version", "2"], environment);
		expect(result.exitCode).toBe(0);
		expect(result.stdoutBytes).toEqual(new TextEncoder().encode(source));
		expect(new URL(urls[0]).searchParams.get("format")).toBe("raw");
		expect(new URL(urls[0]).searchParams.get("v")).toBe("2");
		const normal = await run(["cat", "doc"], environment);
		expect(normal.exitCode).toBe(0);
		expect(new URL(urls[1]).search).toBe("");
	} finally {
		server.stop(true);
	}
});
