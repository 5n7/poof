/**
 * Name a new document when the client omits the title. Try Workers AI, then the
 * first `# ` heading, then the caller's fallback. AI failures never block an
 * upload.
 */

/** Cheapest text-generation model in the catalog that officially handles Japanese. */
const AI_TITLE_MODEL = "@cf/ibm-granite/granite-4.0-h-micro";

/** Wall-clock bound on inference. Cold model loads are documented at 1-3s. */
const AI_TITLE_TIMEOUT_MS = 2500;

/** How much of the document the model sees, taken from the start. */
const AI_TITLE_MAX_CHARS = 2000;

/** Upper bound on an accepted title, counted in code points. */
const AI_TITLE_MAX_LENGTH = 80;

/**
 * Last resort when the caller's fallback is blank. See `resolveNewTitle`.
 */
const TERMINAL_TITLE = "untitled";

// Treat this prompt as production behavior. Change it only with a title-quality
// review. Its 60-character limit leaves room below AI_TITLE_MAX_LENGTH for a
// slightly long response.
const SYSTEM_PROMPT =
	"You generate titles for documents. Reply with the title and nothing else. Use one line of at most 60 characters, " +
	"written in the same language as the document. Do not use quotation marks, Markdown, a trailing period, a preamble, " +
	"or an explanation.";

// The model returned English titles for two of three Japanese documents when
// asked to match the document's language. This prompt names Japanese directly
// and JA_ONE_SHOT gives it one example.
const SYSTEM_PROMPT_JA =
	"You generate titles for documents. Reply with the title and nothing else. Use one line of at most 60 characters. " +
	"Reply in Japanese. Do not use quotation marks, Markdown, a trailing period, a preamble, or an explanation.";

/**
 * Build both the example request and the real request in the same format.
 *
 * The <document> delimiter helps the model separate data from instructions. It
 * is not a security boundary. lib/render.ts and hono/jsx escape the title.
 */
function documentTurn(excerpt: string) {
	return { role: "user", content: `Title this document:\n\n<document>\n${excerpt}\n</document>` };
}

/**
 * A user and assistant turn give the chat model an example in the same slots as
 * the real request. The unrelated gardening example teaches output format and
 * language without steering titles toward this app's usual subjects.
 */
const JA_ONE_SHOT = [
	documentTurn(
		"ベランダのプランターで育てているミニトマトが、五月の植え付けからようやく色づきはじめた。" +
			"水やりは朝と夕方の二回で、土が湿っている日は控える。葉の裏に虫がつきやすいため、週末にまとめて確認している。",
	),
	{ role: "assistant", content: "ミニトマトの水やりと虫よけ" },
];

/**
 * Match hiragana, katakana, halfwidth katakana, and U+30FC. Unicode classifies
 * U+30FC as Script=Common, so it needs an explicit escape.
 *
 * Kanji cannot distinguish Japanese from Chinese, so the ratio excludes it.
 */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/gu;

/** The other side of the ratio. Fullwidth romaji is Script=Latin and counts. */
const LATIN = /\p{Script=Latin}/gu;

/**
 * Compare kana with Latin letters. Ignore digits, punctuation, Markdown, and
 * whitespace so number-heavy documents and URL lists do not skew the result.
 * Tests on representative documents put Japanese technical writing above 19%
 * and English documents with short Japanese quotes near 5%.
 * Bias toward false negatives. A false positive sends Japanese instructions and
 * an example with an English document. A false negative uses the production
 * default prompt.
 */
const MIN_KANA_RATIO = 0.1;

/**
 * Require at least three kana so a two-character fragment cannot choose the
 * prompt.
 */
const MIN_KANA_CHARS = 3;

/**
 * Openers that mean the model answered the request instead of performing it.
 * Such a string is never a title, so it is rejected rather than trimmed.
 *
 * Keep this narrow. "Sure" and "Of course" only count as a preamble when the
 * punctuation of one follows immediately, so `Sure Thing Inc Annual Report`
 * stays a title; and only `cannot`/`can't` count, not a bare `I can`, which is
 * an ordinary way for a title to start. Missing a preamble merely means a poor
 * title gets used, while a false positive throws a good one away.
 */
