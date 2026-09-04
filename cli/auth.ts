import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	authorizationUrl,
	canonicalResource,
	defaultOAuthRuntime,
	discoverOAuth,
	exchangeCode,
	LOGIN_TIMEOUT_MS,
	oauthProtocolError,
	pkce,
	refreshGrant,
	registerClient,
	revokeGrant,
	sameOAuthDiscovery,
	sameOAuthRegistration,
	validateOAuthRegistration,
	type OAuthRegistration,
	type OAuthRuntime,
	type OAuthTokens,
} from "./oauth";

const CREDENTIAL_VERSION = 1;
const TOKEN_SERVICE = "me.5n7.poof.oauth";
const EXPIRY_SKEW_MS = 60_000;
const LOCK_TIMEOUT_MS = 20_000;
const LOCK_RETRY_INITIAL_MS = 25;
const LOCK_RETRY_MAX_MS = 250;

interface StoredCredential {
	version: 1;
	registration: OAuthRegistration;
	tokens?: OAuthTokens;
}

export interface SecretStore {
	get(service: string, name: string): Promise<string | null>;
	set(service: string, name: string, value: string): Promise<void>;
	delete(service: string, name: string): Promise<boolean>;
}

export interface AuthFiles {
	lockDir: string;
}

export interface AuthRuntime extends OAuthRuntime {
	secrets: SecretStore;
	files: AuthFiles;
	sleep(ms: number): Promise<void>;
}

export interface LoginOptions {
	newClient: boolean;
	onAuthorization(url: string): Promise<void> | void;
}

export interface AuthStatus {
	resource: string;
	expiresAt: number;
}

export interface LoginResult extends AuthStatus {
	replacementRevocationFailed: boolean;
}

function defaultFiles(): AuthFiles {
	const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
	return {
		lockDir: join(stateHome, "poof", "locks"),
	};
}

const bunSecretStore: SecretStore = {
	get: (service, name) => Bun.secrets.get({ service, name }),
	set: (service, name, value) => Bun.secrets.set({ service, name, value }),
	delete: (service, name) => Bun.secrets.delete({ service, name }),
};

