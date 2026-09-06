import { type DefaultTreeAdapterTypes, parse } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

const MAX_TABLE_CELLS = 10_000;
const blockTags = new Set([
	"address",
	"article",
	"aside",
	"dd",
	"details",
	"dialog",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"header",
	"main",
	"nav",
	"p",
	"section",
	"summary",
]);
const omittedTags = new Set(["head", "script", "style", "template", "noscript"]);

function attribute(element: Element, name: string): string | undefined {
	return element.attrs.find((entry) => entry.name === name)?.value;
}

function isElement(node: Node): node is Element {
	return "tagName" in node;
}

function isHidden(element: Element): boolean {
	return (
		omittedTags.has(element.tagName) ||
		attribute(element, "hidden") !== undefined ||
		attribute(element, "aria-hidden")?.toLowerCase() === "true" ||
		/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(
			attribute(element, "style") ?? "",
		)
	);
}

function textContent(node: Node): string {
	const pending = [node];
	const text: string[] = [];
	while (pending.length) {
		const current = pending.pop()!;
		if (current.nodeName === "#text") text.push((current as DefaultTreeAdapterTypes.TextNode).value);
		else if (isElement(current) && isHidden(current)) continue;
		else if ("childNodes" in current) {
			for (let index = current.childNodes.length - 1; index >= 0; index--) pending.push(current.childNodes[index]);
		}
	}
	return text.join("");
}

function escapeText(text: string): string {
	return text.replace(/[\\`*_[\]<>#|]/g, "\\$&");
}

function fenceFor(text: string, minimum: number): string {
	const runs = text.match(/`+/g) ?? [];
	return "`".repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), minimum));
}

function wrap(content: string, marker: string): string {
	const body = content.trim();
	return body ? content.replace(body, () => `${marker}${body}${marker}`) : content;
}

function destination(value: string | undefined): string | null {
	if (value === undefined) return null;
	// Apply URL preprocessing without resolving relative destinations against the parser's base.
	// eslint-disable-next-line no-control-regex
	const normalized = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
	if (!normalized) return null;
	try {
		// URL parsing applies the browser's whitespace and control-character rules to schemes.
		const protocol = new URL(normalized, "https://poof.invalid/").protocol;
		if (["data:", "blob:", "javascript:"].includes(protocol)) return null;
	} catch {
		return null;
	}
	return normalized.replace(/[\s<>\\()]/g, (character) =>
		encodeURIComponent(character).replace(/\(/g, "%28").replace(/\)/g, "%29"),
	);
}

