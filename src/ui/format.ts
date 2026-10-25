const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * created_at (epoch seconds) → "Jul 21, 14:02" (en-US short month, 24h, UTC).
 * The worker has no viewer timezone, so this is the no-JS fallback: the client
 * rewrites `[data-created]` to the browser's local zone on load.
 */
export function fmtCreated(sec: number): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${hh}:${mm}`;
}

/**
 * seconds-until → "Nd" (>=48h), "Nh" (>=1h), else "Nm" (floored, min 0m).
 * The browser copy is `fmtLeft` in src/ui/client.ts; test/ui-client.spec.ts
 * checks that both agree.
 */
export function formatRemaining(secondsUntil: number): string {
  if (secondsUntil >= 172800) return `${Math.floor(secondsUntil / 86400)}d`;
  if (secondsUntil >= 3600) return `${Math.floor(secondsUntil / 3600)}h`;
  return `${Math.max(0, Math.floor(secondsUntil / 60))}m`;
}

export interface DocumentState {
  text: string;
  live: boolean;
  /** 0 when nothing ends within a day, rising to 1 at the moment it ends. */
  fade: number;
}

/**
 * What a document's state pill says. Whichever ends first wins: the document's
 * own lifetime or its soonest live share. The browser copy is `stateOf` in
 * src/ui/client.ts; test/ui-client.spec.ts checks that both agree.
 */
export function documentState(
  shareExpires: number | null,
  docExpires: number | null,
  now: number,
): DocumentState {
  let text = "Only you";
  let end: number | null = null;
  if (docExpires !== null && (shareExpires === null || docExpires <= shareExpires)) {
    text = `Expires in ${formatRemaining(docExpires - now)}`;
    end = docExpires;
  } else if (shareExpires !== null) {
    text = `Shared · ${formatRemaining(shareExpires - now)}`;
    end = shareExpires;
  }
  const fade = end === null ? 0 : Math.max(0, Math.min(1, 1 - (end - now) / 86400));
  return { text, live: end !== null, fade: Math.round(fade * 100) / 100 };
}
