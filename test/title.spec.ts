import { describe, expect, it } from "vitest";

import { firstMarkdownHeading, looksJapanese, sanitizeAiTitle } from "../src/lib/title";

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

/**
 * The one part of the AI path that can be tested here: `env.AI.run()` rejects
 * under the test pool by design (`remoteBindings: false`), so the prompt itself
 * is left to inspection, but which prompt gets sent is a pure function of the
 * excerpt and is pinned in full below.
 *
 * A false positive is the expensive direction — it puts a Japanese instruction
 * and a Japanese example on an English document, regressing the one path proven
 * in production — so most of what follows guards that side.
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
		// The false positive that matters. Both of these are English documents that
		// happen to contain Japanese, and both must take the English prompt.
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
		// The commonest shape in this library, and the one a naive ratio over the
		// whole excerpt would lose: the English runs are long, the Japanese is not.
		expect(looksJapanese(JA_MIXED)).toBe(true);
		// A source file whose only Japanese is its user-facing strings counts as a
		// Japanese document, deliberately: those strings are what a reader reads.
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
		// The ratio is a contest between the two scripts, not kana against the length
		// of the excerpt: a Japanese table is mostly figures and pipes, and measuring
		// against the whole string would file it under English on that alone.
		const table = `| 月 | 売上 | 前年比 |
| --- | --- | --- |
| 1月 | 12,345,678 | 103.2% |
| 2月 | 11,987,654 | 98.7% |
| 3月 | 13,456,789 | 110.4% |
合計は 37,790,121 円で、前年比は 104.1% となった。`;
		expect(looksJapanese(table)).toBe(true);
	});

	it("does not let kanji weigh against the kana beside it", () => {
		// Kanji is on neither side of the ratio. As evidence it would fire on Chinese;
		// as ballast it would starve exactly this — a Japanese document written almost
		// entirely in compounds, where the handful of kana is the whole signal and
		// nothing about it suggests English.
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
		// two kana instead of three and drops under the floor — and a loan word with
		// a long vowel in it is most of written katakana.
		expect(looksJapanese("データ")).toBe(true);
	});

	it("counts halfwidth katakana, which is Script=Katakana", () => {
		expect(looksJapanese("ｼｽﾃﾑ ﾒﾝﾃﾅﾝｽ")).toBe(true);
	});

	it("calls kanji with no kana NOT Japanese — the decision, not an oversight", () => {
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
		// `lastIndex`, but `RegExp.test` does not — swapping one in would make the
		// second call on a document disagree with the first.
		expect(looksJapanese(JA_MIXED)).toBe(true);
		expect(looksJapanese(JA_MIXED)).toBe(true);
		expect(looksJapanese(EN_PROSE)).toBe(false);
		expect(looksJapanese(EN_PROSE)).toBe(false);
	});
});
