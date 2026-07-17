import { describe, test } from "vitest";
import {
	isInsideMarkdownFence,
	isInsideSimpleMarkdownCodeSpan,
	isMarkdownProtectedPosition,
	markdownProtectedRanges,
	markdownProtectedSpanStartAtCut,
	markdownProtectedTailStart,
	maskMarkdownProtectedSpans,
	openMarkdownCodeSpanStart,
	openMarkdownFenceStart,
	parseMarkdownFenceLine,
} from "../../../src/toolcall/markdown";
import { findToolCallSyntaxCandidateStart } from "../../../src/toolcall/syntax-probe";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("detects markdown protected tails and validates fence lines", async () => {
		assert.deepEqual(parseMarkdownFenceLine("  ```js"), {
			ch: "`",
			len: 3,
			index: 2,
			canClose: false,
		});
		assert.deepEqual(parseMarkdownFenceLine("~~~"), {
			ch: "~",
			len: 3,
			index: 0,
			canClose: true,
		});
		assert.equal(parseMarkdownFenceLine("```bad`"), null);
		assert.equal(parseMarkdownFenceLine("```<xml>"), null);
		assert.equal(parseMarkdownFenceLine("```bad]"), null);

		const fenceTail = "prefix\n```js\nconst x = 1;";
		assert.equal(openMarkdownFenceStart(fenceTail), "prefix\n".length);
		assert.equal(markdownProtectedTailStart(fenceTail), "prefix\n".length);

		const codeTail = "prefix `inline";
		assert.equal(openMarkdownCodeSpanStart(codeTail), "prefix ".length);
		assert.equal(markdownProtectedTailStart(codeTail), "prefix ".length);

		const cutText = "hello `code span` after";
		assert.equal(
			markdownProtectedSpanStartAtCut(cutText, cutText.indexOf("span")),
			"hello ".length,
		);
		assert.equal(markdownProtectedSpanStartAtCut(cutText, 0), -1);
		assert.equal(markdownProtectedSpanStartAtCut(cutText, cutText.length), -1);
	});
	test("tracks CRLF fences and variable-length inline code spans", async () => {
		const crlfFence = "intro\r\n```ts\r\nconst x = 1;\r\n```\r\noutro";
		const ranges = markdownProtectedRanges(crlfFence);
		assert.deepEqual(ranges, [
			{
				start: "intro\r\n".length,
				end: "intro\r\n```ts\r\nconst x = 1;\r\n```\r\n".length,
			},
		]);
		assert.equal(
			isMarkdownProtectedPosition(crlfFence, crlfFence.indexOf("const")),
			true,
		);
		assert.equal(
			isMarkdownProtectedPosition(crlfFence, crlfFence.indexOf("outro")),
			false,
		);

		const spans = "a ``two ticks`` and `one tick` done";
		assert.equal(
			isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("two")),
			true,
		);
		assert.equal(
			isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("one")),
			true,
		);
		assert.equal(
			isInsideSimpleMarkdownCodeSpan(spans, spans.indexOf("done")),
			false,
		);
		assert.equal(
			markdownProtectedSpanStartAtCut(
				"prefix ``unterminated",
				"prefix ``unterminated".length - 1,
			),
			"prefix ".length,
		);
	});
	test("protects markdown examples while preserving real tool syntax", async () => {
		const text = [
			"before `<tool_calls></tool_calls>` after",
			"```xml",
			"<tool_calls></tool_calls>",
			"```",
			'real <tool_calls><invoke name="Read"></invoke></tool_calls>',
		].join("\n");
		const inlineIndex = text.indexOf("<tool_calls>");
		const fencedIndex = text.indexOf("<tool_calls>", inlineIndex + 1);
		const realIndex = text.lastIndexOf("<tool_calls>");

		assert.equal(isMarkdownProtectedPosition(text, inlineIndex), true);
		assert.equal(isInsideSimpleMarkdownCodeSpan(text, inlineIndex), true);
		assert.equal(isMarkdownProtectedPosition(text, fencedIndex), true);
		assert.equal(isInsideMarkdownFence(text, fencedIndex), true);
		assert.equal(isMarkdownProtectedPosition(text, realIndex), false);
		assert.equal(findToolCallSyntaxCandidateStart(text), realIndex);

		const masked = maskMarkdownProtectedSpans(text);
		assert.doesNotMatch(masked.text, /before `<tool_calls>/);
		assert.match(masked.text, /GEMINI_MD_PROTECTED_0_TOKEN/);
		assert.equal(masked.restore(masked.text), text);
		assert.equal(markdownProtectedRanges(text).length, 2);
	});
});
