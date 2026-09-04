import { SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import worker from "../src/index";
import { MCP_BASE, MCP_CALL, envWith, seedDoc, seedShare } from "./helpers";

const BASE = "https://poof.5n7.me";
// Neither OWNER_HOST nor MCP_HOST, so the Worker should serve it nothing at all.
const STRANGER = "https://poof-staging.example";

const DOC_ID = "hosts_doc";
const SHARE_TOKEN = "s_hostsshare000000000000";

beforeAll(async () => {
	await seedDoc(DOC_ID, { title: "hosts doc", body: "<html><body>hosts doc</body></html>" });
	await seedShare(SHARE_TOKEN, DOC_ID, { expiresAt: ((Date.now() / 1000) | 0) + 3600 });
});

// The share token below is live, so a 404 from these paths is the host boundary
// and not an expired or revoked token. The owner-host assertions further down
// prove the same token resolves to 200 where it should.
describe("the MCP host serves the MCP endpoint and nothing else", () => {
	it("answers POST /mcp", async () => {
		const res = await SELF.fetch(`${MCP_BASE}/mcp`, MCP_CALL);
		expect(res.status).toBe(200);
	});

	it("does not serve the library, the API, or the owner viewer", async () => {
		for (const path of ["/", "/api/documents", `/d/${DOC_ID}`, `/api/documents/${DOC_ID}/content`]) {
			const res = await SELF.fetch(`${MCP_BASE}${path}`);
			expect(res.status, path).toBe(404);
		}
	});

	it("does not serve the public share or raw paths, even with a live token", async () => {
		for (const path of [`/v/${SHARE_TOKEN}`, `/raw/${SHARE_TOKEN}`]) {
			const res = await SELF.fetch(`${MCP_BASE}${path}`);
			expect(res.status, path).toBe(404);
		}
	});

	it("does not accept writes through the API", async () => {
		const res = await SELF.fetch(`${MCP_BASE}/api/documents/${DOC_ID}/shares`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ttl: "1d" }),
		});
		expect(res.status).toBe(404);
	});
});

describe("the owner host does not expose MCP", () => {
	for (const method of ["POST", "GET", "DELETE"]) {
		it(`answers ${method} /mcp with 404`, async () => {
			const res = await SELF.fetch(`${BASE}/mcp`, method === "POST" ? MCP_CALL : { method });
			// 404, not the 405 the MCP host gives: there is no endpoint here to
			// report a wrong method for.
			expect(res.status).toBe(404);
			expect(res.headers.get("Allow")).toBeNull();
		});
	}

	it("still serves the library, the API, and the public paths", async () => {
		expect((await SELF.fetch(`${BASE}/`)).status).toBe(200);
		expect((await SELF.fetch(`${BASE}/api/documents`)).status).toBe(200);
		expect((await SELF.fetch(`${BASE}/d/${DOC_ID}`)).status).toBe(200);
		expect((await SELF.fetch(`${BASE}/v/${SHARE_TOKEN}`)).status).toBe(200);

		const raw = await SELF.fetch(`${BASE}/raw/${SHARE_TOKEN}`);
		expect(raw.status).toBe(200);
		expect(await raw.text()).toContain("hosts doc");
	});
});

// `/mcp` is an exact path. Registering a client with a trailing slash gets a
// 404 rather than a working endpoint, which is the documented behavior
// (SPEC §11.1) and the reason the guards cannot be walked around.
describe("the MCP path is exact", () => {
	for (const path of ["/mcp/", "/mcp//", "/mcp/messages", "/mcpx", "/MCP", "/%2Fmcp"]) {
		it(`answers POST ${path} with 404`, async () => {
			const res = await SELF.fetch(`${MCP_BASE}${path}`, MCP_CALL);
			expect(res.status).toBe(404);
		});
	}

	// POST-only is unchanged: a stateless server offers no SSE stream to GET and
	// has no session for DELETE to terminate.
	for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
		it(`answers ${method} /mcp with 405 and Allow: POST`, async () => {
			const res = await SELF.fetch(`${MCP_BASE}/mcp`, { method });
			expect(res.status).toBe(405);
			expect(res.headers.get("Allow")).toBe("POST");
		});
	}
});