export const defaultAuthRuntime: AuthRuntime = {
	...defaultOAuthRuntime,
	secrets: bunSecretStore,
	files: defaultFiles(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function resourceKey(resource: string): string {
	return createHash("sha256").update(resource).digest("hex");
}

function parseTokens(value: unknown): OAuthTokens | null {
	if (value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const tokens = value as Partial<OAuthTokens>;
	if (
		typeof tokens.accessToken !== "string" ||
		tokens.accessToken === "" ||
		typeof tokens.refreshToken !== "string" ||
		tokens.refreshToken === "" ||
		typeof tokens.expiresAt !== "number" ||
		!Number.isFinite(tokens.expiresAt)
	)
		return null;
	return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
}

function parseCredential(raw: string | null, resource: string): StoredCredential | null {
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Stored OAuth credential is corrupt. Run 'poof logout', then 'poof login'.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Stored OAuth credential is invalid. Run 'poof logout', then 'poof login'.");
	}
	const value = parsed as Partial<StoredCredential>;
	const registered = validateOAuthRegistration(value.registration, resource);
	const tokens = parseTokens(value.tokens);
	if (value.version !== CREDENTIAL_VERSION || !registered || (value.tokens !== undefined && !tokens)) {
		throw new Error("Stored OAuth credential is invalid. Run 'poof logout', then 'poof login'.");
	}
	return tokens
		? { version: CREDENTIAL_VERSION, registration: registered, tokens }
		: { version: CREDENTIAL_VERSION, registration: registered };
}

async function readRawCredential(resource: string, runtime: AuthRuntime): Promise<string | null> {
	try {
		return await runtime.secrets.get(TOKEN_SERVICE, resourceKey(resource));
	} catch (error) {
		throw new Error(`Cannot read OAuth credential from the OS credential manager: ${(error as Error).message}`, {
			cause: error,
		});
	}
}

async function loadCredential(resource: string, runtime: AuthRuntime): Promise<StoredCredential | null> {
	return parseCredential(await readRawCredential(resource, runtime), resource);
}

async function saveCredential(value: StoredCredential, runtime: AuthRuntime): Promise<void> {
	try {
		await runtime.secrets.set(TOKEN_SERVICE, resourceKey(value.registration.resource), JSON.stringify(value));
	} catch (error) {
		throw new Error(`Cannot save OAuth credential in the OS credential manager: ${(error as Error).message}`, {
			cause: error,
		});
	}
}

async function deleteCredential(resource: string, runtime: AuthRuntime): Promise<boolean> {
	try {
		return await runtime.secrets.delete(TOKEN_SERVICE, resourceKey(resource));
	} catch (error) {
		throw new Error(`Cannot delete OAuth credential from the OS credential manager: ${(error as Error).message}`, {
			cause: error,
		});
	}
}

async function withCredentialLock<T>(resource: string, runtime: AuthRuntime, work: () => Promise<T>): Promise<T> {
	await mkdir(runtime.files.lockDir, { recursive: true, mode: 0o700 });
	await chmod(runtime.files.lockDir, 0o700);
	const path = join(runtime.files.lockDir, `${resourceKey(resource)}.lock`);
	const deadline = runtime.now() + LOCK_TIMEOUT_MS;
	const ownership = `${process.pid}:${runtime.randomUrlSafe(18)}\n`;
	let retryDelay = LOCK_RETRY_INITIAL_MS;
	for (;;) {
		let handle;
		try {
			handle = await open(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (runtime.now() >= deadline) {
				throw new Error(
					`Timed out waiting for the OAuth credential lock. After confirming no poof process is running, delete '${path}' and retry.`,
					{ cause: error },
				);
			}
			const remaining = deadline - runtime.now();
			await runtime.sleep(Math.min(retryDelay, remaining));
			retryDelay = Math.min(retryDelay * 2, LOCK_RETRY_MAX_MS);
			continue;
		}
		let value: T | undefined;
		let workError: unknown;
		try {
			await handle.writeFile(ownership, "utf8");
			value = await work();
		} catch (error) {
			workError = error;
		}
		let releaseError: unknown;
		try {
			await handle.close();
			const currentOwnership = await readFile(path, "utf8").catch(() => null);
			if (currentOwnership !== ownership) {
				throw new Error(`OAuth credential lock ownership changed; refusing to delete '${path}'.`);
			}
			await unlink(path);
		} catch (error) {
			releaseError = error;
		}
		if (workError && releaseError)
			throw new AggregateError([workError, releaseError], "OAuth credential mutation and lock release both failed.");
		if (workError) throw workError;
		if (releaseError) throw releaseError;
		return value as T;
	}
}

function expiring(tokens: OAuthTokens, now: number): boolean {
	return tokens.expiresAt <= now + EXPIRY_SKEW_MS;
}

export async function oauthAccessToken(
	resourceValue: string,
	forceRefresh = false,
	runtime: AuthRuntime = defaultAuthRuntime,
): Promise<string> {
	const resource = canonicalResource(resourceValue);
	const credential = await loadCredential(resource, runtime);
	if (!credential?.tokens) throw new Error(`Not logged in to ${resource}. Run 'poof login'.`);
	const registered = credential.registration;
	const current = credential.tokens;
	if (!forceRefresh && !expiring(current, runtime.now())) return current.accessToken;

	return withCredentialLock(resource, runtime, async () => {
		const reread = await loadCredential(resource, runtime);
		if (!reread || !sameOAuthRegistration(reread.registration, registered)) {
			throw new Error("OAuth registration changed while waiting for the credential lock. Retry the command.");
		}
		if (!reread.tokens) throw new Error(`Not logged in to ${resource}. Run 'poof login'.`);
		if (forceRefresh && reread.tokens.accessToken !== current.accessToken) return reread.tokens.accessToken;
		if (!forceRefresh && !expiring(reread.tokens, runtime.now())) return reread.tokens.accessToken;
		let refreshed: OAuthTokens;
		try {
			refreshed = await refreshGrant(reread.registration, reread.tokens, runtime);
		} catch (error) {
			if (/\binvalid_grant\b/.test((error as Error).message)) {
				await saveCredential({ version: CREDENTIAL_VERSION, registration: reread.registration }, runtime);
				throw new Error(`OAuth login for ${resource} has expired. Run 'poof login'.`, { cause: error });
			}
			throw error;
		}
		await saveCredential(
			{ version: CREDENTIAL_VERSION, registration: reread.registration, tokens: refreshed },
			runtime,
		);
		return refreshed.accessToken;
	});
}

export async function loginOAuth(
	resourceValue: string,
	options: LoginOptions,
	runtime: AuthRuntime = defaultAuthRuntime,
): Promise<LoginResult> {
	const resource = canonicalResource(resourceValue);
	const discovery = await discoverOAuth(resource, runtime);
	const baseline = await loadCredential(resource, runtime);
	const reusedRegistration = options.newClient ? null : baseline?.registration;
	const callbackPath = reusedRegistration?.callbackPath ?? `/oauth/callback/${runtime.randomUrlSafe(18)}`;
	const state = runtime.randomUrlSafe(24);
	let listener;
	try {
		listener = runtime.listen({
			port: reusedRegistration?.callbackPort ?? 0,
			path: callbackPath,
			state,
			timeoutMs: LOGIN_TIMEOUT_MS,
		});
	} catch (error) {
		if (reusedRegistration) {
			throw new Error(
				`Cannot bind saved OAuth callback port ${reusedRegistration.callbackPort}. Run 'poof login --new-client'.`,
				{ cause: error },
			);
		}
		throw error;
	}

	try {
		if (reusedRegistration && !sameOAuthDiscovery(reusedRegistration, discovery)) {
			throw new Error("Stored OAuth registration no longer matches discovery. Run 'poof login --new-client'.");
		}
		const registration = reusedRegistration ?? (await registerClient(discovery, listener.port, callbackPath, runtime));
		const redirectUri = `http://127.0.0.1:${listener.port}${callbackPath}`;
		const challenge = pkce(runtime);
		const url = authorizationUrl(registration, redirectUri, state, challenge.challenge);
		await options.onAuthorization(url);
		const callback = await listener.wait();
		listener.close();
		if (callback.issuer && callback.issuer.replace(/\/$/, "") !== registration.issuer) {
			throw new Error("OAuth callback issuer does not match discovery.");
		}
		if (callback.type === "error") {
			throw oauthProtocolError(callback.error, callback.errorDescription, "authorization_failed");
		}
		const tokens = await exchangeCode(registration, redirectUri, callback.code, challenge.verifier, runtime);
		const replaced = await withCredentialLock(resource, runtime, async () => {
			const reread = await loadCredential(resource, runtime);
			if (baseline) {
				if (!reread || !sameOAuthRegistration(reread.registration, baseline.registration)) {
					throw new Error("OAuth registration changed during browser authorization. Retry 'poof login'.");
				}
			} else if (reread) {
				throw new Error("Another login created an OAuth registration. Retry 'poof login'.");
			}
			await saveCredential({ version: CREDENTIAL_VERSION, registration, tokens }, runtime);
			return reread?.tokens && reread.registration.clientId !== registration.clientId ? reread : null;
		});
		let replacementRevocationFailed = false;
		if (replaced?.tokens) {
			try {
				await revokeGrant(replaced.registration, replaced.tokens, runtime);
			} catch {
				replacementRevocationFailed = true;
			}
		}
		return {
			resource,
			expiresAt: tokens.expiresAt,
			replacementRevocationFailed,
		};
	} finally {
		listener.close();
	}
}

export async function oauthStatus(
	resourceValue: string,
	runtime: AuthRuntime = defaultAuthRuntime,
): Promise<AuthStatus | null> {
	const resource = canonicalResource(resourceValue);
	const credential = await loadCredential(resource, runtime);
	if (!credential?.tokens) return null;
	return {
		resource,
		expiresAt: credential.tokens.expiresAt,
	};
}

export async function logoutOAuth(
	resourceValue: string,
	runtime: AuthRuntime = defaultAuthRuntime,
): Promise<{ hadTokens: boolean; revocationError: Error | null }> {
	const resource = canonicalResource(resourceValue);
	return withCredentialLock(resource, runtime, async () => {
		let raw: string | null;
		try {
			raw = await readRawCredential(resource, runtime);
		} catch (error) {
			let deleted = false;
			try {
				deleted = await deleteCredential(resource, runtime);
			} catch (deleteError) {
				return {
					hadTokens: false,
					revocationError: new AggregateError([error, deleteError], "OAuth credential could not be read or deleted."),
				};
			}
			return { hadTokens: deleted, revocationError: error as Error };
		}
		if (raw === null) return { hadTokens: false, revocationError: null };

		let credential: StoredCredential;
		try {
			credential = parseCredential(raw, resource)!;
		} catch (error) {
			try {
				await deleteCredential(resource, runtime);
				return { hadTokens: true, revocationError: error as Error };
			} catch (deleteError) {
				return {
					hadTokens: true,
					revocationError: new AggregateError(
						[error, deleteError],
						"Stored OAuth credential is corrupt and could not be deleted.",
					),
				};
			}
		}
		if (!credential.tokens) return { hadTokens: false, revocationError: null };

		let revocationError: Error | null = null;
		try {
			await revokeGrant(credential.registration, credential.tokens, runtime);
		} catch (error) {
			revocationError = error as Error;
		}
		try {
			await saveCredential({ version: CREDENTIAL_VERSION, registration: credential.registration }, runtime);
		} catch (error) {
			revocationError = revocationError
				? new AggregateError(
						[revocationError, error],
						"OAuth grant revocation and local credential update both failed.",
					)
				: (error as Error);
		}
		return { hadTokens: true, revocationError };
	});
}
