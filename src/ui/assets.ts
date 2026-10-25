import { OWNER_JS, PUBLIC_JS } from "./client";
import { FONT_DATA, FONT_FILES } from "./fonts.generated";
import { OWNER_CSS, PUBLIC_CSS } from "./styles";
import { ASSET_PATH } from "./theme";

/** A file the Worker serves under ASSET_PATH. */
export interface Asset {
  type: string;
  /** Text, or base64 for binary files. */
  body: string;
  base64?: true;
}

/** FNV-1a: a cheap, synchronous fingerprint; collisions only cost a cache miss. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const ASSETS = new Map<string, Asset>();

function register(stem: string, ext: string, type: string, body: string): string {
  const name = `${stem}-${fingerprint(body)}.${ext}`;
  ASSETS.set(name, { type, body });
  return ASSET_PATH + name;
}

for (const [name, body] of FONT_DATA) ASSETS.set(name, { type: "font/woff2", body, base64: true });

/**
 * URLs of the page bundles. Names carry a content fingerprint, so a deploy that
 * changes a file changes its URL and every response can be cached for a year.
 */
export const ASSET_URLS = {
  ownerCss: register("owner", "css", "text/css; charset=utf-8", OWNER_CSS),
  ownerJs: register("owner", "js", "text/javascript; charset=utf-8", OWNER_JS),
  publicCss: register("public", "css", "text/css; charset=utf-8", PUBLIC_CSS),
  publicJs: register("public", "js", "text/javascript; charset=utf-8", PUBLIC_JS),
} as const;

/** The fonts every page uses at first paint, worth a preload. */
export const PRELOAD_FONTS = [
  ASSET_PATH + FONT_FILES["bricolage-grotesque"],
  ASSET_PATH + FONT_FILES["hanken-grotesk"],
];

export function findAsset(name: string): Asset | undefined {
  return ASSETS.get(name);
}
