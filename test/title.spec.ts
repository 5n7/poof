import { describe, expect, it } from "vitest";

import { firstMarkdownHeading, looksJapanese, sanitizeAiTitle } from "../src/lib/title";

/**
 * Spelled as escapes on purpose. These are the characters the sanitizer exists
 * to handle. Every one is invisible or ambiguous in source. Literal characters
 * would make the test hard to review, and editor normalization could change them.
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
		// `設計」と「実装`, a mangled Japanese title with stray quotes mid-string.
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

	it("accepts that unwrapping emphasis changes __init__ to init", () => {
		// CommonMark parses `__init__` as <strong>init</strong> because the delimiters
		// are at the string edges. The sanitizer cannot distinguish it from a model
		// wrapping `__Roadmap__` in bold, so it unwraps both forms.
		expect(sanitizeAiTitle("__init__")).toBe("init");
		// Unwrapping requires markers at both ends, so embedded dunder names remain.
		expect(sanitizeAiTitle("Understanding __init__")).toBe("Understanding __init__");
		expect(sanitizeAiTitle("__init__ explained")).toBe("__init__ explained");
	});

	it("keeps only the first non-empty line when the model rambles on afterwards", () => {
		expect(sanitizeAiTitle("Roadmap\n\nThis title summarizes…")).toBe("Roadmap");
		// Keep the title and drop the following explanation.
		expect(sanitizeAiTitle("Design Notes\nThis document describes...")).toBe("Design Notes");
	});

	it("keeps only what follows the last </think> of a reasoning model", () => {
		expect(sanitizeAiTitle("<think>hmm</think>\nRoadmap")).toBe("Roadmap");
		expect(sanitizeAiTitle("<think>a</think><think>b</think>\nRoadmap")).toBe("Roadmap");
	});

	it("rejects an unclosed <think> instead of titling the model's scratchpad", () => {
		// With max_tokens set to 32, a response may end inside the reasoning block.
		// There is no title to keep after an unclosed block.
		expect(sanitizeAiTitle("<think>Okay, the user wants a title for this")).toBeNull();
		expect(sanitizeAiTitle("<THINK>Okay, the user wants a title")).toBeNull();
		// A word starting with "think" is not a tag.
		expect(sanitizeAiTitle("Thinking About Types")).toBe("Thinking About Types");
	});

	it("collapses runs of whitespace, tabs included, into single spaces", () => {
		expect(sanitizeAiTitle("Quarterly  Roadmap\t2026")).toBe("Quarterly Roadmap 2026");
	});

	it("preserves U+3000, the ideographic space, inside the title", () => {
		// U+3000 may be part of a Japanese title. Do not convert it to an ASCII space.
		expect(sanitizeAiTitle("設計　メモ")).toBe("設計　メモ");
		// A line containing only ideographic spaces is still blank.
		expect(sanitizeAiTitle("　　")).toBeNull();
	});

	it("strips a whole run of trailing sentence terminators in either script", () => {
		expect(sanitizeAiTitle("Quarterly Roadmap.")).toBe("Quarterly Roadmap");
		expect(sanitizeAiTitle("四半期ロードマップ。")).toBe("四半期ロードマップ");
		expect(sanitizeAiTitle("The End...")).toBe("The End");
	});

	it("keeps a trailing question mark in a title", () => {
		expect(sanitizeAiTitle("How do I deploy poof?")).toBe("How do I deploy poof?");
		expect(sanitizeAiTitle("poof とは？")).toBe("poof とは？");
	});

	it("leaves a Japanese title completely untouched", () => {
		// The sanitizer must not alter, transliterate, or reject a Japanese answer.
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
		// ZWNJ is orthographic in Persian and Devanagari. ZWJ joins an emoji sequence
		// into one glyph, so both are exceptions to the format-character removal.
		const persian = `نرم${ZWNJ}افزار`;
		expect(sanitizeAiTitle(persian)).toBe(persian);
		const withSequence = `Dev Notes 👨${ZWJ}💻`;
		expect(sanitizeAiTitle(withSequence)).toBe(withSequence);
	});

	it("rejects a title with no letter or digit anywhere in it", () => {
		// These values contain no usable title. Rejecting them lets the caller use the
		// document heading instead. Emoji-only titles follow the same rule.
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
		// using `title.length` would reject this and other astral-plane titles.
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
		// The same preamble typed with the curly apostrophe common in model output.
		expect(sanitizeAiTitle("Here’s the title: Design Notes")).toBeNull();
		expect(sanitizeAiTitle("I cannot title this")).toBeNull();
		expect(sanitizeAiTitle("I can’t title this")).toBeNull();
	});

	it("does not mistake an ordinary title that opens with those words for a preamble", () => {
		// "Sure" and "Of course" count as preambles only when punctuation follows
		// immediately. A bare "I can" is not a refusal.
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
		// A valid heading later in the document is still found.
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

	it("returns a blank heading for the caller to reject", () => {
		// `#` and nothing but spaces is still a heading as far as this scan goes. The
		// scan returns it. `resolveNewTitle` rejects the blank result before naming a
		// document. See test/titles.spec.ts.
		expect(firstMarkdownHeading("#   \n\nbody")).toBe(" ");
	});

	it("takes the first of several h1 headings", () => {
		expect(firstMarkdownHeading("# First\n\n# Second")).toBe("First");
	});
});

/**
 * `env.AI.run()` rejects under the test pool because `remoteBindings` is false.
 * The prompt cannot run here, but these tests cover how the excerpt selects a
 * prompt.
 *
 * A false positive sends a Japanese instruction and example for an English
 * document, so the tests emphasize English inputs containing Japanese text.
 */
