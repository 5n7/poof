import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getLiveDocumentByShareToken, getLiveShare } from "../src/lib/db";
import { extendShare, issueShare } from "../src/lib/documents";
import { seedDoc, seedShare } from "./helpers";

const BASE = "https://poof.5n7.me";

async function upload(source: string, kind = "md", title?: string, ttl?: string) {
  const fd = new FormData();
  fd.set("file", new File([source], "test.md"), "test.md");
  fd.set("kind", kind);
  if (title) fd.set("title", title);
  if (ttl) fd.set("ttl", ttl);
  return SELF.fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
}

/** Call the share API without conflicting with the core `issueShare` import. */
async function postShare(id: string, ttl?: string) {
  return SELF.fetch(`${BASE}/api/documents/${id}/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ttl ? { ttl } : {}),
  });
}

async function postExtend(token: string, body?: unknown) {
  return SELF.fetch(`${BASE}/api/shares/${token}/extend`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function postRaw(path: string, body: string) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

const MALFORMED_TTL_BODIES = [
  '{"ttl":""}',
  '{"ttl":5}',
  '{"ttl":null}',
  '{"ttl":["1d"]}',
  '["1d"]',
  '"1d"',
  "ttl=1d",
];

const nowS = () => (Date.now() / 1000) | 0;

describe("share lifecycle through the API", () => {
  it("uploads, shares (default 1d TTL), views, revokes, and re-issues", async () => {
    const upRes = await upload("# Hello\n\nbody text", "md", "My Doc");
    expect(upRes.status).toBe(201);
    const doc = await upRes.json<{ id: string; url: string; title: string }>();
    expect(doc.title).toBe("My Doc");
    expect(doc.url).toBe(`/d/${doc.id}`);

    // Issue a share with the default TTL (1 day).
    const before = (Date.now() / 1000) | 0;
    const shRes = await postShare(doc.id);
    expect(shRes.status).toBe(201);
    const share = await shRes.json<{ token: string; expires_at: number; url: string }>();
    expect(share.token.startsWith("s_")).toBe(true);
    expect(share.url).toBe(`/v/${share.token}`);
    // Default TTL = now + 86400 (allow a couple seconds of clock drift).
    expect(share.expires_at).toBeGreaterThanOrEqual(before + 86400);
    expect(share.expires_at).toBeLessThanOrEqual(before + 86400 + 5);

    // Public viewer renders a sandboxed iframe pointing at the raw share URL.
    const vRes = await SELF.fetch(`${BASE}/v/${share.token}`);
    expect(vRes.status).toBe(200);
    const vHtml = await vRes.text();
    expect(vHtml).toContain('sandbox="allow-scripts allow-popups"');
    expect(vHtml).toContain(`/raw/${share.token}`);
    expect(vHtml).not.toContain("allow-same-origin");

    // Raw share endpoint serves the rendered document.
    const rawRes = await SELF.fetch(`${BASE}/raw/${share.token}`);
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toContain("<h1>Hello</h1>");

    // Revocation makes both /v and /raw return 404 immediately.
    const revRes = await SELF.fetch(`${BASE}/api/shares/${share.token}`, { method: "DELETE" });
    expect(revRes.status).toBe(200);
    expect(await revRes.json()).toEqual({ revoked: true });

    const vAfter = await SELF.fetch(`${BASE}/v/${share.token}`);
    expect(vAfter.status).toBe(404);
    expect(await vAfter.text()).toBe("Not Found");
    const rawAfter = await SELF.fetch(`${BASE}/raw/${share.token}`);
    expect(rawAfter.status).toBe(404);

    // Re-issuing a new share for the same document works.
    const reRes = await postShare(doc.id, "1h");
    expect(reRes.status).toBe(201);
    const reShare = await reRes.json<{ token: string }>();
    const reView = await SELF.fetch(`${BASE}/raw/${reShare.token}`);
    expect(reView.status).toBe(200);
  });

  it("lists only active shares (excludes revoked and expired)", async () => {
    const up = await upload("# List test", "md");
    const doc = await up.json<{ id: string; title: string }>();
    // With no supplied title, the document heading becomes the title.
    expect(doc.title).toBe("List test");

    const active = await (await postShare(doc.id, "1d")).json<{ token: string }>();
    const revoked = await (await postShare(doc.id, "1d")).json<{ token: string }>();
    await SELF.fetch(`${BASE}/api/shares/${revoked.token}`, { method: "DELETE" });

    // Seed an already-expired share directly.
    const t = (Date.now() / 1000) | 0;
    await seedShare("s_expiredlisttest0000000", doc.id, { createdAt: t, expiresAt: t - 10 });

    const listRes = await SELF.fetch(`${BASE}/api/documents/${doc.id}/shares`);
    const { shares } = await listRes.json<{ shares: { token: string }[] }>();
    const tokens = shares.map((s) => s.token);
    expect(tokens).toContain(active.token);
    expect(tokens).not.toContain(revoked.token);
    expect(tokens).not.toContain("s_expiredlisttest0000000");
  });

  it("deletes the R2 blob and invalidates the share token", async () => {
    const up = await upload("# Cascade", "md");
    const doc = await up.json<{ id: string; title: string }>();
    // With no supplied title, the document heading becomes the title.
    expect(doc.title).toBe("Cascade");
    const share = await (await postShare(doc.id)).json<{ token: string }>();
    const r2Key = `doc/${doc.id}/v1.html`;

    expect(await env.BLOBS.get(r2Key)).not.toBeNull();

    const delRes = await SELF.fetch(`${BASE}/api/documents/${doc.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    // Blob removed and share token no longer resolves.
    expect(await env.BLOBS.get(r2Key)).toBeNull();
    const rawRes = await SELF.fetch(`${BASE}/raw/${share.token}`);
    expect(rawRes.status).toBe(404);

    // Second delete of the same id is a 404.
    const delAgain = await SELF.fetch(`${BASE}/api/documents/${doc.id}`, { method: "DELETE" });
    expect(delAgain.status).toBe(404);
  });

  it("rejects uploads over 10 MiB with 413", async () => {
    const tooBig = new Uint8Array(10 * 1024 * 1024 + 1);
    const fd = new FormData();
    fd.set("file", new File([tooBig], "big.md"), "big.md");
    fd.set("kind", "md");
    const res = await SELF.fetch(`${BASE}/api/documents`, { method: "POST", body: fd });
    expect(res.status).toBe(413);
  });

  it("embeds a working o_ raw URL in the owner viewer page", async () => {
    const up = await upload("# Owner view\n\ncontent here", "md", "Owner Doc");
    const doc = await up.json<{ id: string }>();

    const dRes = await SELF.fetch(`${BASE}/d/${doc.id}`);
    expect(dRes.status).toBe(200);
    const dHtml = await dRes.text();
    expect(dHtml).toContain('sandbox="allow-scripts allow-popups"');

    // Extract the minted o_ token from the iframe src and fetch it.
    const match = dHtml.match(/<iframe[^>]*src="\/raw\/(o_[^"]+)"/);
    expect(match).not.toBeNull();
    const oToken = match![1];
    const rawRes = await SELF.fetch(`${BASE}/raw/${oToken}`);
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toContain("<h1>Owner view</h1>");
  });
});

