import { describe, test } from "vitest";
import {
	createMarkdownProtectionLookup,
	markdownProtectedSpanStartAtCut,
	markdownProtectedTailStart,
	maskMarkdownProtectedSpans,
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
		assert.equal(markdownProtectedTailStart(fenceTail), "prefix\n".length);

		const codeTail = "prefix `inline";
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
		const crlfLookup = createMarkdownProtectionLookup(crlfFence);
		assert.equal(crlfLookup.isProtected(crlfFence.indexOf("const")), true);
		assert.equal(crlfLookup.isProtected(crlfFence.indexOf("outro")), false);

		const spans = "a ``two ticks`` and `one tick` done";
		const spanLookup = createMarkdownProtectionLookup(spans);
		assert.equal(spanLookup.isProtected(spans.indexOf("two")), true);
		assert.equal(spanLookup.isProtected(spans.indexOf("one")), true);
		assert.equal(spanLookup.isProtected(spans.indexOf("done")), false);
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
		const lookup = createMarkdownProtectionLookup(text);

		assert.equal(lookup.isProtected(inlineIndex), true);
		assert.equal(lookup.isProtected(fencedIndex), true);
		assert.equal(lookup.isProtected(realIndex), false);
		assert.equal(findToolCallSyntaxCandidateStart(text), realIndex);

		const masked = maskMarkdownProtectedSpans(text);
		assert.doesNotMatch(masked.text, /before `<tool_calls>/);
		assert.match(masked.text, /GEMINI_MD_PROTECTED_0_TOKEN/);
		assert.equal(masked.restore(masked.text), text);
	});

	test("masks multiple protected spans including tilde fences", async () => {
		const text = [
			"inline `a <tool_calls/> b` text",
			"~~~xml",
			"<tool_calls></tool_calls>",
			"~~~",
			"after",
		].join("\n");
		const masked = maskMarkdownProtectedSpans(text);
		assert.match(masked.text, /GEMINI_MD_PROTECTED_0_TOKEN/);
		assert.match(masked.text, /GEMINI_MD_PROTECTED_1_TOKEN/);
		assert.doesNotMatch(masked.text, /<tool_calls/);
		assert.equal(masked.restore(masked.text), text);

		const empty = maskMarkdownProtectedSpans("");
		assert.equal(empty.text, "");
		assert.equal(empty.restore("x"), "x");
	});
});
