/**
 * Naming a new document when the client did not name it. The chain is Workers
 * AI → the document's own first `# ` heading → a fallback the caller supplies
 * (the uploaded file name on `/api`, `untitled` on `/mcp`), and every link
 * degrades silently: a document must never fail to be created because of AI.
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
 * Last resort, when even the caller's own fallback turns out to be unusable —
 * see `resolveNewTitle`. The same word the MCP adapter passes as its fallback,
 * so the chain has exactly one terminal however it is entered.
 */
const TERMINAL_TITLE = "untitled";

// The default prompt, and byte-for-byte the one that has been naming English
// documents in production. "The same language as the document" stays in it
// because it works there, and because a document reaching this branch may be in
// neither English nor Japanese, where an implicit instruction is all we have.
// The 60-character cap is characters, not words (a word count is meaningless
// for Japanese), and sits below AI_TITLE_MAX_LENGTH so a slightly-over answer
// still passes acceptance instead of being thrown away.
const SYSTEM_PROMPT =
	"You generate titles for documents. Reply with the title and nothing else — a single line, at most 60 characters, " +
	"written in the same language as the document. No quotation marks, no Markdown, no trailing period, no preamble, " +
	"no explanation.";

// Japanese, where that implicit instruction measurably fails: asked to match the
// document's language, the model answered two of three real Japanese documents
// in English. So the language stops being something for the model to infer — it
// is stated flatly here and demonstrated once in JA_ONE_SHOT below. IBM's model
// card prescribes exactly this for non-English work, since "its performance
// might not be similar to English tasks. In such case, introducing a small
// number of examples (few-shot) can help the model in generating more accurate
// outputs." The rest of the line is left where it was, so the only difference
// from the proven prompt is the one clause that had to change.
const SYSTEM_PROMPT_JA =
	"You generate titles for documents. Reply with the title and nothing else — a single line, at most 60 characters. " +
	"Reply in Japanese. No quotation marks, no Markdown, no trailing period, no preamble, no explanation.";

/**
 * The user turn, built in one place so the one-shot and the real request are
 * shaped identically — an example the model cannot tell apart from the thing
 * being asked is the whole point of showing one.
 *
 * The <document> delimiter is prompt-injection hygiene, NOT a security boundary
 * — do not mistake it for a control. Worst case a malicious document names
 * itself, which is harmless: the title is HTML-escaped by lib/render.ts and
 * hono/jsx and stored in a TEXT column.
 */
function documentTurn(excerpt: string) {
	return { role: "user", content: `Title this document:\n\n<document>\n${excerpt}\n</document>` };
}

/**
 * A prior turn pair rather than a block pasted into the system prompt: a chat
 * model reads an example in the same slots it will generate in, so a
 * user/assistant pair *demonstrates* the answer where a system prompt can only
 * describe it — and a Japanese passage sitting inside the instructions is one
 * more thing for a 3B model to mistake for the document it was handed.
 *
 * The subject is deliberately far from anything this library holds — no
 * software, no incidents, no meetings — so the example teaches the language and
 * the shape (one line, a short noun phrase, no punctuation) without dragging the
 * next title toward its own topic. For the same reason the title is not a
 * document-type noun like メモ or 記録, which would be easy to copy. The excerpt
 * carries no `# ` heading either: an example whose title is its own heading
 * teaches copying, and the heading is a separate rung of the chain.
 */
const JA_ONE_SHOT = [
	documentTurn(
		"ベランダのプランターで育てているミニトマトが、五月の植え付けからようやく色づきはじめた。" +
			"水やりは朝と夕方の二回で、土が湿っている日は控える。葉の裏に虫がつきやすいため、週末にまとめて確認している。",
	),
	{ role: "assistant", content: "ミニトマトの水やりと虫よけ" },
];

/**
 * Kana: hiragana, katakana — halfwidth included, those are Script=Katakana — and
 * U+30FC, the prolonged sound mark, which is Script=Common and so falls outside
 * both while appearing in nearly every katakana loan word. Spelled as an escape
 * because ー is indistinguishable from 一, ‐ and - in a source file.
 *
 * Kanji is absent on purpose, and from both sides of the ratio below: it cannot
 * tell Japanese from Chinese, so counting it as evidence would fire on Chinese,
 * and counting it as ballast would starve exactly the kanji-heavy Japanese
 * documents this exists to catch.
 */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/gu;

/** The other side of the ratio. Fullwidth romaji is Script=Latin and counts. */
const LATIN = /\p{Script=Latin}/gu;

