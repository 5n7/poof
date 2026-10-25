import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { PAGE_CSP } from "../src/lib/http";
import { ASSET_URLS } from "../src/ui/assets";
import { FONT_FILES } from "../src/ui/fonts.generated";
import { ASSET_PATH } from "../src/ui/theme";
import { MCP_BASE, OWNER_BASE, seedDoc, seedShare } from "./helpers";

describe("GET /v/assets/:file", () => {
  it("serves every bundled font publicly, cacheable, and readable from the sandboxed frame", async () => {
    for (const name of Object.values(FONT_FILES)) {
      const res = await SELF.fetch(`${OWNER_BASE}${ASSET_PATH}${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("font/woff2");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
    }
  });

  it("serves the page bundles with their own types", async () => {
    for (const [url, type] of [
      [ASSET_URLS.ownerCss, "text/css"],
      [ASSET_URLS.publicCss, "text/css"],
      [ASSET_URLS.ownerJs, "text/javascript"],
      [ASSET_URLS.publicJs, "text/javascript"],
    ]) {
      const res = await SELF.fetch(`${OWNER_BASE}${url}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain(type);
      expect(res.headers.get("Cache-Control")).toContain("immutable");
    }
  });

  it("404s on unknown and prototype names and is not served on the MCP host", async () => {
    for (const name of ["missing.woff2", "__proto__", "constructor", "toString"]) {
      expect((await SELF.fetch(`${OWNER_BASE}${ASSET_PATH}${name}`)).status).toBe(404);
    }
    expect((await SELF.fetch(`${MCP_BASE}${ASSET_URLS.ownerJs}`)).status).toBe(404);
  });
});

describe("page bundles and CSP", () => {
  it("gives every owner page the owner bundle and a strict CSP", async () => {
    await seedDoc("doc_assets_owner");
    for (const path of ["/", "/guide", "/d/doc_assets_owner"]) {
      const res = await SELF.fetch(`${OWNER_BASE}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
      const html = await res.text();
      expect(html).toContain(ASSET_URLS.ownerJs);
      expect(html).toContain(ASSET_URLS.ownerCss);
      // Nothing inline: the CSP would block it.
      expect(html).not.toMatch(/<script>|<style>/);
    }
  });

  it("gives a share recipient only the public bundle", async () => {
    const t = (Date.now() / 1000) | 0;
    await seedDoc("doc_assets_public", { createdAt: t });
    await seedShare("s_assetspublic00000000000", "doc_assets_public", {
      createdAt: t,
      expiresAt: t + 3600,
    });
    const res = await SELF.fetch(`${OWNER_BASE}/v/s_assetspublic00000000000`);
    expect(res.headers.get("Content-Security-Policy")).toBe(PAGE_CSP);
    const html = await res.text();
    expect(html).toContain(ASSET_URLS.publicJs);
    expect(html).toContain(ASSET_URLS.publicCss);
    expect(html).not.toContain(ASSET_URLS.ownerJs);
    expect(html).not.toContain(ASSET_URLS.ownerCss);
  });
});
