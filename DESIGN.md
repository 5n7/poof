# poof design

poof's interface is built around one idea: **documents and links fade out and vanish like a puff of smoke**. Everything else stays quiet so that the document, and the time it has left, carry the page.

Tokens live in `src/ui/theme.ts`, chrome styles in `src/ui/styles.ts`, and browser scripts in `src/ui/client.ts`. The rendered Markdown inside the sandboxed iframe (`src/lib/render.ts`) uses the same tokens and fonts, so the page and its frame always switch theme together.

## Color

| Token                                   | Role                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `--mist`                                | Page ground. Rows, chips, and links sit on it as translucent surfaces.                          |
| `--surface`                             | The document sheet, popovers, and the hovered row.                                              |
| `--ink`                                 | Text and the primary action.                                                                    |
| `--muted`                               | Metadata. Keeps 4.5:1 on mist.                                                                  |
| `--dusk` / `--dusk-ink` / `--dusk-wash` | The only accent. It marks anything shared, live, or about to vanish. Use `--dusk-ink` for text. |
| `--danger`                              | Destructive actions only. It is never used for expiry, so "running out" never reads as "error". |

Both themes come from `prefers-color-scheme`. Components never hard-code a color.

## Type

- **Bricolage Grotesque** (display): the wordmark, page and panel headings, and Markdown headings. Use weights 650–800 and tracking no tighter than −0.04em.
- **Hanken Grotesk** (body): everything else. Use `tabular-nums` wherever times or counts can change.
- The system monospace face is for URLs, paths, and code only.

Fonts, styles, and scripts are served by the Worker from `/v/assets/` with content-hashed names and a year of caching (`bun scripts/fonts.ts` regenerates the fonts). Access already bypasses `/v/*`, so share recipients load them without contacting a third party. A share recipient's page loads only the public bundle. Every page sends a strict `Content-Security-Policy`: no inline `<script>` or `<style>`. The only exceptions are `style` attributes (the per-row `--fade`) and `data:` images (the favicons).

## Shape

Everything is round. Pills and buttons use 999px, list rows use 22px, popovers use 18–26px, and the document sheet uses 24px. Shadows are soft and offset downward. The library has the only atmospheric layer: blurred smoke drifting in from the top right (`.smoky`).

## State and time

- The state pill reads "Shared · 18h", "Expires in 2h", or "Only you". It shows whichever of the soonest live share and the document's own lifetime ends first.
- Within the last 24 hours, a library title fades toward the surface color (`--fade`), never below 4.5:1. Metadata keeps full contrast.
- Labels count down live. When a document or link runs out on screen, it leaves the page the same way it left the server.

## Motion

There is one authored moment: **puff**. A row or link blurs out, sheds a few motes, and the gap closes (about 0.7s in total). It plays on revoke, delete, and expiry. A recipient whose link expires while they read watches the document dissolve into "This link has expired". Popovers and toasts use a short ease-out entrance. All motion collapses under `prefers-reduced-motion`.

## Components

- **Bar:** a floating pill above the document. It holds back, title (click to rename), state, version, More, and Share.
- **Panels:** Share and History are non-modal popovers (`role="dialog"`) beside their trigger and become bottom sheets under 640px. History is also in the More menu, because the version button hides on narrow screens. Rename stays a modal dialog because it guards an unsaved edit.
- **Destructive actions:** confirm inline inside the menu that offered them, not in a separate modal.
