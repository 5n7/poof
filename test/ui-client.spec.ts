import { describe, expect, it } from "vitest";

import { CLIENT_TIME, OWNER_JS, PUBLIC_JS } from "../src/ui/client";
import { documentState, formatRemaining } from "../src/ui/format";

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
