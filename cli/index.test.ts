import { expect, test } from "bun:test";

async function run(
	args: string[],
	environment: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, "cli/index.ts", ...args], {
		cwd: `${import.meta.dir}/..`,
		env: { ...process.env, POOF_URL: "https://poof.example", ...environment },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
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