/** Extract readable Markdown without executing scripts or loading page resources. */
export function htmlToMarkdown(source: string): string {
	// Parsed HTML cannot contain NUL, so these markers cannot collide with source text.
	// eslint-disable-next-line no-control-regex
	const literalPattern = /\0(\d+)\0/g;
	const literals: string[] = [];
	let depth = 0;
	function literal(value: string): string {
		literals.push(value);
		return `\0${literals.length - 1}\0`;
	}
	function restoreLiterals(value: string): string {
		return value.replace(literalPattern, (_, index: string) => literals[Number(index)]);
	}
	function children(node: Node): string {
		if (!("childNodes" in node)) return "";
		const parts: string[] = [];
		let endsWithNewline = false;
		for (const child of node.childNodes) {
			const rendered = render(child);
			const next: string = endsWithNewline ? rendered.replace(/^ +/, "") : rendered;
			if (!next) continue;
			parts.push(next);
			endsWithNewline = next.endsWith("\n");
		}
		return parts.join("");
	}
	function block(content: string): string {
		return content.trim() ? `\n\n${content.trim()}\n\n` : "";
	}
	function list(element: Element): string {
		let number = Number.parseInt(attribute(element, "start") ?? "1", 10);
		if (!Number.isFinite(number)) number = 1;
		const items = element.childNodes.filter(isElement).filter((node) => node.tagName === "li" && !isHidden(node));
		return block(
			literal(
				items
					.map((item) => {
						const value = Number.parseInt(attribute(item, "value") ?? "", 10);
						if (Number.isFinite(value)) number = value;
						const marker = element.tagName === "ol" ? `${number++}. ` : "- ";
						const content = restoreLiterals(
							children(item)
								.trim()
								.replace(/\n{3,}/g, "\n\n"),
						);
						return marker + content.replace(/\n/g, `\n${" ".repeat(marker.length)}`);
					})
					.join("\n"),
			),
		);
	}
	function table(element: Element): string {
		const rows: Element[] = [];
		function collect(node: Element): void {
			for (const child of node.childNodes.filter(isElement)) {
				if (isHidden(child)) continue;
				if (child.tagName === "tr") rows.push(child);
				else if (["thead", "tbody", "tfoot"].includes(child.tagName)) collect(child);
			}
		}
		collect(element);
		const cells = rows.map((row) =>
			row.childNodes.filter(isElement).filter((cell) => ["th", "td"].includes(cell.tagName) && !isHidden(cell)),
		);
		const values = cells.map((row) =>
			row.map((cell) =>
				children(cell)
					.trim()
					.replace(literalPattern, (_, index: string) => literals[Number(index)].replace(/\|/g, "\\|"))
					.replace(/\n+/g, "<br>"),
			),
		);
		const width = values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
		if (!width) return block(children(element));
		const hasHeading = cells[0]?.some((cell) => cell.tagName === "th");
		const caption = element.childNodes.filter(isElement).find((node) => node.tagName === "caption");
		const renderedCaption = caption ? block(render(caption)) : "";
		const sourceCells = values.reduce((count, row) => count + row.length, 0);
		const outputCells = width * (values.length + (hasHeading ? 1 : 2));
		// Sparse tables must not allocate a rectangle many times larger than their source.
		if (outputCells > MAX_TABLE_CELLS || outputCells > sourceCells * 4) {
			return renderedCaption + block(literal(values.map((row) => row.join(" | ")).join("\n")));
		}
		const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
		const heading = hasHeading ? values.shift()! : [];
		return (
			renderedCaption +
			block(literal([line(heading), line(Array<string>(width).fill("---")), ...values.map(line)].join("\n")))
		);
	}
	function render(node: Node): string {
		// Keep deeply nested uploads readable without exhausting the JavaScript call stack.
		if (depth >= 128) return escapeText(textContent(node).replace(/\s+/g, " "));
		depth++;
		try {
			return renderNode(node);
		} finally {
			depth--;
		}
	}
	function renderNode(node: Node): string {
		if (node.nodeName === "#text") {
			return escapeText((node as DefaultTreeAdapterTypes.TextNode).value.replace(/\s+/g, " "));
		}
		if (!isElement(node)) return children(node);
		if (isHidden(node)) return "";
		const tag = node.tagName;
		if (tag === "pre") {
			const code = node.childNodes.find((child) => isElement(child) && child.tagName === "code");
			const classes = `${attribute(node, "class") ?? ""} ${code && isElement(code) ? (attribute(code, "class") ?? "") : ""}`;
			const language =
				classes.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? (/(?:^|\s)mermaid(?:\s|$)/.test(classes) ? "mermaid" : "");
			const content = textContent(node);
			const fence = fenceFor(content, 3);
			return block(literal(`${fence}${language}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`));
		}
		if (tag === "code" || tag === "kbd" || tag === "samp") {
			const content = textContent(node).replace(/\s+/g, " ");
			if (!content) return "";
			const fence = fenceFor(content, 1);
			const padding = /^[` ]|[` ]$/.test(content) ? " " : "";
			return literal(`${fence}${padding}${content}${padding}${fence}`);
		}
		if (tag === "ul" || tag === "ol") return list(node);
		if (tag === "table") return table(node);
		if (tag === "br") return "\n";
		if (tag === "hr") return "\n\n---\n\n";
		if (tag === "img") {
			const alt = escapeText(attribute(node, "alt") ?? "");
			const src = destination(attribute(node, "src"));
			return src ? `![${alt}](${src})` : alt;
		}
		const content = children(node);
		if (/^h[1-6]$/.test(tag)) return block(`${"#".repeat(Number(tag[1]))} ${content.trim()}`);
		if (tag === "a") {
			const href = destination(attribute(node, "href"));
			return href && content.trim() ? `[${content.trim()}](${href})` : content;
		}
		if (tag === "strong" || tag === "b") return wrap(content, "**");
		if (tag === "em" || tag === "i") return wrap(content, "*");
		if (tag === "del" || tag === "s") return wrap(content, "~~");
		if (tag === "blockquote") return block(literal(restoreLiterals(content.trim()).replace(/^/gm, "> ")));
		return blockTags.has(tag) ? block(content) : content;
	}
	return restoreLiterals(
		render(parse(source))
			.replace(/ *\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	);
}
