// @ts-nocheck
import { describe, test } from "vitest";
import { parseToolCalls } from "../../../src/toolcall/dsml";
import {
	containsToolMarkupSyntax,
	findToolCallSyntaxCandidateStart,
} from "../../../src/toolcall/syntax-probe";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("parses long plain text without tool calls", async () => {
		const plain = "plain text without tool syntax\n".repeat(8000);
		const [clean, toolCalls] = parseToolCalls(plain, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, plain.trim());
		assert.deepEqual(toolCalls, []);
	});
	test("avoids expensive parsing for markup false positives", async () => {
		const falsePositive =
			"a < b and parameterless prose should stay plain\n".repeat(5000);
		assert.equal(containsToolMarkupSyntax(falsePositive), false);
		assert.equal(findToolCallSyntaxCandidateStart(falsePositive), -1);
		const [clean, toolCalls] = parseToolCalls(falsePositive, [
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.equal(clean, falsePositive.trim());
		assert.deepEqual(toolCalls, []);
	});
});