const REFUSAL_PREFIX = /^(?:(?:sure|of course|certainly|okay)\s*[,!:]|here(?:['’]s| is)\b|i\s+(?:cannot|can['’]?t)\b)/i;

/**
 * Reject titles made only of punctuation, invisible characters, or emoji. The
 * naming chain then uses the document heading or caller fallback.
 */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/** Longest first: `**` must be tried before `*`. */
const EMPHASIS_MARKERS = ["**", "__", "*", "_"];

/** Only unwrapped when the pair matches at both ends. */
const QUOTE_PAIRS: [string, string][] = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
];

/**
 * Support both `BaseAiTextGeneration` and `ChatCompletionsOutput` response
 * shapes.
 */
interface TextOutput {
	response?: unknown;
	choices?: { message?: { content?: unknown } }[];
}

/**
 * `**bold**` → `bold`, but only when the run wraps the whole string.
 *
 * `__init__` comes out as `init`, and that tradeoff is accepted.
 * CommonMark parses `__init__` as `<strong>init</strong>`, so it is
 * indistinguishable from a model returning `__Roadmap__`. Only unwrap markers
 * that surround the full title.
 */
function unwrapEmphasis(text: string): string {
	for (const marker of EMPHASIS_MARKERS) {
		if (text.length <= marker.length * 2) continue;
		if (!text.startsWith(marker) || !text.endsWith(marker)) continue;
		const inner = text.slice(marker.length, -marker.length);
		// `*a* and *b*` opens and closes with the marker without being wrapped in it.
		if (inner.includes(marker)) continue;
		return inner.trim();
	}
	return text;
}

/** One layer of matched surrounding quotes, or the string unchanged. */
function unwrapQuotes(text: string): string {
	for (const [open, close] of QUOTE_PAIRS) {
		if (text.length <= 1 || !text.startsWith(open) || !text.endsWith(close)) continue;
		const inner = text.slice(open.length, -close.length);
		// Do not unwrap titles such as `「設計」と「実装」` or `"Alpha" vs "Beta"`.
		if (inner.includes(open) || inner.includes(close)) continue;
		return inner.trim();
	}
	return text;
}

/**
 * Turn a model's raw output into a usable title, or `null` when it is not one.
 *
 * Reject long output instead of truncating it. Use only the first non-empty
 * line, so an added explanation does not become part of the title.
 *
 * Do not HTML-escape here. lib/render.ts and hono/jsx escape at render time.
 */
export function sanitizeAiTitle(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return null;

	// Reasoning models may wrap scratch text in <think> tags. Keep what
	// follows the last close tag.
	let text = raw;
	const thinkEnd = text.lastIndexOf("</think>");
	if (thinkEnd !== -1) text = text.slice(thinkEnd + "</think>".length);
	// An opener still standing here never closed. With max_tokens set to 32, this
	// usually means the answer was cut off mid-thought. There is
	// nothing after the block to keep, and the opening of a model thinking out
	// loud ("Okay, the user wants a title for…") must not become the title.
	if (/<think\b/i.test(text)) return null;

	// Control and format characters. \n survives so the line split below still
	// works and \t so the whitespace collapse below sees it as a separator instead
	// of stripping it and welding two words together. Matched by Unicode category,
	// since a literal control range in a regex is a lint error; a BOM is U+FEFF and
	// falls out with the rest of Cf.
	//
	// Cf is stripped rather than merely rejected, and for the same reason `table()`
	// in routes/mcp.ts flattens it: it is invisible, so it cannot be judged by
	// reading the title. RLO, U+202E, reverses the display direction of everything
	// after it in a library row. U+200C and
	// U+200D are the exceptions: ZWNJ is orthographically required in Persian and
	// Devanagari, and ZWJ is what holds an emoji sequence together, so dropping
	// either mangles a legitimate title instead of cleaning it.
	text = text.replace(/[\p{Cc}\p{Cf}]/gu, (ch) => ("\n\t\u200C\u200D".includes(ch) ? ch : ""));

	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
	if (lines.length === 0) return null;
	let title = lines[0];

	// A `Title:` / `タイトル:` label, either with the title on the same line or
	// (when the model put the label alone on its own line) on the next one.
	const labelled = /^(?:title|タイトル)\s*[:：]\s*(.*)$/i.exec(title);
	if (labelled) title = labelled[1].trim() || lines[1] || "";

	// A heading, bullet or numbered-list marker the model added on its own. The
	// whitespace after the hashes is required, not optional: an ATX heading has to
	// have it (as `firstMarkdownHeading` below already insists), and without that
	// `#hashtag`, `#1 Priority` and `######Deep` all lose their leading text.
	title = title.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "");
	// Unwrap a Markdown link only when it spans the whole title.
	title = title.replace(/^\[([^\]]+)\]\([^)]*\)$/, "$1");
	title = unwrapEmphasis(title);
	// Up to three layers, e.g. a quoted title inside a code span.
	for (let i = 0; i < 3; i++) {
		const unwrapped = unwrapQuotes(title);
		if (unwrapped === title) break;
		title = unwrapped;
	}
	// Sentence terminators only, and all of a run of them (`The End...`). `?` and
	// `？` are NOT stripped: a question is a perfectly good title.
	title = title.replace(/[.。!！]+$/, "");
	// Collapse whitespace runs except U+3000, the ideographic space. It is a
	// deliberate part of a Japanese title and not padding to be normalized away.
	title = title.replace(/[^\S\u3000]+/g, " ").trim();

	if (title.length < 1) return null;
	if (!HAS_CONTENT.test(title)) return null;
	// Code points, not UTF-16 units: emoji and some CJK would otherwise be
	// counted double and a perfectly good Japanese title thrown away.
	if ([...title].length > AI_TITLE_MAX_LENGTH) return null;
	if (REFUSAL_PREFIX.test(title)) return null;
	return title;
}