/**
 * A contest between the two scripts, ignoring digits, punctuation, Markdown and
 * whitespace, so a Japanese document that is mostly a table of numbers or a page
 * of URLs is not diluted into English.
 *
 * 10% is a moat, not a line, and it sits between two clusters rather than beside
 * either. Japanese prose with no English in it is 100%; Japanese technical
 * writing thick with English identifiers, URLs and product names — the shape
 * most of this library is in — measures around 40%, and even a source file whose
 * only Japanese is its user-facing strings measures around 19%. On the other
 * side an English page quoting a Japanese sentence and naming a Japanese company
 * measures around 5%, and the full 2000-character excerpt of an English document
 * holds roughly 1500 Latin letters, so clearing 10% there would take some 170
 * kana: eight solid lines of Japanese, not a phrase.
 *
 * Which side to err towards is not symmetric. A missed Japanese document merely
 * gets the prompt that shipped before this, while a misfire puts a Japanese
 * instruction and a Japanese example on an English document — a regression on
 * the one path already proven in production.
 */
const MIN_KANA_RATIO = 0.1;

/**
 * An absolute floor, because a ratio on its own lets a two-character document
 * decide. Three kana is the shortest run that cannot be a stray — one katakana
 * loan word, or a particle with its okurigana — and below it the excerpt has
 * not really said anything yet.
 */
const MIN_KANA_CHARS = 3;

/**
 * Openers that mean the model answered the request instead of performing it.
 * Such a string is never a title, so it is rejected rather than trimmed.
 *
 * Deliberately narrow. "Sure"/"Of course" only count as a preamble when the
 * punctuation of one follows immediately, so `Sure Thing Inc Annual Report`
 * stays a title; and only `cannot`/`can't` count, not a bare `I can`, which is
 * an ordinary way for a title to start. Missing a preamble merely means a poor
 * title gets used, while a false positive throws a good one away.
 */
const REFUSAL_PREFIX = /^(?:(?:sure|of course|certainly|okay)\s*[,!:]|here(?:['’]s| is)\b|i\s+(?:cannot|can['’]?t)\b)/i;

/**
 * A title has to *say* something. A string of nothing but punctuation (`---`,
 * `***`, `…`, `、`) or of nothing but invisibles labels no document — it is
 * debris left over from an answer the model never gave. An emoji-only title
 * fails this too, which is the safe direction: the chain falls through to the
 * document's own heading, and only then to the caller's fallback.
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
 * The model maps to `BaseAiTextGeneration`, whose output is `{ response?: string }`.
 * The newest catalog models answer with `ChatCompletionsOutput` instead, where
 * the text sits at `choices[0].message.content` — reading both keeps a model
 * swap a one-line change.
 */
interface TextOutput {
	response?: unknown;
	choices?: { message?: { content?: unknown } }[];
}

/**
 * `**bold**` → `bold`, but only when the run wraps the whole string.
 *
 * `__init__` comes out as `init`, and that is left alone deliberately. Under
 * CommonMark `__init__` really is `<strong>init</strong>` — the delimiters sit
 * at the string's edges, so the intraword rule does not save it — which makes
 * it indistinguishable from `__Roadmap__`, a model bolding its answer against
 * instructions. No rule keeps one without losing the other. The blast radius is
 * narrow: unwrapping needs the marker at *both* ends, so `Understanding
 * __init__` and `__init__ explained` both survive intact, and only a title that
 * is exactly one dunder token is touched.
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
		// Same guard as unwrapEmphasis: `「設計」と「実装」` and `"Alpha" vs "Beta"`
		// merely begin and end with the pair, they are not wrapped in it, and
		// unwrapping would leave a stray quote mid-string.
		if (inner.includes(open) || inner.includes(close)) continue;
		return inner.trim();
	}
	return text;
}

/**
 * Turn a model's raw output into a usable title, or `null` when it is not one.
 *
 * Rejects rather than truncates: a rambling paragraph chopped at 80 characters
 * is a strictly worse library label than the file name or the document's own
 * heading. Only the first non-empty line is ever considered — a model that
 * appends an explanation loses the explanation, not the title. Exported for
 * tests — it is the only part of this module that is deterministic without a
 * network.
 *
 * Deliberately does NOT HTML-escape: `escapeHtml` in lib/render.ts and
 * `hono/jsx` both escape at render time, so escaping here would double-escape.
 */
