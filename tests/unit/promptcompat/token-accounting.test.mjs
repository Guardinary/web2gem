import { describe, test } from "vitest";
import {
	buildTextWithTokens,
	createTokenCounter,
	tokenCharCounts,
	tokenEst,
} from "../../../src/promptcompat/token-accounting";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("counts token characters across split surrogate pairs", async () => {
		assert.deepEqual(tokenCharCounts("abcd😀中"), {
			asciiChars: 4,
			nonASCIIChars: 2,
		});
		assert.equal(tokenEst("abcd😀中") >= 2, true);

		const counter = createTokenCounter();
		counter.append("abcd");
		counter.append("\uD83D");
		counter.append("\uDE00中");
		assert.deepEqual(counter.counts(), {
			asciiChars: 4,
			nonASCIIChars: 2,
			hasText: true,
		});
		assert.equal(counter.tokens(), tokenEst("abcd😀中"));
	});

	test("builds token text without retaining rendered text", async () => {
		const prepared = buildTextWithTokens(["ab", null, ["cd"], "😀"], false);
		assert.equal(prepared.text, "");
		assert.deepEqual(prepared.counts, {
			asciiChars: 4,
			nonASCIIChars: 1,
			hasText: true,
		});
	});
});
