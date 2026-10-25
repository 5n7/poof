import { describe, expect, it, vi } from "vitest";

import { CLIENT_TIME, OWNER_JS, PUBLIC_JS } from "../src/ui/client";
import { documentState, formatRemaining } from "../src/ui/format";
import { type FakeElement, FakePage } from "./fake-dom";

interface ClientTime {
  fmtLeft(sec: number): string;
  stateOf(
    shareExpires: number,
    docExpires: number,
    now: number,
  ): { text: string; live: boolean; fade: number };
}

// The browser copies of the time helpers, evaluated with a stub matchMedia.
const client = new Function("matchMedia", `${CLIENT_TIME}\nreturn { fmtLeft, stateOf };`)(() => ({
  matches: false,
})) as ClientTime;

const NOW = 1_800_000_000;
const H = 3600;

describe("client bundles", () => {
  it("parse as scripts", () => {
    // A duplicate top-level name or a String.raw escaping slip would make a
    // page-wide SyntaxError that nothing else catches.
    expect(() => new Function(OWNER_JS)).not.toThrow();
    expect(() => new Function(PUBLIC_JS)).not.toThrow();
  });

  it("keep owner API calls out of the public bundle", () => {
    expect(PUBLIC_JS).not.toContain("/api/");
    expect(OWNER_JS).toContain("/api/documents/");
  });
});

describe("client and server time helpers", () => {
  it("format remaining time identically", () => {
    for (const sec of [-5, 0, 59, 60, 3599, 3600, 7199, 86400, 172799, 172800, 9 * 86400]) {
      expect(client.fmtLeft(sec)).toBe(formatRemaining(sec));
    }
  });

  it("derive the same document state", () => {
    const cases: [number | null, number | null][] = [
      [null, null],
      [NOW + 18 * H, null],
      [null, NOW + 2 * H],
      [NOW + 5 * H, NOW + 2 * H],
      [NOW + 2 * H, NOW + 5 * H],
      [NOW + 3 * H, NOW + 3 * H],
      [NOW + 9 * 86400, null],
      [NOW + 60, null],
    ];
    for (const [share, doc] of cases) {
      expect(client.stateOf(share ?? 0, doc ?? 0, NOW)).toEqual(documentState(share, doc, NOW));
    }
  });
});

interface Reply {
  status: number;
  body?: unknown;
}

function ownerPage(server: (path: string, init?: RequestInit) => Reply | Promise<Reply>) {
  let ms = NOW * 1000;
  class FakeDate extends Date {
    static override now() {
      return ms;
    }
  }
  const page = new FakePage();
  const shareButton = page.createElement("button");
  shareButton.id = "share-current";
  shareButton.dataset = { id: "doc1", title: "Doc" };
  const toastRegion = page.createElement("div");
  toastRegion.id = "toast";
  page.body.append(shareButton, toastRegion);
  const toasts: string[] = [];
  Object.defineProperty(toastRegion, "textContent", {
    get: () => toasts.at(-1) ?? "",
    set: (text: string) => {
      if (text) toasts.push(text);
    },
  });
  let tick = () => {};
  const fetchSpy = vi.fn(async (path: string, init?: RequestInit) => {
    const reply = await server(path, init);
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => reply.body,
    };
  });
  new Function(
    "document",
    "window",
    "location",
    "navigator",
    "matchMedia",
    "CSS",
    "HTMLElement",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "fetch",
    "Date",
    OWNER_JS,
  )(
    page,
    { addEventListener: () => {} },
    { origin: "https://poof.5n7.me", host: "poof.5n7.me", pathname: "/d/doc1", hash: "" },
    {},
    () => ({ matches: true }),
    { escape: (value: string) => value },
    { prototype: {} },
    (callback: () => void) => callback(),
    () => {},
    (listener: () => void) => {
      tick = listener;
    },
    fetchSpy,
    FakeDate,
  );
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  const rows = () => page.querySelectorAll(".link");
  return {
    page,
    toasts,
    fetch: fetchSpy,
    rows,
    tokens: () => rows().map((row) => row.dataset.token),
    row: (token: string) => rows().find((row) => row.dataset.token === token)!,
    async open() {
      shareButton.click();
      await settled();
    },
    async press(target: FakeElement) {
      target.click();
      await settled();
    },
    async tick() {
      tick();
      await settled();
    },
    advance: (sec: number) => {
      ms += sec * 1000;
    },
  };
}

