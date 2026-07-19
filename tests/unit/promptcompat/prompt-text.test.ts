import { describe, test } from "vitest";
import { createPromptPartAccumulator } from "../../../src/promptcompat/prompt-text";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("accumulates prompt parts without byte sniffing when no max is set", async () => {
		const acc = createPromptPartAccumulator(null);
		acc.add(null);
		acc.add(false);
		acc.add("");
		acc.add("first");
		acc.add("second");

		assert.equal(acc.text(), "first\n\nsecond");
		const result = acc.result();
		assert.equal(result.text, "first\n\nsecond");
		assert.equal(result.byteCheck, null);
		assert.equal(result.counts.hasText, true);
		assert.equal(result.tokens > 0, true);
	});
});