/**
 * The document's own first `# ` heading.
 *
 * Scan with one match instead of splitting a document that may be 10 MiB into
 * an array of lines.
 *
 * Keep the line-break rules aligned with `firstMarkdownHeading` in cli/index.ts.
 *
 * - Line breaks are spelled out as `(?:^|\n)` … `\r?(?=\n|$)` instead of using
 *   the `m` flag. Under `m`, `$` also matches before a lone `\r`, which `split`
 *   treats as ordinary in-line text. Without this rule, `"# a\rb"` would infer
 *   "a" here and nothing in the CLI.
 * - `[^\S\n]` is "whitespace except a newline", and must not be relaxed to
 *   `\s`: `\s` matches newlines, so a bare `#` on its own line would reach
 *   forward and capture the *next* line as the title.
 *
 * That CLI copy is the only other one. They are duplicated rather than shared
 * because cli/tsconfig.json narrows both `types` and `include`, so importing
 * this module from the CLI would put the `Env`/`Ai` globals outside its program
 * and break `bun run typecheck`.
 */
const MD_HEADING = /(?:^|\n)#[^\S\n]+(.+?)[^\S\n]*\r?(?=\n|$)/;

export function firstMarkdownHeading(content: string): string | null {
	const match = MD_HEADING.exec(content);
	return match ? match[1] : null;
}

/**
 * Choose between the default and Japanese title prompts.
 *
 * Choose the language here instead of asking the model.
 * granite-4.0-h-micro is a 3B model with English-heavy instruct tuning, and in
 * production it answered two of three Japanese documents in English while being
 * told to use the document's language. Two regexes make that choice before the
 * request.
 *
 * `match` on a /g regex resets `lastIndex` itself, unlike `test`, so KANA and
 * LATIN are safe to share at module scope. Nothing here can throw: the input is
 * arbitrary user text and the only operation on it is a scan.
 *
 * Pure kanji does not count as Japanese. With no kana there is nothing to
 * separate 第3四半期売上報告 from Chinese, so use the default prompt. Japanese
 * prose reaches for kana within a sentence or two, so this only ever bites on
 * headline-shaped fragments.
 *
 * Exported for tests.
 */
export function looksJapanese(excerpt: string): boolean {
	const kana = excerpt.match(KANA)?.length ?? 0;
	if (kana < MIN_KANA_CHARS) return false;
	const latin = excerpt.match(LATIN)?.length ?? 0;
	return kana / (kana + latin) >= MIN_KANA_RATIO;
}

/**
 * A one-line description of a thrown value, which cannot itself throw.
 *
 * Both of the obvious spellings can: `err.message` may be a getter that throws,
 * and `String(err)` throws `TypeError: No default value` on an object with a
 * null prototype. This is used from the one catch block that stands between a
 * failed inference and a failed upload, so nothing in it may throw. A lost log
 * line is far cheaper than a document that could not be created.
 */
