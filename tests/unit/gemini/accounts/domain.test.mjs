import { describe, test } from "vitest";
import {
	geminiAccountState,
	visibleGeminiAccountIssue,
} from "../../../../src/gemini/accounts/domain";
import { assert } from "../../assertions.js";

describe("Gemini account domain", () => {
	test("derives disabled, cooling, attention, and available states", () => {
		for (const [account, expected] of [
			[{ enabled: false, issue: "auth", cooldown_until_ms: 9000 }, "disabled"],
			[
				{ enabled: true, issue: "rate_limit", cooldown_until_ms: 9000 },
				"cooling",
			],
			[{ enabled: true, issue: "auth", cooldown_until_ms: null }, "attention"],
			[
				{ enabled: true, issue: "transient", cooldown_until_ms: 900 },
				"available",
			],
		]) {
			assert.equal(geminiAccountState(account, 1000), expected);
		}
	});

	test("hides expired temporary issues but retains durable issues", () => {
		assert.equal(
			visibleGeminiAccountIssue(
				{ issue: "transient", cooldown_until_ms: 900 },
				1000,
			),
			null,
		);
		assert.equal(
			visibleGeminiAccountIssue(
				{ issue: "auth", cooldown_until_ms: null },
				1000,
			),
			"auth",
		);
	});
});