export function sanitizeAiTitle(raw: unknown): string | null {
	if (typeof raw !== "string" || !raw) return null;

	// Reasoning models wrap their scratchpad in <think>…</think>; keep what
	// follows the last close tag.
	let text = raw;
	const thinkEnd = text.lastIndexOf("</think>");
	if (thinkEnd !== -1) text = text.slice(thinkEnd + "</think>".length);
	// An opener still standing here never closed, and at max_tokens: 32 that is
	// the likelier shape by far — the answer was cut off mid-thought. There is
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
	// reading the title, and one of its members — RLO, U+202E — silently reverses
	// the display direction of everything after it in a library row. U+200C and
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
	// A whole-string Markdown link — the same debris as the markers above, kept
	// here rather than left in for symmetry. A string merely *containing* a link
	// is left alone: `[^)]` cannot span the second link's `)`.
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
	// Collapse whitespace runs — except U+3000, the ideographic space, which is a
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
 * Scanned with one match rather than by splitting into lines: a 10 MiB document
 * would otherwise build an array of every line just to read the first heading,
 * before rendering has even started (~6 ms of a 10 ms budget, for nothing).
 *
 * Two details are load-bearing, both of them about what counts as a line break,
 * because this has to agree exactly with the `split(/\r?\n/)` scan in
 * `firstMarkdownHeading` in cli/index.ts (SPEC §10) — `poof push` and the server
 * must not title the same file differently:
 *
 * - Line breaks are spelled out as `(?:^|\n)` … `\r?(?=\n|$)` instead of using
 *   the `m` flag. Under `m`, `$` also matches before a lone `\r`, which `split`
 *   treats as ordinary in-line text — so `"# a\rb"` would infer "a" here and
 *   nothing in the CLI.
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
 * Whether to ask for a Japanese title. A heuristic, and deliberately a blunt
 * one: all it picks is which of two prompts to send, so a wrong answer costs a
 * badly-named document and nothing else.
 *
 * The language is decided here instead of by the model on purpose.
 * granite-4.0-h-micro is a 3B model with English-heavy instruct tuning, and in
 * production it answered two of three Japanese documents in English while being
 * told to write "in the same language as the document" — an implicit
 * instruction is a whole inference task of its own, and it is one we can settle
 * exactly, for free, with two regexes.
 *
 * `match` on a /g regex resets `lastIndex` itself, unlike `test`, so KANA and
 * LATIN are safe to share at module scope. Nothing here can throw: the input is
 * arbitrary user text and the only operation on it is a scan.
 *
 * Pure kanji comes out NOT Japanese, and that is the decision rather than an
 * oversight: with no kana at all there is nothing to separate 第3四半期売上報告
 * from Chinese, and the default prompt is the safer place to land. Japanese
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
 * failed inference and a failed upload, so nothing in it may throw — a lost log
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
 * Ask Workers AI for a title. Returns `null` on absolutely anything going
 * wrong — no binding, timeout, a retired model ID, unusable output.
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
		// machine that ran it happens to hold — which is how DEV_DISABLE_ACCESS got
		// into worker-configuration.d.ts — so it is declared in some checkouts and
		// absent in others, and never set in production at all.
		if ((env as { DEV_DISABLE_AI_TITLES?: string }).DEV_DISABLE_AI_TITLES === "1") return null;
		if (!env.AI) return null;

		// AbortController + setTimeout, not AbortSignal.timeout(): the latter can
		// raise an uncatchable async DOMException under workerd (workerd#1020),
		// which is exactly the "an upload must never fail" hazard being avoided.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("ai title timed out"));
			}, AI_TITLE_TIMEOUT_MS);
		});

		// Detected on the same slice the model is shown, never on the whole
		// document: the decision has to be made on the evidence the model gets,
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
		// The race is the authoritative bound; the signal is best-effort upstream
		// cancellation. A rejection arriving after the race must not surface as an
		// unhandled rejection once the response has already been sent.
		call.catch(() => {});

		const out: TextOutput = await Promise.race([call, timeout]);
		return sanitizeAiTitle(out?.response ?? out?.choices?.[0]?.message?.content);
	} catch (err) {
		// Logged, not swallowed: observability is on, and without this a retired
		// model ID would silently degrade to heading-only titling with no signal.
		// The message only, and through describeError — an error object can carry
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
 * every step degrades silently, because a document must never fail to
 * be created because of AI.
 *
 * `fallback` is the terminal, and it differs per caller because the callers have
 * different last resorts: the API create route passes the uploaded file name,
 * while an MCP `push` has no file and passes `untitled`.
 *
 * `html` skips the AI entirely: stripping tags correctly is a sanitizer-shaped
 * problem and poof carries no sanitizer by design (SPEC §6.4), and for `html`
 * the title only labels the library row — it is never baked into a blob.
 */
export async function resolveNewTitle(
	env: Env,
	input: { fallback: string; kind: "md" | "html"; source: string },
): Promise<string> {
	// A caller's fallback is not guaranteed usable, and an empty title is an empty
	// library row and an empty browser tab. Neither adapter is known to pass a
	// blank one today — workerd hands a `filename=""` multipart part to the create
	// route as a string field, not a File, so readUpload 400s it before this runs —
	// but the terminal belongs to the chain rather than to whichever caller
	// remembers, so no rung of it can ever yield a blank.
	const fallback = input.fallback.trim() || TERMINAL_TITLE;
	if (input.kind !== "md") return fallback;
	// `|| null`, not `??`: a `#` followed by nothing but spaces captures a blank
	// heading, which labels a document no better than an empty file name does.
	const heading = firstMarkdownHeading(input.source)?.trim() || null;
	return (await generateAiTitle(env, input.source)) ?? heading ?? fallback;
}