describe("hostnames the Worker does not recognize", () => {
	it("serves nothing, including live share tokens", async () => {
		for (const path of ["/", "/mcp", "/api/documents", `/v/${SHARE_TOKEN}`, `/raw/${SHARE_TOKEN}`]) {
			const res = await SELF.fetch(`${STRANGER}${path}`, path === "/mcp" ? MCP_CALL : undefined);
			expect(res.status, path).toBe(404);
		}
	});
});

// Three spellings name the same host and differ as strings: case, the silent
// trailing root label, and an explicit default port. All three have to
// canonicalize, on the request side and in the configured vars alike.
describe("request hosts canonicalize", () => {
	const spellings: [label: string, url: string][] = [
		["uppercase", "https://MCP.POOF.5N7.ME/mcp"],
		["a trailing root label", "https://mcp.poof.5n7.me./mcp"],
		["an explicit :443", "https://mcp.poof.5n7.me:443/mcp"],
		["all three at once", "https://MCP.POOF.5N7.ME.:443/mcp"],
	];

	for (const [label, url] of spellings) {
		it(`routes the MCP host spelled with ${label}`, async () => {
			expect((await SELF.fetch(url, MCP_CALL)).status).toBe(200);
		});
	}

	it("routes the owner host through the same spellings", async () => {
		for (const url of ["https://POOF.5N7.ME/", "https://poof.5n7.me./", "https://poof.5n7.me:443/"]) {
			expect((await SELF.fetch(url)).status, url).toBe(200);
		}
	});

	// A non-default port still distinguishes, which is what keeps localhost:8787
	// and 127.0.0.1:8787 two surfaces under `wrangler dev`.
	it("keeps a non-default port significant", async () => {
		expect((await SELF.fetch("https://mcp.poof.5n7.me:8443/mcp", MCP_CALL)).status).toBe(404);
	});
});

