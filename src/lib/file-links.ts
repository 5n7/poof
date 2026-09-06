/** Encode each segment so a document path retains its directory structure. */
export function rawFileUrl(token: string, path: string): string {
	return `/raw/${token}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function viewerFileUrl(base: string, path: string, version?: number): string {
	const query = new URLSearchParams({ file: path });
	if (version !== undefined) query.set("v", String(version));
	return `${base}?${query}`;
}

/** Resolve local references within a set, leaving external URLs untouched. */
export function resolveFileLink(
	href: string,
	currentPath: string,
): { path: string; search: string; hash: string } | null {
	const reference = href.trim();
	if (
		!reference ||
		reference.startsWith("#") ||
		/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference) ||
		reference.includes("\\")
	)
		return null;
	try {
		const base = new URL(`https://document.invalid/${currentPath.split("/").map(encodeURIComponent).join("/")}`);
		const url = new URL(reference, base);
		if (url.origin !== base.origin) return null;
		const path = decodeURIComponent(url.pathname.slice(1));
		if (
			path &&
			path
				.replace(/\/$/, "")
				.split("/")
				.some((part) => !part || part === "." || part === "..")
		)
			return null;
		return { path, search: url.search, hash: url.hash };
	} catch {
		return null;
	}
}

/** The parent accepts only known file paths sent by its own sandboxed frame. */
export function fileNavigationScript(token: string, paths: string[]): string {
	const prefix = JSON.stringify(`/raw/${token}/`).replace(/</g, "\\u003c");
	const knownPaths = JSON.stringify(paths).replace(/</g, "\\u003c");
	return `<script>
document.addEventListener("click", function (event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  var link = event.target.closest && event.target.closest("a[href]");
  if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
  var url = new URL(link.href, location.href);
  // Query parameters belong to the document. Keep native navigation so the
  // viewer's file/version controls cannot discard them or turn downloads into tabs.
  if (url.search) return;
  var prefix = ${prefix};
  if (url.origin !== location.origin || !url.pathname.startsWith(prefix) || window.parent === window) return;
  var path;
  try { path = decodeURIComponent(url.pathname.slice(prefix.length)); } catch (_) { return; }
  if (!${knownPaths}.includes(path)) return;
  if (url.pathname === location.pathname && url.hash) return;
  event.preventDefault();
  window.parent.postMessage({ type: "poof:file", path: path, hash: url.hash }, "*");
});
</script>`;
}

/** Rebase uploaded HTML attributes; CSS URLs and module imports resolve natively. */
export function linkDocumentFiles(response: Response, token: string, path: string, paths: string[]): Response {
	let basePath = path;
	let externalBase = false;
	const rewriter = new HTMLRewriter()
		.on("[href], [src], [poster], [data]", {
			element(element) {
				if (externalBase) return;
				for (const attribute of ["href", "src", "poster", "data"]) {
					const value = element.getAttribute(attribute);
					if (value === null) continue;
					const target = resolveFileLink(value, basePath);
					if (element.tagName === "base" && attribute === "href") {
						if (target) basePath = target.path;
						else externalBase = true;
					}
					if (target) element.setAttribute(attribute, rawFileUrl(token, target.path) + target.search + target.hash);
				}
			},
		})
		.onDocument({
			end(end) {
				end.append(fileNavigationScript(token, paths), { html: true });
			},
		});
	return rewriter.transform(response);
}