function describeError(err: unknown): string {
	try {
		return err instanceof Error ? String(err.message) : String(err);
	} catch {
		return "unreadable error";
	}
}

/**
 * Ask Workers AI for a title. Return `null` for a missing binding, timeout,
 * retired model, or unusable output.
 */
async function generateAiTitle(env: Env, source: string): Promise<string | null> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// Both env reads sit inside the try: neither is guaranteed to be a plain
		// property read, and "never throws" has to hold unconditionally.
		//
		// DEV_DISABLE_AI_TITLES skips the call during local development (mirrors
		// DEV_DISABLE_ACCESS). Read off an optional shape rather than through Env
		// because `wrangler types` generates the key from whatever `.dev.vars` the
		// machine that ran it happens to hold. This is how DEV_DISABLE_ACCESS got
		// into worker-configuration.d.ts. It is declared in some checkouts and
		// absent in others, and never set in production at all.
		if ((env as { DEV_DISABLE_AI_TITLES?: string }).DEV_DISABLE_AI_TITLES === "1") return null;
		if (!env.AI) return null;

		// AbortController + setTimeout, not AbortSignal.timeout(): the latter can
		// raise an uncatchable async DOMException under workerd (workerd#1020),
		// which could make an upload fail.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("ai title timed out"));
			}, AI_TITLE_TIMEOUT_MS);
		});

		// Detected on the same slice the model is shown, never on the whole
		// document. Decide from the same evidence the model gets,
		// or a Japanese preface to an English report would ask for one language
		// while showing the other.
		const excerpt = source.slice(0, AI_TITLE_MAX_CHARS);
		const japanese = looksJapanese(excerpt);

		const call = env.AI.run(
			AI_TITLE_MODEL,
			{
				messages: [
					{ role: "system", content: japanese ? SYSTEM_PROMPT_JA : SYSTEM_PROMPT },
					// One-shot on the Japanese branch only. The English path is proven in
					// production and gets exactly the messages it always got.
					...(japanese ? JA_ONE_SHOT : []),
					documentTurn(excerpt),
				],
				max_tokens: 32,
				temperature: 0,
			},
			{ signal: controller.signal },
		);
		// The race enforces the bound. The signal requests upstream
		// cancellation. A rejection arriving after the race must not surface as an
		// unhandled rejection once the response has already been sent.
		call.catch(() => {});

		const out: TextOutput = await Promise.race([call, timeout]);
		return sanitizeAiTitle(out?.response ?? out?.choices?.[0]?.message?.content);
	} catch (err) {
		// Log failures so a retired model does not go unnoticed. Log only the message
		// through describeError because an error object can carry
		// the request that produced it, and that request is the first 2000
		// characters of a private document.
		console.warn("ai title failed", describeError(err));
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Title for a NEW document when the client sent no `title`.
 * Chain: Workers AI -> first `# ` heading -> `fallback`. Never throws;
 * AI failures fall through to the heading or fallback.
 *
 * `fallback` is the terminal, and it differs per caller because the callers have
 * different last resorts: the API create route passes the uploaded file name,
 * while an MCP `push` has no file and passes `untitled`.
 *
 * `html` skips AI. Poof has no HTML sanitizer by design (SPEC §6.4), and an HTML
 * title only labels the library row.
 */
export async function resolveNewTitle(
	env: Env,
	input: { fallback: string; kind: "md" | "html"; source: string },
): Promise<string> {
	// A caller's fallback is not guaranteed usable, and an empty title is an empty
	// library row and an empty browser tab. Neither adapter is known to pass a
	// blank one today. workerd hands a `filename=""` multipart part to the create
	// route as a string field, not a File, so readUpload returns 400 first. Keep the
	// final fallback here so every caller gets a nonblank title.
	const fallback = input.fallback.trim() || TERMINAL_TITLE;
	if (input.kind !== "md") return fallback;
	// `|| null`, not `??`: a `#` followed by nothing but spaces captures a blank
	// heading, which labels a document no better than an empty file name does.
	const heading = firstMarkdownHeading(input.source)?.trim() || null;
	return (await generateAiTitle(env, input.source)) ?? heading ?? fallback;
}
