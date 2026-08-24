import { describe, expect, it } from "vitest";

import { firstMarkdownHeading, sanitizeAiTitle } from "../src/lib/title";

/**
 * Spelled as escapes on purpose. These are the characters the sanitizer exists
 * to handle, and every one of them is invisible or indistinguishable in a source
 * file — pasted literally, a reader could not tell this test from a broken one,
 * and an editor that normalizes on save could silently rewrite the input.
 */
const ZWNJ = "\u200C"; // zero-width non-joiner, orthographically required in Persian
const ZWJ = "\u200D"; // zero-width joiner, what holds an emoji sequence together
const ZWSP = "\u200B"; // zero-width space
const SHY = "\u00AD"; // soft hyphen
const RLO = "\u202E"; // right-to-left override
const BOM = "\uFEFF";
const ESC = "\u001B"; // escape, the lead byte of every ANSI terminal sequence
const BEL = "\u0007";
const NUL = "\u0000";

describe("sanitizeAiTitle", () => {
	it("passes a clean single-line title through untouched", () => {
		expect(sanitizeAiTitle("Quarterly Roadmap")).toBe("Quarterly Roadmap");
	});

	it("unwraps one layer of matched quotes, including the Japanese pairs", () => {
		expect(sanitizeAiTitle('"Quarterly Roadmap"')).toBe("Quarterly Roadmap");
		expect(sanitizeAiTitle("『四半期ロードマップ』")).toBe("四半期ロードマップ");
		expect(sanitizeAiTitle("「四半期ロードマップ」")).toBe("四半期ロードマップ");
		expect(sanitizeAiTitle("`Roadmap`")).toBe("Roadmap");
	});

	it("leaves a string that merely begins and ends with a quote mark alone", () => {
		// Regression: with only the ends checked, `「設計」と「実装」` came out as
		// `設計」と「実装` — a mangled Japanese title with stray quotes mid-string.
		// The guard has to hold for an asymmetric pair and for `"`, where the open
		// and close marks are the same character.
		expect(sanitizeAiTitle("「設計」と「実装」")).toBe("「設計」と「実装」");
		expect(sanitizeAiTitle('"Alpha" vs "Beta"')).toBe('"Alpha" vs "Beta"');
		expect(sanitizeAiTitle('He said "hi')).toBe('He said "hi');
	});

	it("takes the link text when the whole string is a single Markdown link", () => {
		expect(sanitizeAiTitle("[Design Notes](http://x)")).toBe("Design Notes");
	});

	it("leaves a string that merely contains a Markdown link alone", () => {
		expect(sanitizeAiTitle("[a](http://x) and [b](http://y)")).toBe("[a](http://x) and [b](http://y)");
		expect(sanitizeAiTitle("see [Design Notes](http://x) here")).toBe("see [Design Notes](http://x) here");
	});

	it("strips a Title:/タイトル： label", () => {
		expect(sanitizeAiTitle("Title: Quarterly Roadmap")).toBe("Quarterly Roadmap");
		expect(sanitizeAiTitle("タイトル：四半期ロードマップ")).toBe("四半期ロードマップ");
	});

	it("takes the next non-empty line when the label sits alone on its own line", () => {
		expect(sanitizeAiTitle("Title:\nQuarterly Roadmap")).toBe("Quarterly Roadmap");
	});

	it("strips a heading, bullet or numbered-list marker the model added itself", () => {
		expect(sanitizeAiTitle("# Quarterly Roadmap")).toBe("Quarterly Roadmap");
		expect(sanitizeAiTitle("- Roadmap")).toBe("Roadmap");
		expect(sanitizeAiTitle("1. Roadmap")).toBe("Roadmap");
	});

	it("requires whitespace after the hashes before calling them a heading marker", () => {
		// The space is not optional in an ATX heading, and treating it as optional
		// costs the leading text of every one of these.
		expect(sanitizeAiTitle("#hashtag")).toBe("#hashtag");
		expect(sanitizeAiTitle("#1 Priority")).toBe("#1 Priority");
		expect(sanitizeAiTitle("######Deep")).toBe("######Deep");
		// A real marker is still stripped, at every depth.
		expect(sanitizeAiTitle("# Real Heading")).toBe("Real Heading");
		expect(sanitizeAiTitle("###### Deep Heading")).toBe("Deep Heading");
	});

	it("unwraps emphasis wrapping the whole string", () => {
		expect(sanitizeAiTitle("**Quarterly Roadmap**")).toBe("Quarterly Roadmap");
	});

	it("unwraps __init__ to init — an accepted loss, on the record, not an oversight", () => {
		// Under CommonMark `__init__` really is <strong>init</strong>: the delimiters
		// sit at the string's edges, so the intraword rule does not save it, which
		// makes it indistinguishable from `__Roadmap__` — a model bolding its answer
		// against instructions. No rule keeps one without losing the other, and this
		// was the side chosen. Pinned so a future reader meets a decision, not a bug.
		expect(sanitizeAiTitle("__init__")).toBe("init");
		// The blast radius, and why the loss was acceptable: unwrapping needs the
		// marker at BOTH ends, so a dunder anywhere but alone survives intact.
		expect(sanitizeAiTitle("Understanding __init__")).toBe("Understanding __init__");
		expect(sanitizeAiTitle("__init__ explained")).toBe("__init__ explained");
	});

	it("keeps only the first non-empty line when the model rambles on afterwards", () => {
		expect(sanitizeAiTitle("Roadmap\n\nThis title summarizes…")).toBe("Roadmap");
		// The explanation is dropped, not the title — and not the whole answer.
		expect(sanitizeAiTitle("Design Notes\nThis document describes...")).toBe("Design Notes");
	});

	it("keeps only what follows the last </think> of a reasoning model", () => {
		expect(sanitizeAiTitle("<think>hmm</think>\nRoadmap")).toBe("Roadmap");
		expect(sanitizeAiTitle("<think>a</think><think>b</think>\nRoadmap")).toBe("Roadmap");
	});

	it("rejects an unclosed <think> instead of titling the model's scratchpad", () => {
		// At max_tokens: 32 an answer cut off mid-thought is the likelier shape by
		// far, and there is nothing after the block to keep. "Okay, the user wants a
		// title for…" must never become the document's name.
		expect(sanitizeAiTitle("<think>Okay, the user wants a title for this")).toBeNull();
		expect(sanitizeAiTitle("<THINK>Okay, the user wants a title")).toBeNull();
		// Not over-broad: a word that merely starts with "think" is not a tag.
		expect(sanitizeAiTitle("Thinking About Types")).toBe("Thinking About Types");
	});

	it("collapses runs of whitespace, tabs included, into single spaces", () => {
		expect(sanitizeAiTitle("Quarterly  Roadmap\t2026")).toBe("Quarterly Roadmap 2026");
	});

	it("preserves U+3000, the ideographic space, inside the title", () => {
		// It is a deliberate part of a Japanese title, not padding: collapsing it to
		// an ASCII space silently rewrites what the model wrote.
		expect(sanitizeAiTitle("設計　メモ")).toBe("設計　メモ");
		// Still only *inside*: a line of nothing but ideographic spaces is blank.
		expect(sanitizeAiTitle("　　")).toBeNull();
	});

	it("strips a whole run of trailing sentence terminators in either script", () => {
		expect(sanitizeAiTitle("Quarterly Roadmap.")).toBe("Quarterly Roadmap");
		expect(sanitizeAiTitle("四半期ロードマップ。")).toBe("四半期ロードマップ");
		expect(sanitizeAiTitle("The End...")).toBe("The End");
	});

	it("keeps a trailing question mark: a question is a perfectly good title", () => {
		expect(sanitizeAiTitle("How do I deploy poof?")).toBe("How do I deploy poof?");
		expect(sanitizeAiTitle("poof とは？")).toBe("poof とは？");
	});

	it("leaves a Japanese title completely untouched", () => {
		// The whole point of picking a model that handles Japanese: nothing in the
		// sanitizer may mangle, transliterate or reject a JA answer.
		expect(sanitizeAiTitle("四半期ロードマップ")).toBe("四半期ロードマップ");
	});

	it("strips control characters, so no title can carry an escape sequence to a terminal", () => {
		// `poof ls` and the MCP `ls` tool print titles straight out. An ESC surviving
		// here is interpreted by whatever terminal renders the row, and this strip is
		// the only thing between a model's output and that terminal.
		const cleaned = sanitizeAiTitle(`${ESC}[31mDesign Notes${ESC}[0m`);
		expect(cleaned).toBe("[31mDesign Notes[0m");
		expect(/\p{Cc}/u.test(cleaned!)).toBe(false);

		expect(sanitizeAiTitle(`Design${BEL}Notes`)).toBe("DesignNotes");
		expect(sanitizeAiTitle(`${NUL}Design Notes`)).toBe("Design Notes");
	});

	it("strips invisible format characters, which cannot be judged by reading the title", () => {
		// RLO reverses the display direction of everything after it in a library row,
		// and it is invisible, so nobody reading that row could see why.
		expect(sanitizeAiTitle(`${RLO}Design Notes`)).toBe("Design Notes");
		expect(sanitizeAiTitle(`Design${RLO} Notes`)).toBe("Design Notes");
		expect(sanitizeAiTitle(`${BOM}Design Notes`)).toBe("Design Notes");
	});

	it("keeps ZWNJ and ZWJ, the two format characters a legitimate title needs", () => {
		// The exceptions to the strip above. Dropping either mangles a real title
		// rather than cleaning it: ZWNJ is orthographic in Persian and Devanagari,
		// and ZWJ is what makes an emoji sequence one glyph instead of two.
		const persian = `نرم${ZWNJ}افزار`;
		expect(sanitizeAiTitle(persian)).toBe(persian);
		const withSequence = `Dev Notes 👨${ZWJ}💻`;
		expect(sanitizeAiTitle(withSequence)).toBe(withSequence);
	});

	it("rejects a title with no letter or digit anywhere in it", () => {
		// Debris from an answer the model never really gave. Rejecting sends the chain
		// on to the document's own heading, which labels a library row far better than
		// `---` does. An emoji-only title fails this too, which is the safe direction.
		for (const debris of ["---", "***", "…", "、", ZWSP, SHY, "🎉🎉"]) {
			expect(sanitizeAiTitle(debris), JSON.stringify(debris)).toBeNull();
		}
		// A digit counts as content: a title may legitimately be nothing but a number.
		expect(sanitizeAiTitle("2026")).toBe("2026");
	});

	it("rejects rather than truncates a title over 80 code points", () => {
		expect(sanitizeAiTitle("a".repeat(81))).toBeNull();
		expect(sanitizeAiTitle("a".repeat(80))).toBe("a".repeat(80));
	});

	it("counts the length in code points, not UTF-16 units", () => {
		// 40 astral emoji (2 UTF-16 units each) + 39 ASCII: .length is 119, well over
		// the bound, while the code-point count is 79 and therefore acceptable. A
		// regression to `title.length` would throw this away — and with it every
		// emoji or astral-plane title.
		const title = "🎉".repeat(40) + "a".repeat(39);
		expect(title.length).toBeGreaterThan(80);
		expect([...title].length).toBe(79);
		expect(sanitizeAiTitle(title)).toBe(title);
	});

	it("returns null for empty and whitespace-only output", () => {
		expect(sanitizeAiTitle("")).toBeNull();
		expect(sanitizeAiTitle("   ")).toBeNull();
	});

	it("returns null for anything that is not a string", () => {
		expect(sanitizeAiTitle(undefined)).toBeNull();
		expect(sanitizeAiTitle(42)).toBeNull();
		expect(sanitizeAiTitle({})).toBeNull();
		expect(sanitizeAiTitle(null)).toBeNull();
	});

	it("rejects an answer that talks about the request instead of performing it", () => {
		expect(sanitizeAiTitle("Sure! Here is a title: Roadmap")).toBeNull();
		expect(sanitizeAiTitle("Here's the title: Design Notes")).toBeNull();
		// The same preamble typed with a curly apostrophe, which is how most models
		// actually write it.
		expect(sanitizeAiTitle("Here’s the title: Design Notes")).toBeNull();
		expect(sanitizeAiTitle("I cannot title this")).toBeNull();
		expect(sanitizeAiTitle("I can’t title this")).toBeNull();
	});

	it("does not mistake an ordinary title that opens with those words for a preamble", () => {
		// A false positive throws a good title away, so the guard is deliberately
		// narrow: "Sure"/"Of course" only count when their punctuation follows
		// immediately, and a bare "I can" is not a refusal.
		expect(sanitizeAiTitle("Sure Thing Inc Annual Report")).toBe("Sure Thing Inc Annual Report");
		expect(sanitizeAiTitle("I Can Fly")).toBe("I Can Fly");
		expect(sanitizeAiTitle("Of Course Correction")).toBe("Of Course Correction");
	});
});