/** Call the Worker directly so the env and the request scheme can both vary. */
async function fetchWithHosts(url: string, hosts: { MCP_HOST?: string; OWNER_HOST?: string }, init?: RequestInit) {
	const ctx = createExecutionContext();
	const res = await worker.fetch!(new Request(url, init), envWith(hosts), ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

// The same canonicalization on the configured side. Two vars that name the same
// host in different spellings are one host, and one host cannot be two isolated
// surfaces, so the pair fails closed instead of letting the MCP endpoint answer
// on the hostname that also serves /raw and /api.
describe("semantically equal host settings fail closed", () => {
	const equivalents = ["POOF.5N7.ME", "poof.5n7.me.", "poof.5n7.me:443", "POOF.5N7.ME.:443"];

	for (const spelling of equivalents) {
		it(`refuses MCP_HOST=${spelling} against OWNER_HOST=poof.5n7.me`, async () => {
			const res = await fetchWithHosts(`${BASE}/`, { MCP_HOST: spelling });

			expect(res.status).toBe(503);
			expect(await res.text()).toBe("Service Unavailable");
		});
	}

	// Host identity must not depend on whether the request uses HTTP or HTTPS.
	it("refuses owner=example against mcp=example:443 over HTTP as well as HTTPS", async () => {
		const hosts = { MCP_HOST: "example:443", OWNER_HOST: "example" };

		for (const url of ["http://example/", "https://example/"]) {
			const res = await fetchWithHosts(url, hosts);
			expect(res.status, url).toBe(503);
			expect(await res.text()).toBe("Service Unavailable");
		}
	});

	// The mirror case: :80 is the default for HTTP, not HTTPS.
	it("refuses owner=example against mcp=example:80 over HTTP as well as HTTPS", async () => {
		const hosts = { MCP_HOST: "example:80", OWNER_HOST: "example" };

		for (const url of ["http://example/", "https://example/"]) {
			expect((await fetchWithHosts(url, hosts)).status, url).toBe(503);
		}
	});

	it("refuses a trailing-dot pair on either scheme", async () => {
		const hosts = { MCP_HOST: "example.", OWNER_HOST: "example" };

		for (const url of ["http://example/", "https://example/"]) {
			expect((await fetchWithHosts(url, hosts)).status, url).toBe(503);
		}
	});

	// A port still routes. Only the distinctness question ignores it.
	it("still routes a configured non-default port", async () => {
		const hosts = { MCP_HOST: "mcp.example:8443", OWNER_HOST: "owner.example" };

		expect((await fetchWithHosts("https://mcp.example:8443/mcp", hosts, MCP_CALL)).status).toBe(200);
		// The same hostname without that port is not the MCP surface.
		expect((await fetchWithHosts("https://mcp.example/mcp", hosts, MCP_CALL)).status).toBe(404);
	});
});

// A configured host carrying a URL delimiter is not a bare host, even when
// nothing follows it: `poof.5n7.me/` names the same authority `poof.5n7.me`
// does, so accepting it would give one host two spellings that compare unequal.
describe("configured authorities with delimiters fail closed", () => {
	const malformed = [
		"poof.5n7.me/",
		"poof.5n7.me?",
		"poof.5n7.me#",
		"poof.5n7.me/mcp",
		"poof.5n7.me?a=1",
		"poof.5n7.me#frag",
		"poof.5n7.me\\mcp",
		"https://poof.5n7.me",
		"user@poof.5n7.me",
	];

	for (const value of malformed) {
		it(`refuses OWNER_HOST=${JSON.stringify(value)}`, async () => {
			const res = await fetchWithHosts(`${BASE}/`, { OWNER_HOST: value });
			expect(res.status).toBe(503);
			expect(await res.text()).toBe("Service Unavailable");
		});
	}

	it("refuses the same values in MCP_HOST", async () => {
		for (const value of malformed) {
			expect((await fetchWithHosts(`${BASE}/`, { MCP_HOST: value })).status, value).toBe(503);
		}
	});
});

describe("the local two-hostname split still works", () => {
	// Same port, different hostnames, over HTTP. Neither is a spelling of the
	// other, so the identity check leaves them alone.
	it("keeps localhost:8787 and 127.0.0.1:8787 distinct", async () => {
		const local = { MCP_HOST: "127.0.0.1:8787", OWNER_HOST: "localhost:8787" };

		expect((await fetchWithHosts("http://127.0.0.1:8787/mcp", local, MCP_CALL)).status).toBe(200);
		expect((await fetchWithHosts("http://localhost:8787/", local)).status).toBe(200);

		// And the paths do not cross over.
		expect((await fetchWithHosts("http://localhost:8787/mcp", local, MCP_CALL)).status).toBe(404);
	});
});

// The CSRF guard travelled with the endpoint to its new hostname. A browser can
// still be driven to POST from another origin, and the MCP host is where the
// tools live.
describe("CSRF protection follows the MCP endpoint", () => {
	it("rejects a cross-site POST to the MCP host", async () => {
		const res = await SELF.fetch(`${MCP_BASE}/mcp`, {
			...MCP_CALL,
			headers: { ...MCP_CALL.headers, "Sec-Fetch-Site": "cross-site" },
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Forbidden");
	});

	it("allows same-origin and header-less POSTs", async () => {
		const same = await SELF.fetch(`${MCP_BASE}/mcp`, {
			...MCP_CALL,
			headers: { ...MCP_CALL.headers, "Sec-Fetch-Site": "same-origin" },
		});
		expect(same.status).toBe(200);

		expect((await SELF.fetch(`${MCP_BASE}/mcp`, MCP_CALL)).status).toBe(200);
	});
});