describe("looksJapanese", () => {
	/** Japanese prose with no Latin in it at all. */
	const JA_PROSE = `# 内部研修メモ：テスト戦略

今期の研修では、単体テストと結合テストの役割分担をあらためて整理した。
これまでは網羅率だけを指標にしていたが、壊れやすい箇所を見極めることのほうが重要だという結論になった。
次回までに、各チームで代表的な不具合を三件ずつ持ち寄ることにした。`;

	/** Japanese prose carrying the English identifiers this library is full of. */
	const JA_MIXED = `# デプロイ手順

\`wrangler deploy\` を実行すると Worker が Cloudflare にアップロードされる。
D1 のマイグレーションは \`bun run migrate:remote\` で適用する。
本番の URL は https://poof.5n7.me で、Access のポリシーは変更しないこと。`;

	const EN_PROSE = `# Incident Review: Backoff Fix

The queue consumer retried without a ceiling, so a single poisoned message
saturated the worker pool for eleven minutes. We shipped an exponential backoff
with a dead letter queue behind it, and the same message now lands in the DLQ
after five attempts instead of spinning forever.`;

	/** One English sentence, repeated to the length of a real document. */
	const EN_FILLER = "The deploy pipeline runs on every merge to main and publishes the worker. ".repeat(20);

	it("calls Japanese prose Japanese", () => {
		expect(looksJapanese(JA_PROSE)).toBe(true);
	});

	it("calls English prose not Japanese", () => {
		expect(looksJapanese(EN_PROSE)).toBe(false);
		expect(looksJapanese(EN_FILLER)).toBe(false);
	});

	it("does not call an English document Japanese for a quote or a proper noun", () => {
		// Both documents are English despite containing Japanese text.
		const quoted = `The vendor's error page reads 「エラーが発生しました」 and nothing else, which
tells the operator nothing at all. We asked them to include the request id. The
Tokyo office (東京オフィス) has escalated this twice already and the ticket is
still open after three weeks of back and forth with their support team.`;
		expect(looksJapanese(quoted)).toBe(false);
		expect(looksJapanese(`${EN_FILLER}The account manager is トヨタ, contract renewed in April.`)).toBe(false);
	});

	it("judges by proportion, not by presence", () => {
		// The same Japanese fragment, alone and then dropped into a document of
		// English. A contains-check would call both of them Japanese.
		const fragment = "「これは日本語の引用です」と書いてある。";
		expect(looksJapanese(fragment)).toBe(true);
		expect(looksJapanese(EN_FILLER + fragment)).toBe(false);
	});

	it("calls a short Japanese note Japanese, but not a lone stray kana", () => {
		// Both bounds have to hold at once. A demand for volume would throw away
		// notes as short as these two, and a ratio with no floor under it would let
		// a one-character document decide.
		expect(looksJapanese("明日の会議は十時から、資料は前日までに共有すること。")).toBe(true);
		expect(looksJapanese("メモ: 明日の会議")).toBe(true); // exactly at the floor
		expect(looksJapanese("ん")).toBe(false);
	});

	it("calls Japanese written around English identifiers Japanese", () => {
		// Japanese prose often contains long English identifiers. Counting all
		// characters would misclassify it.
		expect(looksJapanese(JA_MIXED)).toBe(true);
		// User-facing Japanese strings make this a Japanese document even though the
		// surrounding source is English.
		const source = `function notify(kind) {
  const messages = {
    done: "処理が完了しました",
    fail: "エラーが発生しました",
  };
  return messages[kind];
}`;
		expect(looksJapanese(source)).toBe(true);
	});

	it("is not diluted by digits, punctuation or Markdown", () => {
		// The ratio compares scripts. Digits and Markdown punctuation in a Japanese
		// table must not dilute the kana count.
		const table = `| 月 | 売上 | 前年比 |
| --- | --- | --- |
| 1月 | 12,345,678 | 103.2% |
| 2月 | 11,987,654 | 98.7% |
| 3月 | 13,456,789 | 110.4% |
合計は 37,790,121 円で、前年比は 104.1% となった。`;
		expect(looksJapanese(table)).toBe(true);
	});

	it("does not let kanji weigh against the kana beside it", () => {
		// Kanji does not count toward either side of the ratio because it also appears
		// in Chinese. A small kana count can therefore identify compound-heavy
		// Japanese text without misclassifying Chinese text.
		const outline = `# 年次報告書 目次

第一章 序論
第二章 先行研究の整理
第三章 実験手法
第四章 結果と考察
第五章 結論と今後の展望
付録 参考文献一覧`;
		expect(looksJapanese(outline)).toBe(true);
	});

	it("calls katakana-heavy text Japanese, U+30FC included", () => {
		expect(looksJapanese("サーバーのメモリーリークをモニタリングツールでチェックする")).toBe(true);
		// U+30FC, the prolonged sound mark, is Script=Common and falls outside both
		// kana scripts, so it has to be listed by hand. Without it `データ` counts
		// two kana instead of three and falls below the minimum.
		expect(looksJapanese("データ")).toBe(true);
	});

	it("counts halfwidth katakana, which is Script=Katakana", () => {
		expect(looksJapanese("ｼｽﾃﾑ ﾒﾝﾃﾅﾝｽ")).toBe(true);
	});

	it("does not classify kanji without kana as Japanese", () => {
		// With no kana there is nothing to tell 第3四半期売上報告書 from Chinese, so
		// the default prompt is where this lands. Real Japanese prose reaches for
		// kana within a sentence, so it only bites on headline-shaped fragments.
		expect(looksJapanese("第3四半期売上報告書")).toBe(false);
		expect(looksJapanese("本季度销售报告显示，华东地区的增长速度超过预期，主要来自新客户的持续投入。")).toBe(false);
		// One kanji away from that fragment, a sentence of Japanese is Japanese.
		expect(looksJapanese("第3四半期の売上を報告します。")).toBe(true);
	});

	it("returns false, and does not throw, on degenerate input", () => {
		// This runs on arbitrary uploaded text, and the caller's contract is that a
		// document must never fail to be created because of the AI path.
		for (const input of [
			"",
			"   ",
			"\n\t\r\n",
			"　　　", // ideographic spaces
			"SELECT * FROM documents WHERE id = ?;",
			"🎉🎉🎉 ✅ 🚀",
			"---***---",
			"2026-08-24 12:00:00",
			`${BOM}${RLO}${ZWSP}`,
		]) {
			expect(looksJapanese(input), JSON.stringify(input)).toBe(false);
		}
	});

	it("gives the same answer twice for the same input", () => {
		// KANA and LATIN are module-level /g regexes. `String.match` resets
		// `lastIndex`, but `RegExp.test` does not. Swapping one in would make the
		// second call on a document disagree with the first.
		expect(looksJapanese(JA_MIXED)).toBe(true);
		expect(looksJapanese(JA_MIXED)).toBe(true);
		expect(looksJapanese(EN_PROSE)).toBe(false);
		expect(looksJapanese(EN_PROSE)).toBe(false);
	});
});
