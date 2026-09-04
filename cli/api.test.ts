import { describe, expect, test } from "bun:test";

import { api, apiCheck, apiStream, loadConfig, type ApiRuntime, type PoofConfig } from "./api";

const URL = "https://poof.example";

describe("loadConfig", () => {
	test("selects OAuth when no service pair exists", () => {
		expect(loadConfig({ POOF_URL: `${URL}/` })).toEqual({ url: URL, auth: { type: "oauth" } });
	});

	test("a complete service pair wins", () => {
		expect(
			loadConfig({
				POOF_URL: URL,
				POOF_ACCESS_CLIENT_ID: "id",
				POOF_ACCESS_CLIENT_SECRET: "secret",
			}),
		).toEqual({ url: URL, auth: { type: "service", clientId: "id", clientSecret: "secret" } });
	});

	test("service auth allows only HTTPS or literal HTTP loopback origins", () => {
		for (const url of ["http://localhost:8787/", "http://127.0.0.1:8787/"]) {
			expect(
				loadConfig({
					POOF_URL: url,
					POOF_ACCESS_CLIENT_ID: "id",
					POOF_ACCESS_CLIENT_SECRET: "secret",
				}),
			).toMatchObject({ url: url.replace(/\/$/, ""), auth: { type: "service" } });
		}
		for (const url of [
			"http://poof.example",
			"http://127.0.0.2:8787",
			"http://127.1:8787",
			"http://2130706433:8787",
			"http://[::1]:8787",
		]) {
			expect(() =>
				loadConfig({
					POOF_URL: url,
					POOF_ACCESS_CLIENT_ID: "id",
					POOF_ACCESS_CLIENT_SECRET: "secret",
				}),
			).toThrow("HTTPS origin");
		}
	});

	test("OAuth remains HTTPS-only even on loopback", () => {
		expect(() => loadConfig({ POOF_URL: "http://localhost:8787" })).toThrow("HTTPS");
		expect(() => loadConfig({ POOF_URL: "http://127.0.0.1:8787" })).toThrow("HTTPS");
	});

	test("rejects a partial service pair and a missing URL", () => {
		expect(() => loadConfig({ POOF_URL: URL, POOF_ACCESS_CLIENT_ID: "id" })).toThrow("must be set together");
		expect(() => loadConfig({})).toThrow("POOF_URL");
	});
});

function runtime(responses: Response[]): { value: ApiRuntime; requests: Request[]; refreshes: boolean[] } {
	const requests: Request[] = [];
	const refreshes: boolean[] = [];
	return {
		requests,
		refreshes,
		value: {
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
				return responses.shift()!;
			}) as typeof fetch,
			oauthAccessToken: (_resource, forceRefresh = false) => {
				refreshes.push(forceRefresh);
				return Promise.resolve(forceRefresh ? "fresh-token" : "old-token");
			},
		},
	};
}

const oauth: PoofConfig = { url: URL, auth: { type: "oauth" } };
const service: PoofConfig = { url: URL, auth: { type: "service", clientId: "id", clientSecret: "secret" } };

test("service auth sends only the Cloudflare service headers", async () => {
	const r = runtime([Response.json({ documents: [] })]);
	await api(
		{ url: URL, auth: { type: "service", clientId: "id", clientSecret: "secret" } },
		"GET",
		"/api/documents",
		undefined,
		r.value,
	);
	const headers = r.requests[0].headers;
	expect(headers.get("CF-Access-Client-Id")).toBe("id");
	expect(headers.get("CF-Access-Client-Secret")).toBe("secret");
	expect(headers.get("Authorization")).toBeNull();
});

test("OAuth safe reads refresh once and retry with a bearer token", async () => {
	const unauthorized = new Response(null, {
		status: 401,
		headers: { "WWW-Authenticate": "Bearer error=invalid_token" },
	});
	const r = runtime([unauthorized, Response.json({ documents: [] })]);
	await api(oauth, "GET", "/api/documents", undefined, r.value);
	expect(r.requests).toHaveLength(2);
	expect(r.requests[0].headers.get("Authorization")).toBe("Bearer old-token");
	expect(r.requests[1].headers.get("Authorization")).toBe("Bearer fresh-token");
	expect(r.refreshes).toEqual([false, true]);
});

test("OAuth writes refresh after a 401 but are never replayed", async () => {
	const unauthorized = new Response(null, {
		status: 401,
		headers: { "WWW-Authenticate": "Bearer error=invalid_token" },
	});
	const r = runtime([unauthorized]);
	await expect(api(oauth, "POST", "/api/documents", { title: "x" }, r.value)).rejects.toThrow("rerun the command");
	expect(r.requests).toHaveLength(1);
	expect(r.refreshes).toEqual([false, true]);
});

test("does not refresh or retry 403 and 5xx responses", async () => {
	for (const status of [403, 500]) {
		const r = runtime([new Response("no", { status })]);
		await expect(api(oauth, "GET", "/api/documents", undefined, r.value)).rejects.toThrow();
		expect(r.requests).toHaveLength(1);
		expect(r.refreshes).toEqual([false]);
	}
});

test("authentication diagnostics name the selected method", async () => {
	for (const [config, status, expected] of [
		[service, 302, "service pair"],
		[oauth, 302, "Managed OAuth"],
		[service, 401, "Service authentication"],
		[oauth, 401, "OAuth authentication"],
		[service, 403, "Service Auth policy"],
		[oauth, 403, "owner identity"],
	] as const) {
		const r = runtime([new Response(null, { status })]);
		await expect(api(config, "GET", "/api/documents", undefined, r.value)).rejects.toThrow(expected);
	}
});

test("apiStream returns the undecoded body", async () => {
	const r = runtime([new Response("<html>exact</html>")]);
	const body = await apiStream(oauth, "GET", "/api/documents/id/content", r.value);
	expect(await new Response(body).text()).toBe("<html>exact</html>");
});

test("apiCheck authenticates and cancels the response body", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		cancel: () => {
			cancelled = true;
		},
	});
	const r = runtime([new Response(body)]);
	await apiCheck(oauth, r.value);
	expect(cancelled).toBe(true);
});
