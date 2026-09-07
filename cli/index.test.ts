import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(
	args: string[],
	environment: Record<string, string> = {},
	cwd = `${import.meta.dir}/..`,
): Promise<{ exitCode: number; stdout: string; stdoutBytes: Uint8Array; stderr: string }> {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
		cwd,
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

test("top-level help lists auth and keeps status at the top level", async () => {
	const result = await run(["--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("auth|cat|ls");
	expect(result.stdout).toContain("share|status|suggest-title|update");
	expect(result.stdout).toContain("Only 'poof auth login' opens a browser");
	expect(result.stderr).toBe("");
});

test("login refuses non-TTY execution unless --no-open is explicit", async () => {
	const result = await run(["auth", "login"]);
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("pass --no-open");
	expect(result.stderr).not.toContain("Authorize poof");
});

test("--no-open bypasses the TTY guard without opening a browser", async () => {
	const result = await run(["auth", "login", "--no-open"], { POOF_URL: "https://127.0.0.1:1" });
	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).not.toContain("login requires a terminal");
	expect(result.stderr).not.toContain("Authorize poof");
});

test("auth login help documents its options", async () => {
	const result = await run(["auth", "login", "--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("--no-open");
	expect(result.stdout).toContain("--new-client");
});

test("auth help lists authentication subcommands", async () => {
	const result = await run(["auth", "--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("login|logout");
	expect(result.stderr).toBe("");
});

test("auth logout help describes grant revocation", async () => {
	const result = await run(["auth", "logout", "--help"]);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("Revoke the OAuth grant");
	expect(result.stderr).toBe("");
});

for (const command of ["login", "logout"]) {
	test(`${command} is not a top-level command`, async () => {
		const result = await run([command]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(`Unknown command ${command}`);
	});
}

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
		const result = await run(["cat", "doc", "--raw", "--version", "2", "--file", "adr/001.md"], environment);
		expect(result.exitCode).toBe(0);
		expect(result.stdoutBytes).toEqual(new TextEncoder().encode(source));
		expect(new URL(urls[0]).searchParams.get("format")).toBe("raw");
		expect(new URL(urls[0]).searchParams.get("v")).toBe("2");
		expect(new URL(urls[0]).searchParams.get("file")).toBe("adr/001.md");
		const normal = await run(["cat", "doc"], environment);
		expect(normal.exitCode).toBe(0);
		expect(new URL(urls[1]).search).toBe("");
	} finally {
		server.stop(true);
	}
});

test("multi-file uploads preserve relative paths and update supports explicit deletions", async () => {
	const uploads: { paths: (string | File)[]; deletes: (string | File)[]; names: string[]; contents: string[] }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const form = await request.formData();
			const files = form.getAll("file") as File[];
			uploads.push({
				paths: form.getAll("path"),
				deletes: form.getAll("delete"),
				names: files.map((file) => file.name),
				contents: await Promise.all(files.map((file) => file.text())),
			});
			return Response.json({ id: "doc", version: 2 });
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "poof-cli-bundle-"));
	try {
		await mkdir(join(directory, "adr"));
		await writeFile(join(directory, "overview.md"), "# Overview");
		await writeFile(join(directory, "adr", "001.html"), "<h1>Decision</h1>");
		const environment = {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		};
		let result = await run(["push", join(directory, "overview.md"), join(directory, "adr", "001.html")], environment);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[0]).toEqual({
			paths: ["overview.md", "adr/001.html"],
			deletes: [],
			names: ["overview.md", "001.html"],
			contents: ["# Overview", "<h1>Decision</h1>"],
		});
		result = await run(["push", directory], environment);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[1].paths).toEqual(["adr/001.html", "overview.md"]);
		result = await run(
			[
				"update",
				"doc",
				join(directory, "adr", "001.html"),
				"--root",
				directory,
				"--delete",
				"old.md",
				"--delete=unused.html",
			],
			environment,
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[2].paths).toEqual(["adr/001.html"]);
		expect(uploads[2].deletes).toEqual(["old.md", "unused.html"]);
		result = await run(["update", "doc", "--delete", "old.md", "--delete", "unused.html"], environment);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[3].paths).toEqual([]);
		expect(uploads[3].deletes).toEqual(["old.md", "unused.html"]);
		result = await run(["update", "doc", "--delete=--old.md", "--delete=-other.md"], environment);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[4].deletes).toEqual(["--old.md", "-other.md"]);
		result = await run(["update", "doc", "--delete=old.md", "--", join(directory, "overview.md")], environment);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[5].deletes).toEqual(["old.md"]);
		expect(uploads[5].names).toEqual(["overview.md"]);
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});

test("update rejects missing deletion paths without making a request", async () => {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return Response.json({ id: "doc", version: 2 });
		},
	});
	try {
		const environment = {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		};
		for (const options of [
			["--delete"],
			["--delete="],
			["--delete", ""],
			["--delete", "--title", "Changed"],
			["--delete", "--delete=other.md"],
			["--delete", "--"],
		]) {
			const result = await run(["update", "doc", ...options], environment);
			expect(result.exitCode, JSON.stringify(options)).not.toBe(0);
			expect(result.stderr).toContain("--delete requires a non-empty path");
			expect(requests).toBe(0);
		}
	} finally {
		server.stop(true);
	}
});

