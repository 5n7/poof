import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loginOAuth, logoutOAuth, oauthAccessToken, oauthStatus, type AuthRuntime, type SecretStore } from "./auth";

const RESOURCE = "https://poof.example";
const ISSUER = "https://team.cloudflareaccess.com";
const temporary: string[] = [];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => (resolve = done)), resolve };
}

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class MemorySecrets implements SecretStore {
	values = new Map<string, string>();
	setCalls = 0;
	get(service: string, name: string): Promise<string | null> {
		return Promise.resolve(this.values.get(`${service}:${name}`) ?? null);
	}
	set(service: string, name: string, value: string): Promise<void> {
		this.setCalls += 1;
		this.values.set(`${service}:${name}`, value);
		return Promise.resolve();
	}
	delete(service: string, name: string): Promise<boolean> {
		return Promise.resolve(this.values.delete(`${service}:${name}`));
	}
}

interface Fixture {
	runtime: AuthRuntime;
	secrets: MemorySecrets;
	root: string;
	requests: Request[];
	timeouts: number[];
	events: string[];
	setNow(value: number): void;
	failRevocation(): void;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "poof-auth-test-"));
	temporary.push(root);
	const secrets = new MemorySecrets();
	const requests: Request[] = [];
	const timeouts: number[] = [];
	const events: string[] = [];
	let now = 1_000;
	let revocationFails = false;
	let tokenNumber = 0;
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		requests.push(request);
		if (request.url === `${RESOURCE}/`) {
			return new Response(null, {
				status: 401,
				headers: { "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE}/.well-known/resource"` },
			});
		}
		if (request.url === `${RESOURCE}/.well-known/resource`) {
			return Response.json({ resource: RESOURCE, authorization_servers: [ISSUER] });
		}
		if (request.url === `${ISSUER}/.well-known/oauth-authorization-server`) {
			return Response.json({
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				revocation_endpoint: `${ISSUER}/revoke`,
				registration_endpoint: `${ISSUER}/register`,
				grant_types_supported: ["authorization_code", "refresh_token"],
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		}
		if (request.url === `${ISSUER}/register`) {
			const body = (await request.json()) as { redirect_uris: string[] };
			return Response.json({
				client_id: `client-${requests.filter((item) => item.url === `${ISSUER}/register`).length}`,
				redirect_uris: body.redirect_uris,
				token_endpoint_auth_method: "none",
			});
		}
		if (request.url === `${ISSUER}/token`) {
			events.push("token");
			tokenNumber += 1;
			return Response.json({
				access_token: `access-${tokenNumber}`,
				refresh_token: `refresh-${tokenNumber}`,
				token_type: "bearer",
				expires_in: 900,
				resource: RESOURCE,
			});
		}
		if (request.url === `${ISSUER}/revoke`) {
			return revocationFails
				? Response.json({ error: "unavailable" }, { status: 503 })
				: new Response(null, { status: 200 });
		}
		throw new Error(`unexpected request ${request.url}`);
	}) as typeof fetch;
	let random = 0;
	const runtime: AuthRuntime = {
		fetch: fetcher,
		now: () => now,
		randomUrlSafe: () => `random${++random}`,
		listen: ({ port, timeoutMs }) => {
			timeouts.push(timeoutMs);
			let closed = false;
			return {
				port: port || 49123 + random,
				wait: () => Promise.resolve({ type: "success", code: "authorization-code", issuer: ISSUER }),
				close: () => {
					if (closed) return;
					closed = true;
					events.push("close");
				},
			};
		},
		secrets,
		files: { lockDir: join(root, "state", "locks") },
		sleep: () => Promise.resolve(),
	};
	return {
		runtime,
		secrets,
		root,
		requests,
		timeouts,
		events,
		setNow: (value) => {
			now = value;
		},
		failRevocation: () => {
			revocationFails = true;
		},
	};
}

describe("OAuth persistence", () => {
	test("stores registration and tokens in one credential-manager record", async () => {
		const f = await fixture();
		let authorization = "";
		const result = await loginOAuth(
			RESOURCE,
			{
				newClient: false,
				onAuthorization: (url) => {
					authorization = url;
				},
			},
			f.runtime,
		);
		expect(result.resource).toBe(RESOURCE);
		expect(result.replacementRevocationFailed).toBe(false);
		expect(authorization).toContain("code_challenge_method=S256");
		expect(authorization).toContain(`resource=${encodeURIComponent(RESOURCE)}`);
		const stored = JSON.parse([...f.secrets.values.values()][0]) as {
			version: number;
			registration: { resource: string; issuer: string; clientId: string };
			tokens: { accessToken: string; refreshToken: string };
		};
		expect(stored).toMatchObject({
			version: 1,
			registration: { resource: RESOURCE, issuer: ISSUER, clientId: "client-1" },
			tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
		});
		expect(f.timeouts).toEqual([300_000]);
		expect(f.events.indexOf("close")).toBeLessThan(f.events.indexOf("token"));
	});

	test("reuses one saved registration until --new-client replaces it", async () => {
		const f = await fixture();
		const options = { newClient: false, onAuthorization: () => undefined };
		await loginOAuth(RESOURCE, options, f.runtime);
		await loginOAuth(RESOURCE, options, f.runtime);
		expect(f.requests.filter((request) => request.url === `${ISSUER}/register`)).toHaveLength(1);
		await loginOAuth(RESOURCE, { ...options, newClient: true }, f.runtime);
		expect(f.requests.filter((request) => request.url === `${ISSUER}/register`)).toHaveLength(2);
	});

	test("--new-client preserves the baseline grant when authorization is denied", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		f.runtime.listen = ({ port }) => ({
			port: port || 49999,
			wait: () => Promise.resolve({ type: "error", error: "access_denied" }),
			close: () => undefined,
		});
		await expect(
			loginOAuth(RESOURCE, { newClient: true, onAuthorization: () => undefined }, f.runtime),
		).rejects.toThrow("access_denied");
		expect(await oauthAccessToken(RESOURCE, false, f.runtime)).toBe("access-1");
		expect(await oauthStatus(RESOURCE, f.runtime)).toMatchObject({ resource: RESOURCE });
	});

	test("a committed new-client login prevents an older normal login from saving tokens", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const normalCallback = deferred<{ type: "success"; code: string; issuer: string }>();
		const newClientCallback = deferred<{ type: "success"; code: string; issuer: string }>();
		const normalReady = deferred<void>();
		const newClientReady = deferred<void>();
		let listener = 0;
		f.runtime.listen = ({ port }) => {
			listener += 1;
			return {
				port: port || 49999,
				wait: () => (listener === 1 ? normalCallback.promise : newClientCallback.promise),
				close: () => undefined,
			};
		};
		const normalLogin = loginOAuth(
			RESOURCE,
			{ newClient: false, onAuthorization: () => normalReady.resolve() },
			f.runtime,
		);
		await normalReady.promise;
		const newClientLogin = loginOAuth(
			RESOURCE,
			{ newClient: true, onAuthorization: () => newClientReady.resolve() },
			f.runtime,
		);
		await newClientReady.promise;
		newClientCallback.resolve({ type: "success", code: "new-code", issuer: ISSUER });
		await expect(newClientLogin).resolves.toMatchObject({ resource: RESOURCE });
		normalCallback.resolve({ type: "success", code: "old-code", issuer: ISSUER });
		await expect(normalLogin).rejects.toThrow("registration changed");
		const stored = JSON.parse([...f.secrets.values.values()][0]) as {
			registration: { clientId: string };
		};
		expect(stored.registration.clientId).toBe("client-2");
	});

	test("strips Unicode control and format characters from callback errors", async () => {
		const f = await fixture();
		f.runtime.listen = ({ port }) => ({
			port: port || 49123,
			wait: () =>
				Promise.resolve({
					type: "error",
					error: "access_denied\nignored",
					errorDescription: "bad\u202ere\u200bquest\u0000",
				}),
			close: () => undefined,
		});
		await expect(
			loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime),
		).rejects.toThrow("access_deniedignored: badrequest");
	});

	test("rejects a stored record with a cross-origin endpoint", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const [key, raw] = [...f.secrets.values.entries()][0];
		const stored = JSON.parse(raw) as { registration: { tokenEndpoint: string } };
		stored.registration.tokenEndpoint = "https://evil.example/token";
		f.secrets.values.set(key, JSON.stringify(stored));
		await expect(oauthAccessToken(RESOURCE, false, f.runtime)).rejects.toThrow("credential");
	});

	test("strictly validates the encrypted registration binding", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const [key, raw] = [...f.secrets.values.entries()][0];
		const stored = JSON.parse(raw) as { registration: Record<string, unknown> };
		for (const [field, value] of [
			["resource", "https://other.example"],
			["issuer", "https://other.cloudflareaccess.com"],
		] as const) {
			f.secrets.values.set(
				key,
				JSON.stringify({ ...stored, registration: { ...stored.registration, [field]: value } }),
			);
			await expect(oauthAccessToken(RESOURCE, false, f.runtime)).rejects.toThrow("Stored OAuth credential is invalid");
		}
	});

	test("--new-client preserves the baseline grant when DCR or exchange fails", async () => {
		for (const failure of ["registration", "exchange"] as const) {
			const f = await fixture();
			await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
			const originalFetch = f.runtime.fetch;
			f.runtime.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				if (failure === "registration" && String(input) === `${ISSUER}/register`) {
					return Response.json({ error: "unavailable" }, { status: 503 });
				}
				if (
					failure === "exchange" &&
					String(input) === `${ISSUER}/token` &&
					init?.body instanceof URLSearchParams &&
					init.body.get("grant_type") === "authorization_code"
				) {
					return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
				}
				return originalFetch(input, init);
			}) as typeof fetch;
			await expect(
				loginOAuth(RESOURCE, { newClient: true, onAuthorization: () => undefined }, f.runtime),
			).rejects.toThrow();
			expect(await oauthAccessToken(RESOURCE, false, f.runtime)).toBe("access-1");
		}
	});

	test("a final credential write failure preserves the baseline grant", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const originalSet = f.runtime.secrets.set.bind(f.runtime.secrets);
		f.runtime.secrets.set = () => Promise.reject(new Error("keychain write failed"));
		await expect(
			loginOAuth(RESOURCE, { newClient: true, onAuthorization: () => undefined }, f.runtime),
		).rejects.toThrow("keychain write failed");
		f.runtime.secrets.set = originalSet;
		expect(await oauthAccessToken(RESOURCE, false, f.runtime)).toBe("access-1");
		expect(f.requests.filter((request) => request.url === `${ISSUER}/revoke`)).toHaveLength(0);
	});

	test("allows token rotation under the same registration before the final login commit", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const callback = deferred<{ type: "success"; code: string; issuer: string }>();
		const ready = deferred<void>();
		f.runtime.listen = ({ port }) => ({
			port,
			wait: () => callback.promise,
			close: () => undefined,
		});
		const loggingIn = loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => ready.resolve() }, f.runtime);
		await ready.promise;
		expect(await oauthAccessToken(RESOURCE, true, f.runtime)).toBe("access-2");
		callback.resolve({ type: "success", code: "new-code", issuer: ISSUER });
		await expect(loggingIn).resolves.toMatchObject({ resource: RESOURCE });
		expect(await oauthAccessToken(RESOURCE, false, f.runtime)).toBe("access-3");
	});

	test("reports old-grant revocation failure after committing a replacement client", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		f.failRevocation();
		const result = await loginOAuth(RESOURCE, { newClient: true, onAuthorization: () => undefined }, f.runtime);
		expect(result.replacementRevocationFailed).toBe(true);
		expect(await oauthAccessToken(RESOURCE, false, f.runtime)).toBe("access-2");
		const stored = JSON.parse([...f.secrets.values.values()][0]) as { registration: { clientId: string } };
		expect(stored.registration.clientId).toBe("client-2");
	});

	test("revokes an old refresh token only when replacing a different client", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		expect(f.requests.filter((request) => request.url === `${ISSUER}/revoke`)).toHaveLength(0);
		const result = await loginOAuth(RESOURCE, { newClient: true, onAuthorization: () => undefined }, f.runtime);
		expect(result.replacementRevocationFailed).toBe(false);
		const revocations = f.requests.filter((request) => request.url === `${ISSUER}/revoke`);
		expect(revocations).toHaveLength(1);
		expect(new URLSearchParams(await revocations[0].text()).get("token")).toBe("refresh-2");
	});
});

describe("OAuth refresh and logout", () => {
	test("logout waits for an in-flight refresh and preserves registration only", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const refreshStarted = deferred<void>();
		const releaseRefresh = deferred<void>();
		const originalFetch = f.runtime.fetch;
		f.runtime.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (
				String(input) === `${ISSUER}/token` &&
				init?.body instanceof URLSearchParams &&
				init.body.get("grant_type") === "refresh_token"
			) {
				refreshStarted.resolve();
				await releaseRefresh.promise;
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		f.runtime.sleep = () => new Promise((resolve) => setTimeout(resolve, 1));
		const refreshing = oauthAccessToken(RESOURCE, true, f.runtime);
		await refreshStarted.promise;
		const loggingOut = logoutOAuth(RESOURCE, f.runtime);
		releaseRefresh.resolve();
		expect(await refreshing).toBe("access-2");
		const result = await loggingOut;
		expect(result.revocationError).toBeNull();
		expect(f.secrets.values.size).toBe(1);
		expect(await oauthStatus(RESOURCE, f.runtime)).toBeNull();
		const stored = JSON.parse([...f.secrets.values.values()][0]) as { tokens?: unknown };
		expect(stored.tokens).toBeUndefined();
		const setCalls = f.secrets.setCalls;
		const repeated = await logoutOAuth(RESOURCE, f.runtime);
		expect(repeated).toEqual({ hadTokens: false, revocationError: null });
		expect(f.secrets.setCalls).toBe(setCalls);
	});

	test("refreshes once across concurrent callers and rereads after locking", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		f.setNow(1_000 + 900_000);
		const tokens = await Promise.all([
			oauthAccessToken(RESOURCE, false, f.runtime),
			oauthAccessToken(RESOURCE, false, f.runtime),
		]);
		expect(tokens).toEqual(["access-2", "access-2"]);
		expect(f.requests.filter((request) => request.url === `${ISSUER}/token`)).toHaveLength(2);
		expect(await readdir(f.runtime.files.lockDir)).toEqual([]);
	});

	test("a forced refresh reuses a token changed while waiting for the lock", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const tokens = await Promise.all([
			oauthAccessToken(RESOURCE, true, f.runtime),
			oauthAccessToken(RESOURCE, true, f.runtime),
		]);
		expect(tokens).toEqual(["access-2", "access-2"]);
		expect(f.requests.filter((request) => request.url === `${ISSUER}/token`)).toHaveLength(2);
	});

	test("does not delete an abandoned refresh lock", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const key = createHash("sha256").update(RESOURCE).digest("hex");
		await mkdir(f.runtime.files.lockDir, { recursive: true });
		const path = join(f.runtime.files.lockDir, `${key}.lock`);
		await writeFile(path, "other-process\n");
		let now = 1_000;
		f.setNow(now);
		const delays: number[] = [];
		f.runtime.sleep = (delay) => {
			delays.push(delay);
			now += 250;
			f.setNow(now);
			return Promise.resolve();
		};
		await expect(oauthAccessToken(RESOURCE, true, f.runtime)).rejects.toThrow("Timed out");
		expect(await readFile(path, "utf8")).toBe("other-process\n");
		expect(delays.slice(0, 5)).toEqual([25, 50, 100, 200, 250]);
		expect(Math.max(...delays)).toBe(250);
	});

	test("refuses to unlink a lock whose owner token changed", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		const key = createHash("sha256").update(RESOURCE).digest("hex");
		const path = join(f.runtime.files.lockDir, `${key}.lock`);
		const originalFetch = f.runtime.fetch;
		f.runtime.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === `${ISSUER}/token` && init?.body instanceof URLSearchParams) {
				await writeFile(path, "successor-owner\n");
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		await expect(oauthAccessToken(RESOURCE, true, f.runtime)).rejects.toThrow("ownership changed");
		expect(await readFile(path, "utf8")).toBe("successor-owner\n");
	});

	test("removes local tokens when remote revocation fails", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		f.failRevocation();
		const result = await logoutOAuth(RESOURCE, f.runtime);
		expect(result.hadTokens).toBe(true);
		expect(result.revocationError?.message).toContain("503");
		expect(f.secrets.values.size).toBe(1);
		expect(await oauthStatus(RESOURCE, f.runtime)).toBeNull();
	});

	test("reports no status without a stored grant", async () => {
		const f = await fixture();
		expect(await oauthStatus(RESOURCE, f.runtime)).toBeNull();
	});

	test("deletes an expired grant when refresh returns invalid_grant", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		f.setNow(1_000 + 900_000);
		const originalFetch = f.runtime.fetch;
		f.runtime.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === `${ISSUER}/token`) {
				return Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 400 });
			}
			return originalFetch(input, init);
		}) as typeof fetch;
		await expect(oauthAccessToken(RESOURCE, false, f.runtime)).rejects.toThrow("Run 'poof login'");
		expect(f.secrets.values.size).toBe(1);
		expect(await oauthStatus(RESOURCE, f.runtime)).toBeNull();
	});

	test("does not replace a saved client implicitly when its port is occupied", async () => {
		const f = await fixture();
		await loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime);
		f.runtime.listen = () => {
			const error = new Error("occupied") as NodeJS.ErrnoException;
			error.code = "EADDRINUSE";
			throw error;
		};
		await expect(
			loginOAuth(RESOURCE, { newClient: false, onAuthorization: () => undefined }, f.runtime),
		).rejects.toThrow("--new-client");
	});

	test("reports OS credential manager failures without a file fallback", async () => {
		const f = await fixture();
		f.runtime.secrets.get = () => Promise.reject(new Error("keychain locked"));
		await expect(oauthStatus(RESOURCE, f.runtime)).rejects.toThrow("OS credential manager");
	});

	test("logout surfaces credential-manager read errors after attempting deletion", async () => {
		const f = await fixture();
		f.runtime.secrets.get = () => Promise.reject(new Error("keychain locked"));
		const result = await logoutOAuth(RESOURCE, f.runtime);
		expect(result.revocationError?.message).toContain("OS credential manager");
		expect(result.hadTokens).toBe(false);
	});

	test("logout detects and deletes any corrupt credential record", async () => {
		for (const raw of ["{corrupt-json", JSON.stringify({ version: 1, registration: null })]) {
			const f = await fixture();
			const secretKey = `me.5n7.poof.oauth:${createHash("sha256").update(RESOURCE).digest("hex")}`;
			f.secrets.values.set(secretKey, raw);

			const result = await logoutOAuth(RESOURCE, f.runtime);
			expect(result.hadTokens).toBe(true);
			expect(result.revocationError?.message).toContain("credential");
			expect(f.secrets.values.size).toBe(0);
		}
	});
});
