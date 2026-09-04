import type { PoofConfig } from "./api";

export type AuthType = PoofConfig["auth"]["type"];

export function loginSelectionWarning(auth: AuthType): string | null {
	return auth === "service"
		? "Warning: OAuth will be saved, but the configured service credentials remain selected.\n"
		: null;
}

export function replacementRevocationWarning(): string {
	return "Warning: the new OAuth login was saved, but the previous refresh token could not be revoked.\n";
}

export function logoutWarning(auth: AuthType): string {
	const suffix = auth === "service" ? " Service authentication remains active." : "";
	return `Warning: OAuth logout was incomplete; the local credential update was attempted.${suffix}\n`;
}

export function logoutMessage(auth: AuthType, resource: string, hadTokens: boolean): string {
	if (!hadTokens) {
		const suffix = auth === "service" ? "; service authentication remains active" : "";
		return `no saved OAuth login for ${resource}${suffix}\n`;
	}
	return auth === "service"
		? `OAuth login removed for ${resource}; service authentication remains active\n`
		: `logged out of ${resource}\n`;
}

export function oauthStatusMessage(resource: string, expiresAt: number): string {
	return `OAuth authentication is valid for ${resource}; access token expires at ${new Date(expiresAt).toISOString()}\n`;
}
