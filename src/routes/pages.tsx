import type { Context } from "hono";
import type { Child, FC, PropsWithChildren } from "hono/jsx";

import type { DocumentFileRow, ResolvedDocument } from "../lib/db";
import {
  getLiveDocument,
  getLiveDocumentAt,
  getLiveShare,
  listDocumentsWithShares,
  listShares,
  listVersions,
  listVersionFiles,
} from "../lib/db";
import { documentTitleState } from "../lib/documents";
import { rawFileUrl, viewerFileUrl } from "../lib/file-links";
import { originForHost } from "../lib/hosts";
import {
  applyHeaders,
  isVersionString,
  PAGE_HEADERS,
  uniform404,
  VIEWER_HEADERS,
} from "../lib/http";
import { nowSeconds } from "../lib/time";
import { mintOwnerToken } from "../lib/tokens";
import { ASSET_URLS, PRELOAD_FONTS } from "../ui/assets";
import { FAVICON_PNG, FAVICON_SVG } from "../ui/favicon";
import { documentState, fmtCreated, formatRemaining } from "../ui/format";
import { GitHubMark, Icon, Puff } from "../ui/icons";

type Ctx<P extends string = string> = Context<{ Bindings: Env }, P>;

/**
 * The page frame. `audience` picks the asset bundles: a share recipient's page
 * never loads the owner's styles or scripts.
 */
const Layout: FC<
  PropsWithChildren<{ title: string; bodyClass?: string; audience: "owner" | "public" }>