test("update does not treat title or root values as deletion options", async () => {
	const uploads: { title: string | null; paths: string[]; deletes: string[] }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const form = await request.formData();
			uploads.push({
				title: form.get("title")?.toString() ?? null,
				paths: form.getAll("path").map(String),
				deletes: form.getAll("delete").map(String),
			});
			return Response.json({ id: "doc", version: 2 });
		},
	});
	const directory = await mkdtemp(join(tmpdir(), "poof-cli-option-values-"));
	try {
		const environment = {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		};
		let result = await run(["update", "doc", "--title", "--delete=keep.md", "--delete", "remove.md"], environment);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[0].title).toBe("--delete=keep.md");
		expect(uploads[0].deletes).toEqual(["remove.md"]);
		await mkdir(join(directory, "--delete=keep.md"));
		await writeFile(join(directory, "--delete=keep.md", "source.md"), "# Source");
		result = await run(
			["update", "doc", "./--delete=keep.md/source.md", "--root", "--delete=keep.md", "--delete", "remove.md"],
			environment,
			directory,
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(uploads[1].paths).toEqual(["source.md"]);
		expect(uploads[1].deletes).toEqual(["remove.md"]);
	} finally {
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
});

test("files lists a selected version without exposing storage keys", async () => {
	let requestUrl = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			requestUrl = request.url;
			return Response.json({ files: [{ path: "adr/001.md", kind: "md", media_type: "text/markdown" }] });
		},
	});
	try {
		const result = await run(["files", "doc", "--version", "2"], {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain("adr/001.md");
		expect(new URL(requestUrl).pathname).toBe("/api/documents/doc/files");
		expect(new URL(requestUrl).searchParams.get("v")).toBe("2");
	} finally {
		server.stop(true);
	}
});

test("rename reads a snapshot and changes only title metadata", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const snapshot = { id: "doc/?", title: "Original", current_version: 3, updated_at: 100, state: "a".repeat(64) };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: request.method === "GET" ? null : await request.json(),
			});
			return Response.json(request.method === "GET" ? snapshot : { ...snapshot, title: "New title", updated_at: 200 });
		},
	});
	try {
		const result = await run(["rename", snapshot.id, "--title", "New title"], {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ ...snapshot, title: "New title", updated_at: 200 });
		expect(requests).toEqual([
			{ method: "GET", path: "/api/documents/doc%2F%3F", body: null },
			{
				method: "PATCH",
				path: "/api/documents/doc%2F%3F/title",
				body: { title: "New title", expected_state: snapshot.state },
			},
		]);
	} finally {
		server.stop(true);
	}
});

test("suggest-title prints a reviewable snapshot without saving it", async () => {
	const requests: { method: string; path: string; body: unknown }[] = [];
	const suggestion = { title: "Suggested title", expected_state: "a".repeat(64) };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				method: request.method,
				path: new URL(request.url).pathname,
				body: request.method === "GET" ? null : await request.json(),
			});
			return Response.json(
				request.method === "GET"
					? { id: "doc", title: "Original", current_version: 2, state: suggestion.expected_state }
					: suggestion,
			);
		},
	});
	try {
		const result = await run(["suggest-title", "doc"], {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(suggestion);
		expect(requests).toEqual([
			{ method: "GET", path: "/api/documents/doc", body: null },
			{
				method: "POST",
				path: "/api/documents/doc/title-suggestion",
				body: { expected_state: "a".repeat(64) },
			},
		]);
	} finally {
		server.stop(true);
	}
});

test("rename preserves a reviewed suggestion's preconditions and does not retry conflicts", async () => {
	const requests: { method: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({ method: request.method, body: await request.json() });
			return Response.json({ error: "Document changed. Review the current title and try again." }, { status: 409 });
		},
	});
	try {
		const result = await run(["rename", "doc", "--title", "Reviewed title", "--expected-state", "a".repeat(64)], {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Document changed");
		expect(requests).toEqual([{ method: "PATCH", body: { title: "Reviewed title", expected_state: "a".repeat(64) } }]);
	} finally {
		server.stop(true);
	}
});

test("rename sends a compact state token when shortening a long existing title", async () => {
	let requestBody = "";
	const state = "a".repeat(64);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method === "GET")
				return Response.json({ id: "doc", title: "x".repeat(17000), current_version: 1, updated_at: 100, state });
			requestBody = await request.text();
			return Response.json({
				id: "doc",
				title: "Short title",
				current_version: 1,
				updated_at: 200,
				state: "b".repeat(64),
			});
		},
	});
	try {
		const result = await run(["rename", "doc", "--title", "Short title"], {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(JSON.parse(requestBody)).toEqual({ title: "Short title", expected_state: state });
		expect(requestBody.length).toBeLessThan(200);
	} finally {
		server.stop(true);
	}
});

test("suggest-title reports AI unavailability without blaming Access", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return request.method === "GET"
				? Response.json({ id: "doc", title: "Original", current_version: 1, state: "a".repeat(64) })
				: Response.json({ error: "AI title generation is unavailable. Try again or enter a title." }, { status: 503 });
		},
	});
	try {
		const result = await run(["suggest-title", "doc"], {
			POOF_URL: `http://127.0.0.1:${server.port}`,
			POOF_ACCESS_CLIENT_ID: "test",
			POOF_ACCESS_CLIENT_SECRET: "test",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("AI title generation is unavailable");
		expect(result.stderr).not.toContain("Access configuration");
	} finally {
		server.stop(true);
	}
});