describe("firstMarkdownHeading", () => {
	it("finds a heading on the first line", () => {
		expect(firstMarkdownHeading("# Title\n\nbody")).toBe("Title");
	});

	it("finds a heading below YAML front matter and blank lines", () => {
		expect(firstMarkdownHeading("---\ntitle: meta\n---\n\n\n# Real Heading\n\nbody")).toBe("Real Heading");
	});

	it("ignores a sub-heading with no h1 above it", () => {
		expect(firstMarkdownHeading("## Sub")).toBeNull();
	});

	it("requires whitespace after the hash", () => {
		expect(firstMarkdownHeading("#NoSpace")).toBeNull();
		// A tab is whitespace and does count.
		expect(firstMarkdownHeading("#\tTabbed")).toBe("Tabbed");
	});

	it("returns null for a bare hash", () => {
		expect(firstMarkdownHeading("#")).toBeNull();
	});

	it("does not let a bare # reach forward and capture the next line", () => {
		// The scan matches "whitespace except a newline" after the hash. Relaxed to
		// `\s`, which matches newlines, a `#` alone on its own line would title the
		// document with whatever happens to follow it.
		expect(firstMarkdownHeading("#\nActual Body Text")).toBeNull();
		// Not over-broad: a real heading further down is still found.
		expect(firstMarkdownHeading("#\n# Real Heading")).toBe("Real Heading");
	});

	it("only treats a # at the start of a line as a heading", () => {
		expect(firstMarkdownHeading("text # Not A Heading")).toBeNull();
		expect(firstMarkdownHeading("intro\n\n# Later Heading")).toBe("Later Heading");
	});

	it("treats CRLF as a line break and a lone CR as ordinary in-line text", () => {
		// This has to agree exactly with the CLI's `split(/\r?\n/)` scan (SPEC §10),
		// or `poof push` and the server name the same file differently. The lone-CR
		// case is where the two could disagree: under an `m` flag `$` would also match
		// before a `\r`, which `split` treats as ordinary text.
		expect(firstMarkdownHeading("# a\r\nb")).toBe("a");
		expect(firstMarkdownHeading("---\r\ntitle: x\r\n---\r\n\r\n# Real Heading\r\nbody")).toBe("Real Heading");
		expect(firstMarkdownHeading("# a\rb")).toBeNull();
	});

	it("trims trailing whitespace off the heading text", () => {
		expect(firstMarkdownHeading("# Trailing   \n")).toBe("Trailing");
	});

	it("captures a blank heading rather than rejecting it — the caller does that", () => {
		// `#` and nothing but spaces is still a heading as far as this scan goes. The
		// contract is deliberately split: `resolveNewTitle` is what refuses to file a
		// document under a blank one (see test/titles.spec.ts), and this pins the half
		// that makes that guard necessary.
		expect(firstMarkdownHeading("#   \n\nbody")).toBe(" ");
	});

	it("takes the first of several h1 headings", () => {
		expect(firstMarkdownHeading("# First\n\n# Second")).toBe("First");
	});
});