> = ({ title, bodyClass, audience, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <meta name="theme-color" content="#eceef2" media="(prefers-color-scheme: light)" />
      <meta name="theme-color" content="#13161c" media="(prefers-color-scheme: dark)" />
      <link rel="icon" type="image/png" sizes="32x32" href={FAVICON_PNG} />
      <link rel="icon" type="image/svg+xml" href={FAVICON_SVG} />
      <title>{title}</title>
      {PRELOAD_FONTS.map((href) => (
        <link rel="preload" href={href} as="font" type="font/woff2" crossorigin="anonymous" />
      ))}
      <link
        rel="stylesheet"
        href={audience === "owner" ? ASSET_URLS.ownerCss : ASSET_URLS.publicCss}
      />
      <script src={audience === "owner" ? ASSET_URLS.ownerJs : ASSET_URLS.publicJs} defer />
    </head>
    <body class={bodyClass}>
      {children}
      {audience === "owner" ? (
        <div id="toast" class="toast" role="status" aria-live="polite" popover="manual" />
      ) : null}
    </body>
  </html>
);

/** The full-window target shown while files are dragged over an owner page. */
const DropTarget: FC<{ endpoint: string; withTitle?: boolean; heading: string; note: string }> = ({
  endpoint,
  withTitle,
  heading,
  note,
}) => (
  <>
    <div
      class="drop"
      id="drop"
      hidden
      data-endpoint={endpoint}
      data-with-title={withTitle ? "1" : undefined}
    >
      <div class="drop-card">
        <Puff />
        <b>{heading}</b>
        <span>{note}</span>
      </div>
    </div>
    <input type="file" id="file" multiple hidden />
    <input type="file" id="folder" multiple webkitdirectory="" hidden />
  </>
);

/**
 * The viewer scaffold shared by every document page: a floating bar, an
 * optional notice, file chips, and the sandboxed document sheet. The sandbox
 * attribute enforces the security boundary (SPEC §6.1). Never add
 * `allow-same-origin`.
 */
const ViewerShell: FC<
  PropsWithChildren<{
    bar: Child;
    notice?: Child;
    src: string;
    files: DocumentFileRow[];
    selected: DocumentFileRow;
    base: string;
    version?: number;
    frameTitle: string;
  }>
> = ({ bar, notice, src, files, selected, base, version, frameTitle, children }) => (
  <div class="viewer">
    <header class="bar">{bar}</header>
    {notice}
    {/* A single file needs no chips, but in-document links still resolve
        through the [data-file-path] anchors, so the nav stays in the DOM. */}
    <nav class="files" aria-label="Document files" hidden={files.length < 2}>
      {files.map((file) => (
        <a
          class="file"
          href={viewerFileUrl(base, file.path, version)}
          data-file-path={file.path}
          aria-current={file.path === selected.path ? "page" : undefined}
          title={file.path}
        >
          {file.path}
        </a>
      ))}
    </nav>
    <main class="sheet">
      <iframe
        id="document-frame"
        title={frameTitle}
        class="frame"
        sandbox="allow-scripts allow-popups"
        src={`${src}?view=1`}
      />
      {children}
    </main>
  </div>
);

const DownloadLink: FC<{ src: string; path: string }> = ({ src, path }) => (
  <a
    class="btn ghost icon"
    href={`${src}?format=raw`}
    download
    data-download
    aria-label={`Download ${path}`}
    title={`Download ${path}`}
  >
    <Icon name="download" />
  </a>
);

function selectFile(c: Ctx, files: DocumentFileRow[]): DocumentFileRow | undefined {
  const asked = c.req.query("file");
  return asked === undefined ? files[0] : files.find((file) => file.path === asked);
}

/** Render the owner library for `GET /`. */
export async function libraryPage(c: Ctx) {
  const now = nowSeconds();
  const docs = await listDocumentsWithShares(c.env.DB, now);
  const titleStates = await Promise.all(docs.map(documentTitleState));
  applyHeaders(c, PAGE_HEADERS);
  return c.html(
    <Layout title="poof" bodyClass="smoky" audience="owner">
      <main class="lib">
        <header class="lib-head">
          <h1 class="wordmark">
            poof<i>.</i>
          </h1>
          <span class="sp" />
          <nav class="lib-links" aria-label="Elsewhere">
            <a class="btn ghost" href="/guide">
              <Icon name="sparkle" />
              <span class="label">
                Connect an AI assistant <span aria-hidden="true">→</span>
              </span>
            </a>
            <a
              class="btn ghost icon"
              href="https://github.com/5n7/poof"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
            >
              <GitHubMark />
            </a>
          </nav>
        </header>

        <section class="intake" aria-label="Upload">
          <Puff />
          <p>
            Drop files anywhere or paste with <kbd>⌘V</kbd>. Each upload becomes one document.
          </p>
          <div>
            <button type="button" class="btn" data-folder>
              <Icon name="folder" />
              Upload folder
            </button>
            <button type="button" class="btn primary" data-upload>
              <Icon name="upload" />
              Choose files
            </button>
          </div>
        </section>

        {docs.length ? (
          <ul class="docs">
            {docs.map((d, index) => {
              const shareExpires = d.active_share_count > 0 ? d.next_share_expires_at : null;
              const state = documentState(shareExpires, d.expires_at, now);
              return (
                <li
                  class="doc"
                  data-id={d.id}
                  data-title={d.title}
                  data-state={titleStates[index]}
                  data-fade
                  style={state.fade ? `--fade:${state.fade}` : undefined}
                >
                  <a class="doc-open" href={`/d/${d.id}`}>
                    <span class="doc-title" id={`t-${d.id}`} data-title-label>
                      {d.title}
                    </span>
                    <span class="doc-meta">
                      <span data-created={String(d.created_at)}>{fmtCreated(d.created_at)}</span>
                      {d.current_version > 1 ? ` · v${d.current_version}` : ""}
                    </span>
                  </a>
                  <button
                    type="button"
                    class={state.live ? "pill live" : "pill"}
                    data-state-pill
                    data-id={d.id}
                    data-share-expires={shareExpires ?? ""}
                    data-doc-expires={d.expires_at ?? ""}
                    aria-haspopup="dialog"
                    aria-expanded="false"
                    aria-describedby={`t-${d.id}`}
                    title="Share links"
                  >
                    {state.text}
                  </button>
                  <button
                    type="button"
                    class="btn ghost icon"
                    data-menu
                    aria-label="Document actions"
                    aria-describedby={`t-${d.id}`}
                    aria-haspopup="menu"
                    aria-expanded="false"
                  >
                    <Icon name="more" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <section class="empty">
            <Puff />
            <h2>Nothing here yet</h2>
            <p>
              Upload a file and it waits here, private, until you share it. Links you share run out
              on their own. Or <a href="/guide">connect an AI assistant</a> and let it push
              documents for you.
            </p>
          </section>
        )}
      </main>
      <DropTarget
        endpoint="/api/documents"
        withTitle
        heading="Drop to upload"
        note="Everything you drop becomes one document."
      />
    </Layout>,
  );
}

// Show a long command as shell continuation lines but copy it as one line. Each
// continued line ends in a real newline, so the text stays valid shell when
// selected by hand or read without CSS.
const CopyBlock: FC<{ lines: string[]; label: string; prompt?: boolean }> = ({
  lines,
  label,
  prompt,
}) => (
  <div class={prompt ? "cmd prompt" : "cmd"}>
    <pre class="cmd-text">
      {lines.map((line, i) => {
        const continued = i < lines.length - 1;
        return (
          <span class="cmd-line">
            {i > 0 ? "    " : ""}
            {line.split(" ").map((word, j, words) => {
              const text = continued && j === words.length - 1 ? `${word} \\` : word;
              return (
                <>
                  {j > 0 ? " " : ""}
                  {word.includes("://") ? text : <span class="cmd-word">{text}</span>}
                </>
              );
            })}
            {continued ? "\n" : ""}
          </span>
        );
      })}
    </pre>
    <button
      type="button"
      class="btn ghost icon cmd-copy"
      data-copy={lines.join(" ")}
      aria-label={label}
      title={label}
    >
      <Icon name="copy" class="icon-copy" />
      <Icon name="check" class="icon-done" />
    </button>
    <span class="cmd-copy-status visually-hidden" aria-live="polite" />
  </div>
);

/** Render the owner-only guide for connecting an MCP client. */
export function guidePage(c: Ctx) {
  const mcpOrigin = originForHost(new URL(c.req.url), c.env.MCP_HOST);
  if (mcpOrigin === null) throw new Error("MCP_HOST is missing, blank, or not a host");
  const mcpUrl = new URL("/mcp", mcpOrigin).toString();

  applyHeaders(c, PAGE_HEADERS);
  return c.html(
    <Layout title="Connect an AI assistant · poof" bodyClass="smoky" audience="owner">
      <main class="guide">
        <div class="guide-top">
          <a class="btn ghost icon" href="/" aria-label="Back to library">
            <Icon name="back" />
          </a>
          <a class="mini" href="/">
            poof<i>.</i>
          </a>
        </div>
        <h1>Connect an AI assistant</h1>
        <p class="guide-lede">
          Use poof from an MCP-capable assistant to save documents, update them, and create expiring
          share links.
        </p>

        <section>
          <h2>Server URL</h2>
          <p>Use this exact URL, with no trailing slash.</p>
          <CopyBlock lines={[mcpUrl]} label="Copy server URL" />
        </section>

        <section>
          <h2>Connect</h2>
          <p>Register the server, then log in with Cloudflare.</p>
          <h3>Claude Code</h3>
          <ol class="steps">
            <li>
              <p>Register the server.</p>
              <CopyBlock
                prompt
                lines={[
                  "claude mcp add --transport http --scope user",
                  "--callback-port 3119",
                  `poof ${mcpUrl}`,
                ]}
                label="Copy Claude Code command"
              />
              <p class="step-note">
                Keep port 3119. This deployment's login only accepts that callback.
              </p>
            </li>
            <li>
              <p>
                Run <code>/mcp</code> in Claude Code, select <code>poof</code>, and log in.
              </p>
            </li>
          </ol>
          <h3>Codex</h3>
          <ol class="steps">
            <li>
              <p>Register the server.</p>
              <CopyBlock
                prompt
                lines={[`codex mcp add poof --url ${mcpUrl}`]}
                label="Copy Codex add command"
              />
            </li>
            <li>
              <p>Log in.</p>
              <CopyBlock prompt lines={["codex mcp login poof"]} label="Copy Codex login command" />
            </li>
          </ol>
        </section>

        <section>
          <h2>Keep links safe</h2>
          <ul>
            <li>
              <code>/d/</code> links are owner-only. Do not send them to recipients.
            </li>
            <li>
              <code>/v/</code> share links are public to anyone who has the URL. Treat them as
              secrets and use short expiry times.
            </li>
            <li>Updates and rollbacks change every live share link immediately.</li>
          </ul>
        </section>

        <section>
          <h2>Need help?</h2>
          <p>
            Read the{" "}
            <a
              href="https://github.com/5n7/poof#mcp-server"
              target="_blank"
              rel="noopener noreferrer"
            >
              MCP connection guide
            </a>{" "}
            or the{" "}
            <a
              href="https://github.com/5n7/poof/blob/main/docs/MCP-OAUTH-RUNBOOK.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              management runbook
            </a>
            .
          </p>
        </section>
      </main>
    </Layout>,
  );
}

/**
 * Render the private owner viewer for GET /d/:id with an optional `?v=N`. Mint
 * a short-lived o_ token pinned to the requested version (SPEC §6.2).
 */
export async function ownerViewerPage(c: Ctx<"/d/:id">) {
  const id = c.req.param("id");
  const now = nowSeconds();

  // A malformed `?v=` is a missing page, not an API error. Unknown versions use
  // the same uniform 404 below.
  const rawVersion = c.req.query("v");
  if (rawVersion !== undefined && !isVersionString(rawVersion)) return uniform404(c);
  const asked = rawVersion === undefined ? null : Number(rawVersion);

  const doc = await getLiveDocumentAt(c.env.DB, id, asked, now);
  if (!doc) return uniform404(c);
  // `?v=` naming the live version is the normal page. Never render the current
  // content as a read-only dead end.
  if (asked !== null && asked !== doc.current_version) return pinnedViewerPage(c, doc);

  const [shares, oToken, files, titleState] = await Promise.all([
    listShares(c.env.DB, id, now),
    mintOwnerToken(id, c.env.OWNER_TOKEN_SECRET),
    listVersionFiles(c.env.DB, id, doc.version),
    documentTitleState(doc),
  ]);
  const selected = selectFile(c, files);
  if (!selected) return uniform404(c);
  const soonest = shares.length ? Math.min(...shares.map((s) => s.expires_at)) : null;
  const state = documentState(soonest, doc.expires_at, now);
  const src = rawFileUrl(oToken, selected.path);
  applyHeaders(c, VIEWER_HEADERS);
  return c.html(
    <Layout title={doc.title} audience="owner">
      <ViewerShell
        src={src}
        files={files}
        selected={selected}
        base={`/d/${id}`}
        frameTitle={`${doc.title}: ${selected.path}`}
        bar={
          <>
            <a class="btn ghost icon" href="/" aria-label="Back to library">
              <Icon name="back" />
            </a>
            <button
              type="button"
              class="title-btn"
              id="rename-current"
              data-id={id}
              data-title={doc.title}
              data-state={titleState}
            >
              <span class="visually-hidden">Rename: </span>
              <span data-title-label>{doc.title}</span>
              <Icon name="pencil" />
            </button>
            <span class="sp" />
            <button
              type="button"
              id="share-state"
              class={state.live ? "pill live" : "pill"}
              data-state-pill
              data-id={id}
              data-share-expires={soonest ?? ""}
              data-doc-expires={doc.expires_at ?? ""}
              aria-haspopup="dialog"
              aria-expanded="false"
              title="Share links"
            >
              {state.text}
            </button>
            <button
              type="button"
              id="ver-btn"
              class="btn ghost"
              data-id={id}
              aria-label={`History, version ${doc.current_version}`}
              aria-haspopup="dialog"
              aria-expanded="false"
              title="History"
            >
              {`v${doc.current_version}`}
            </button>
            <button
              type="button"
              id="more-btn"
              class="btn ghost icon"
              data-id={id}
              data-path={selected.path}
              data-download-url={`${src}?format=raw`}
              data-removable={files.length > 1 ? "1" : undefined}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded="false"
            >
              <Icon name="more" />
            </button>
            <button
              type="button"
              id="share-current"
              class="btn primary"
              data-id={id}
              data-title={doc.title}
              aria-haspopup="dialog"
              aria-expanded="false"
            >
              <Icon name="link" />
              Share
            </button>
          </>
        }
      />
      <DropTarget
        endpoint={`/api/documents/${id}/versions`}
        heading="Add or update files"
        note="Files with the same path are replaced. Every other file stays."
      />
    </Layout>,
  );
}

/**
 * The `?v=N` branch of the owner viewer: a past version, read-only. No Share
 * button (shares always serve the current version, so offering one here would
 * read as "they can see v2") and no uploader (there is no branching model, so
 * "drop a file while looking at v2" has no meaning).
 */
async function pinnedViewerPage(c: Ctx<"/d/:id">, doc: ResolvedDocument) {
  const [versions, oToken, files] = await Promise.all([
    listVersions(c.env.DB, doc.id),
    mintOwnerToken(doc.id, c.env.OWNER_TOKEN_SECRET, 600, doc.version),
    listVersionFiles(c.env.DB, doc.id, doc.version),
  ]);
  const selected = selectFile(c, files);
  if (!selected) return uniform404(c);
  const src = rawFileUrl(oToken, selected.path);
  const title = doc.version_title ?? doc.title;
  applyHeaders(c, VIEWER_HEADERS);
  return c.html(
    <Layout title={title} audience="owner">
      <ViewerShell
        src={src}
        files={files}
        selected={selected}
        base={`/d/${doc.id}`}
        version={doc.version}
        frameTitle={`${title}, version ${doc.version}: ${selected.path}`}
        bar={
          <>
            <a class="btn ghost icon" href={`/d/${doc.id}`} aria-label="Back to current version">
              <Icon name="back" />
            </a>
            <span class="title">{title}</span>
            <span class="sp" />
            <span class="pill keep">
              v{doc.version} of {versions.length}
            </span>
            <DownloadLink src={src} path={selected.path} />
          </>
        }
        notice={
          <div class="notice" role="status">
            <p>
              You are viewing version {doc.version}, read-only. Share links keep showing the current
              version.
            </p>
            <button
              type="button"
              class="btn small"
              id="ver-restore"
              data-id={doc.id}
              data-version={String(doc.version)}
            >
              <Icon name="history" />
              Restore this version
            </button>
            <a class="btn ghost small" href={`/d/${doc.id}`}>
              Back to current
            </a>
          </div>
        }
      />
    </Layout>,
  );
}

/** Render the public shared viewer for `GET /v/:token` (SPEC §12.4). */
export async function publicViewerPage(c: Ctx<"/v/:token">) {
  const token = c.req.param("token");
  const now = nowSeconds();
  const share = await getLiveShare(c.env.DB, token, now);
  if (!share) return uniform404(c);
  const doc = await getLiveDocument(c.env.DB, share.document_id, now);
  if (!doc) return uniform404(c);
  const files = await listVersionFiles(c.env.DB, doc.id, doc.version);
  const selected = selectFile(c, files);
  if (!selected) return uniform404(c);
  const src = rawFileUrl(token, selected.path);
  // A share stops working when its document expires, so count down to whichever ends first.
  const ends =
    doc.expires_at === null ? share.expires_at : Math.min(share.expires_at, doc.expires_at);

  applyHeaders(c, VIEWER_HEADERS);
  return c.html(
    <Layout title={doc.title} audience="public">
      <ViewerShell
        src={src}
        files={files}
        selected={selected}
        base={`/v/${token}`}
        frameTitle={`${doc.title}: ${selected.path}`}
        bar={
          <>
            <span class="mini" role="img" aria-label="poof">
              poof<i>.</i>
            </span>
            <span class="title">{doc.title}</span>
            <span class="sp" />
            <span class="pill live keep" data-share-expires={String(ends)}>
              Gone in {formatRemaining(ends - now)}
            </span>
            <DownloadLink src={src} path={selected.path} />
          </>
        }
      >
        <div class="gone" id="gone" hidden>
          <Puff />
          <h1 tabindex={-1}>This link has expired</h1>
          <p>Ask the person who sent it for a new one.</p>
        </div>
      </ViewerShell>
    </Layout>,
  );
}
