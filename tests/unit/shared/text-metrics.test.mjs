import { describe, test } from "vitest";
import {
	codePointLength,
	codePointLengthAtLeast,
	createPromptByteLengthSniffer,
	promptByteLength,
	promptByteLengthBounded,
	promptByteLengthGreaterThan,
	trimContinuationOverlap,
} from "../../../src/shared/text-metrics";
import { assert } from "../assertions.js";

describe("shared text metrics", () => {
	test("bounds prompt byte length without full exact count", () => {
		const bounded = promptByteLengthBounded("x".repeat(100), 10);
		assert.equal(bounded.exceeded, true);
		assert.equal(bounded.exact, false);
		assert.equal(bounded.bytes, 11);
	});
	test("counts split surrogate pairs exactly in prompt sniffer", () => {
		const sniffer = createPromptByteLengthSniffer(4);
		sniffer.append("\uD83D");
		sniffer.append("\uDE00");
		assert.deepEqual(sniffer.result(), {
			bytes: 4,
			exceeded: false,
			exact: true,
			maxBytes: 4,
		});
	});
	test("counts prompt byte edges for mixed Unicode text", () => {
		assert.equal(promptByteLength("aé中😀\uD83D"), 13);
		assert.deepEqual(promptByteLengthBounded("éé", 3), {
			bytes: 4,
			exceeded: true,
			exact: false,
			maxBytes: 3,
		});
		assert.equal(promptByteLengthGreaterThan("abcd", 3), true);
	});
	test("finalizes pending high surrogates in prompt byte sniffers", () => {
		const exact = createPromptByteLengthSniffer(3);
		exact.append("\uD83D");
		assert.equal(exact.exceeded(), false);
		assert.deepEqual(exact.result(), {
			bytes: 3,
			exceeded: false,
			exact: true,
			maxBytes: 3,
		});

		const exceeded = createPromptByteLengthSniffer(3);
		exceeded.append("\uD83D");
		exceeded.append("\uDE00");
		assert.equal(exceeded.exceeded(), true);
		assert.deepEqual(exceeded.result(), {
			bytes: 4,
			exceeded: true,
			exact: false,
			maxBytes: 3,
		});
	});
	test("measures Unicode code points", () => {
		assert.equal(codePointLength("a😀中"), 3);
		assert.equal(codePointLengthAtLeast("a😀", 2), true);
		assert.equal(codePointLengthAtLeast("a😀", 3), false);
	});
	test("trims repeated stream continuation overlap conservatively", () => {
		assert.equal(trimContinuationOverlap("", "hello"), "hello");
		assert.equal(trimContinuationOverlap("hello", ""), "");
		assert.equal(trimContinuationOverlap("hello", "hello world"), " world");
		assert.equal(trimContinuationOverlap("hello world", "hello"), "");
		assert.equal(trimContinuationOverlap("hello", "yellow"), "yellow");
	});
});
