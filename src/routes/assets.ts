import type { Context } from "hono";

import { findAsset } from "../ui/assets";

const decoded = new Map<string, Uint8Array>();

/**
 * Serve a bundled font, stylesheet, or script for `GET /v/assets/:file`.
 *
 * The files sit under `/v/` because Access already bypasses `/v/*`: a share
 * recipient loads them without credentials, and SETUP's rule of exactly two
 * bypass paths still holds. Nothing here is secret; the owner bundle is the
 * same code as the public repository. Names carry a content hash, so a response
 * never changes and is cached for a year. Unknown names get a plain 404 rather
 * than the uniform share 404: they reveal nothing.
 */
export function assetFile(c: Context): Response {
  const name = c.req.param("file") ?? "";
  const asset = findAsset(name);
  if (!asset) return c.text("Not found", 404);
  let body: string | Uint8Array = asset.body;
  if (asset.base64) {
    let bytes = decoded.get(name);
    if (!bytes) {
      bytes = Uint8Array.from(atob(asset.body), (ch) => ch.charCodeAt(0));
      decoded.set(name, bytes);
    }
    body = bytes;
  }
  return new Response(body, {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": "public, max-age=31536000, immutable",
      // The document iframe is sandboxed to an opaque origin; fonts need CORS.
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