function button(scope: FakeElement, label: string): FakeElement {
  return scope.querySelectorAll("button").find((b) => b.textContent === label)!;
}

const countdown = (row: FakeElement) => row.querySelector(".link-left")!.textContent;

const LIST = "/api/documents/doc1/shares";

describe("the Share panel's link rows", () => {
  async function panelWithTwoLinks(
    answer: (path: string, init?: RequestInit) => Reply | Promise<Reply> | undefined,
  ) {
    const owner = ownerPage(async (path, init) => {
      const reply = await answer(path, init);
      if (reply) return reply;
      if (path === LIST) {
        return {
          status: 200,
          body: {
            shares: [
              { token: "s_one", expires_at: NOW + 5 * H },
              { token: "s_two", expires_at: NOW + 2 * H },
            ],
          },
        };
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
    });
    await owner.open();
    expect(owner.tokens()).toEqual(["s_one", "s_two"]);
    return owner;
  }

  const extended = (expires_at: number, renewed: boolean): Reply => ({
    status: 200,
    body: { token: "s_one", expires_at, url: "/v/s_one", renewed },
  });

  it("extends a link by the chosen time and says how long it now lasts", async () => {
    const owner = await panelWithTwoLinks((path) =>
      path === "/api/shares/s_one/extend" ? extended(NOW + 7 * 86400, true) : undefined,
    );

    await owner.press(button(owner.page.body, "1 week"));
    await owner.press(button(owner.row("s_one"), "Extend"));

    expect(owner.fetch).toHaveBeenCalledWith("/api/shares/s_one/extend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: "1w" }),
    });
    expect(owner.toasts).toEqual(["Link now lasts 1 week."]);
    expect(countdown(owner.row("s_one"))).toBe("7d left");
  });

  it("says a link already lasts longer when it was extended elsewhere first", async () => {
    const owner = await panelWithTwoLinks((path) =>
      path === "/api/shares/s_one/extend" ? extended(NOW + 7 * 86400, false) : undefined,
    );

    await owner.press(button(owner.row("s_one"), "Extend"));

    expect(owner.toasts).toEqual(["This link already lasts longer than 1 day."]);
    expect(countdown(owner.row("s_one"))).toBe("7d left");
  });

  it("drops a link that already ended and hands focus to the next row", async () => {
    const owner = await panelWithTwoLinks((path) =>
      path === "/api/shares/s_one/extend" ? { status: 404 } : undefined,
    );
    const extend = button(owner.row("s_one"), "Extend");
    extend.focus();

    await owner.press(extend);

    expect(owner.tokens()).toEqual(["s_two"]);
    expect(owner.page.activeElement).toBe(button(owner.row("s_two"), "Copy"));
    expect(owner.toasts).toEqual(["This link already ended."]);
  });

  it("removes a row once when Revoke lands while an Extend is still out", async () => {
    let extendAnswer = (_: Reply) => {};
    const owner = await panelWithTwoLinks((path, init) => {
      if (path === "/api/shares/s_one/extend") {
        return new Promise<Reply>((resolve) => (extendAnswer = resolve));
      }
      if (path === "/api/shares/s_one" && init?.method === "DELETE") return { status: 200 };
      return undefined;
    });
    const row = owner.row("s_one");

    await owner.press(button(row, "Extend"));
    await owner.press(button(row, "Revoke"));
    expect(owner.tokens()).toEqual(["s_two"]);

    extendAnswer({ status: 404 });
    await owner.tick();
    expect(owner.toasts).toEqual(["Link revoked. It now shows a 404."]);
  });
});
