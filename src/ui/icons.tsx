import { raw } from "hono/html";
import type { FC } from "hono/jsx";

// One drawn icon set: 20px grid, 1.6 stroke, round joins. The same path data
// feeds server-rendered JSX and the client script, so both draw identical marks.
const ICON_PATHS = {
  back: "M12 4.5 6.5 10l5.5 5.5",
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  close: "M5.5 5.5l9 9m0-9-9 9",
  copy: "M7.5 7.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1zm-2 5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1",
  download: "M10 4v9.5m0 0L6.5 10m3.5 3.5 3.5-3.5M4.5 16.5h11",
  fileMinus:
    "M11.5 3.5H6a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 6 16.5h8a1.5 1.5 0 0 0 1.5-1.5V7.5zm0 0v4h4M7.5 12h5",
  folder:
    "M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 1.8h6.2A1.5 1.5 0 0 1 17 8.3v6.2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5z",
  history: "M3.8 10a6.2 6.2 0 1 0 1.8-4.4M3.8 3.8v3.3h3.3M10 6.6V10l2.4 1.5",
  link: "M8.6 11.4a3 3 0 0 0 4.2 0l2.4-2.4A3 3 0 0 0 11 4.8l-.8.8M11.4 8.6a3 3 0 0 0-4.2 0L4.8 11A3 3 0 0 0 9 15.2l.8-.8",
  more: "M5 10h.01M10 10h.01M15 10h.01",
  pencil: "M12.6 4.4a1.6 1.6 0 0 1 2.3 0l.7.7a1.6 1.6 0 0 1 0 2.3L8 15H5v-3z",
  sparkle:
    "M10 3.5l1.4 3.9 3.9 1.4-3.9 1.4-1.4 3.9-1.4-3.9-3.9-1.4 3.9-1.4zM15.5 13.5l.6 1.5 1.4.5-1.4.5-.6 1.5-.6-1.5-1.4-.5 1.4-.5z",
  trash:
    "M4.5 6h11M8.2 6V4.6h3.6V6m-5.6 0 .6 8.9a1.6 1.6 0 0 0 1.6 1.5h3.2a1.6 1.6 0 0 0 1.6-1.5L13.8 6",
  upload:
    "M10 13.5V4m0 0L6.5 7.5M10 4l3.5 3.5M4 13v1.5A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V13",
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** The `<svg>` markup for one icon, for the client script's innerHTML. */
export function iconSvg(name: IconName): string {
  // `more` is three round dots: a wide stroke on zero-length segments.
  const width = name === "more" ? 2.6 : 1.6;
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg>`;
}

export const Icon: FC<{ name: IconName; class?: string }> = ({ name, class: cls }) => (
  <svg
    class={cls}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    stroke-width={name === "more" ? 2.6 : 1.6}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={ICON_PATHS[name]} />
  </svg>
);

export const GitHubMark: FC = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8" />
  </svg>
);

/**
 * The puff: a small cloud with the wordmark's dusk dot. Used where a page has
 * nothing else to show (empty library, drop target, an expired link).
 */
const PUFF_SVG = `<svg class="puffmark" viewBox="0 0 120 72" aria-hidden="true"><circle class="a" cx="38" cy="44" r="20"/><circle class="a" cx="62" cy="32" r="24"/><circle class="a" cx="86" cy="46" r="17"/><rect class="a" x="38" y="44" width="48" height="19"/><circle class="b" cx="56" cy="30" r="9" opacity=".7"/><circle class="c" cx="104" cy="22" r="5"/></svg>`;

export const Puff: FC = () => <>{raw(PUFF_SVG)}</>;
