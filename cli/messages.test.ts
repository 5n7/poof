import { describe, expect, test } from "bun:test";

import {
	loginSelectionWarning,
	logoutMessage,
	logoutWarning,
	oauthStatusMessage,
	replacementRevocationWarning,
} from "./messages";

describe("authentication command messages", () => {
	test("login and logout state that service authentication remains selected", () => {
		expect(loginSelectionWarning("service")).toContain("service credentials remain selected");
		expect(logoutMessage("service", "https://poof.example", true)).toContain("service authentication remains active");
		expect(logoutMessage("service", "https://poof.example", false)).toContain("service authentication remains active");
		expect(logoutWarning("service")).toContain("Service authentication remains active");
		expect(replacementRevocationWarning()).toContain("new OAuth login was saved");
	});

	test("status identifies access-token expiry rather than grant expiry", () => {
		const message = oauthStatusMessage("https://poof.example", 0);
		expect(message).toContain("access token expires at 1970-01-01T00:00:00.000Z");
		expect(message).not.toContain("grant expires");
	});
});