// When both checks fail, return 404 before validating the TTL. Returning 400
// would reveal that the document id exists. Test the order through the API and
// in `issueShare` below.
describe("refusing to issue a share through the API", () => {
  it("answers 404 for an unknown id even when the ttl is invalid too", async () => {
    const res = await postShare("no_such_document", "1y");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  it("answers 404 for an unknown id with a valid ttl", async () => {
    expect((await postShare("no_such_document", "1d")).status).toBe(404);
  });

  it("answers 400 for an invalid ttl on a live document", async () => {
    const doc = await (await upload("# Bad ttl", "md")).json<{ id: string }>();

    const res = await postShare(doc.id, "1y");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid ttl" });
  });

  it("answers 400 for a malformed ttl or body on a live document", async () => {
    const doc = await (await upload("# Malformed ttl", "md")).json<{ id: string }>();

    for (const body of MALFORMED_TTL_BODIES) {
      const res = await postRaw(`/api/documents/${doc.id}/shares`, body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid ttl" });
    }
  });

  it("answers 404 for an unknown id even when the body is malformed", async () => {
    for (const body of MALFORMED_TTL_BODIES) {
      expect((await postRaw("/api/documents/no_such_document/shares", body)).status, body).toBe(
        404,
      );
    }
  });

  it("treats an empty body as no ttl at all, i.e. the 1d default", async () => {
    const doc = await (await upload("# No body", "md")).json<{ id: string }>();

    const before = (Date.now() / 1000) | 0;
    const res = await SELF.fetch(`${BASE}/api/documents/${doc.id}/shares`, { method: "POST" });
    expect(res.status).toBe(201);
    const share = await res.json<{ expires_at: number }>();
    expect(share.expires_at).toBeGreaterThanOrEqual(before + 86400);
    expect(share.expires_at).toBeLessThanOrEqual(before + 86400 + 5);
  });
});

// Test the core rule from SPEC §11.5 that shares require a live document.
describe("issueShare", () => {
  const now = (Date.now() / 1000) | 0;

  it("refuses an owner-expired document and inserts nothing", async () => {
    await seedDoc("core_share_expired", { createdAt: now - 7200, expiresAt: now - 3600 });

    expect(await issueShare(env, "core_share_expired", now, "1d")).toEqual({
      ok: false,
      reason: "not-found",
    });

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM share WHERE document_id = ?")
      .bind("core_share_expired")
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("resolves the document before it parses the ttl", async () => {
    await seedDoc("core_share_live", { createdAt: now });

    // An unknown id with a bad TTL returns "not-found". A live id with the same
    // TTL returns "invalid-ttl", proving the result depends on check order.
    expect(await issueShare(env, "core_share_missing", now, "1y")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await issueShare(env, "core_share_live", now, "1y")).toEqual({
      ok: false,
      reason: "invalid-ttl",
    });
  });

  it("inserts the row it hands back", async () => {
    await seedDoc("core_share_ok", { createdAt: now });

    const issued = await issueShare(env, "core_share_ok", now, "1h");
    if (!issued.ok) throw new Error(`expected a share, got ${issued.reason}`);

    expect(issued.share.document_id).toBe("core_share_ok");
    expect(issued.share.expires_at).toBe(now + 3600);
    expect(await getLiveShare(env.DB, issued.share.token, now)).toEqual(issued.share);
  });
});

describe("extending a share through the API", () => {
  async function shortShare(): Promise<{ id: string; token: string; expiresAt: number }> {
    const doc = await (await upload("# Extend me", "md")).json<{ id: string }>();
    const token = `s_extend${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = nowS();
    await seedShare(token, doc.id, { createdAt: now, expiresAt: now + 600 });
    return { id: doc.id, token, expiresAt: now + 600 };
  }

  it("renews to a day from now by default and keeps the link live past its old expiry", async () => {
    const { id, token, expiresAt } = await shortShare();

    const before = nowS();
    const res = await postExtend(token);
    const after = nowS();
    expect(res.status).toBe(200);
    const body = await res.json<{ token: string; expires_at: number; url: string }>();
    expect(body).toEqual({ token, expires_at: body.expires_at, url: `/v/${token}`, renewed: true });
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 86400);
    expect(body.expires_at).toBeLessThanOrEqual(after + 86400);

    expect((await SELF.fetch(`${BASE}/v/${token}`)).status).toBe(200);
    expect(await getLiveDocumentByShareToken(env.DB, token, expiresAt + 1)).not.toBeNull();
    expect(await getLiveDocumentByShareToken(env.DB, token, body.expires_at)).toBeNull();

    const { shares } = await (
      await SELF.fetch(`${BASE}/api/documents/${id}/shares`)
    ).json<{ shares: { token: string; expires_at: number }[] }>();
    expect(shares.find((s) => s.token === token)?.expires_at).toBe(body.expires_at);
  });

  it("takes the ttl from the body the way issuing does", async () => {
    const { token } = await shortShare();

    const before = nowS();
    const hour = await (await postExtend(token, { ttl: "1h" })).json<{ expires_at: number }>();
    expect(hour.expires_at).toBeGreaterThanOrEqual(before + 3600);
    expect(hour.expires_at).toBeLessThanOrEqual(nowS() + 3600);

    const day = await (await postExtend(token, {})).json<{ expires_at: number }>();
    expect(day.expires_at).toBeGreaterThanOrEqual(before + 86400);
    expect(day.expires_at).toBeLessThanOrEqual(nowS() + 86400);
  });

  it("leaves a link that already lasts longer unchanged", async () => {
    const doc = await (await upload("# Long link", "md")).json<{ id: string }>();
    const expiresAt = nowS() + 2 * 86400;
    await seedShare("s_extendlonger0000000000", doc.id, { expiresAt });

    const res = await postExtend("s_extendlonger0000000000", { ttl: "1d" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ expires_at: expiresAt, renewed: false });
  });

  it("answers 400 for an unknown or malformed ttl, whatever the token", async () => {
    const { id, token, expiresAt } = await shortShare();
    await seedShare("s_extendrevoked400000000", id, {
      expiresAt: nowS() + 600,
      revoked: 1,
    });

    for (const t of [token, "s_extendrevoked400000000", "s_nosuchshare"]) {
      for (const body of ['{"ttl":"2d"}', ...MALFORMED_TTL_BODIES]) {
        const res = await postRaw(`/api/shares/${t}/extend`, body);
        expect(res.status, `${t} ${body}`).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid ttl" });
      }
    }
    expect((await getLiveShare(env.DB, token, nowS()))!.expires_at).toBe(expiresAt);
  });

  it("answers 404 for a revoked share and leaves it dead", async () => {
    const { token, expiresAt } = await shortShare();
    await SELF.fetch(`${BASE}/api/shares/${token}`, { method: "DELETE" });

    const res = await postExtend(token, { ttl: "1d" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect((await SELF.fetch(`${BASE}/v/${token}`)).status).toBe(404);
    const row = await env.DB.prepare("SELECT expires_at FROM share WHERE token = ?")
      .bind(token)
      .first<{ expires_at: number }>();
    expect(row!.expires_at).toBe(expiresAt);
  });

  it("answers 404 for an expired share instead of reviving it", async () => {
    const doc = await (await upload("# Expired link", "md")).json<{ id: string }>();
    const now = nowS();
    await seedShare("s_extendexpired000000000", doc.id, {
      createdAt: now - 20,
      expiresAt: now - 10,
    });

    expect((await postExtend("s_extendexpired000000000", { ttl: "1w" })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v/s_extendexpired000000000`)).status).toBe(404);
  });

  it("answers 404 when the share's document is owner-expired", async () => {
    const now = nowS();
    await seedDoc("extend_doc_expired", { createdAt: now - 7200, expiresAt: now - 3600 });
    await seedShare("s_extenddocexpired000000", "extend_doc_expired", {
      createdAt: now,
      expiresAt: now + 600,
    });

    expect((await postExtend("s_extenddocexpired000000", { ttl: "1d" })).status).toBe(404);
    const row = await env.DB.prepare("SELECT expires_at FROM share WHERE token = ?")
      .bind("s_extenddocexpired000000")
      .first<{ expires_at: number }>();
    expect(row!.expires_at).toBe(now + 600);
  });
});

describe("extendShare", () => {
  const now = nowS();

  it("parses the ttl before it looks up the share", async () => {
    await seedDoc("core_extend_live", { createdAt: now });
    await seedShare("s_coreextendlive00000000", "core_extend_live", { expiresAt: now + 60 });

    for (const token of ["s_coreextendmissing00000", "s_coreextendlive00000000"]) {
      expect(await extendShare(env, token, now, "1y")).toEqual({
        ok: false,
        reason: "invalid-ttl",
      });
    }
    expect(await extendShare(env, "s_coreextendmissing00000", now, "1d")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("renews to the ttl from now, not from the old expiry, and writes the row it hands back", async () => {
    await seedDoc("core_extend_ok", { createdAt: now });
    await seedShare("s_coreextendok0000000000", "core_extend_ok", { expiresAt: now + 3600 });

    const extended = await extendShare(env, "s_coreextendok0000000000", now, "1d");
    if (!extended.ok) throw new Error(`expected a share, got ${extended.reason}`);

    expect(extended.share.expires_at).toBe(now + 86400);
    expect(extended.renewed).toBe(true);
    expect(await getLiveShare(env.DB, "s_coreextendok0000000000", now)).toEqual(extended.share);
  });

  it("never shortens a link, stacks no time on a repeat, and never leaves more than a week", async () => {
    await seedDoc("core_extend_cap", { createdAt: now });
    await seedShare("s_coreextendcap000000000", "core_extend_cap", { expiresAt: now + 60 });

    const results: [end: number, renewed: boolean][] = [];
    for (const ttl of ["1w", "1w", "1d", "1h", "1w"]) {
      const extended = await extendShare(env, "s_coreextendcap000000000", now, ttl);
      if (!extended.ok) throw new Error(`expected a share, got ${extended.reason}`);
      results.push([extended.share.expires_at, extended.renewed]);
    }
    expect(results).toEqual([
      [now + 604800, true],
      [now + 604800, true],
      [now + 604800, false],
      [now + 604800, false],
      [now + 604800, true],
    ]);
  });
});
