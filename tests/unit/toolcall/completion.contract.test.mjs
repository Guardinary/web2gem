import { describe, test } from "vitest";
import { finalizeOpenAICompletionResult } from "../../../src/completion/turn";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("finalizes OpenAI text into tool calls", async () => {
		const finalized = finalizeOpenAICompletionResult(
			'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
			{
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				promptToolChoice: "auto",
				structured: null,
				toolPolicy: null,
			},
		);
		assert.equal(finalized.error, undefined);
		assert.equal(finalized.toolCalls[0].function.name, "Read");
	});
	test("rejects tool calls when OpenAI tool choice is none", async () => {
		const finalized = finalizeOpenAICompletionResult(
			'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
			{
				tools: null,
				noneModeTools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				promptToolChoice: "none",
				structured: null,
				toolPolicy: {
					mode: "none",
					forcedName: "",
					allowed: {},
					hasAllowed: true,
					declared: ["Read"],
					error: "",
				},
			},
		);
		assert.equal(finalized.error.code, "tool_choice_violation");
		assert.equal(finalized.error.status, 422);
	});
	test("normalizes schema-backed arguments during completion finalization", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				name: "Search",
				input_schema: {
					type: "object",
					properties: { query: { type: "string" } },
				},
			},
		]);
		const finalized = finalizeOpenAICompletionResult(
			'<tool_calls><invoke name="Search"><parameter name="query"><term>docs</term></parameter></invoke></tool_calls>',
			{
				tools,
				promptToolChoice: "required",
				structured: null,
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Search"],
					error: "",
				},
			},
		);

		assert.equal(finalized.error, undefined);
		assert.deepEqual(JSON.parse(finalized.toolCalls[0].function.arguments), {
			query: '{"term":"docs"}',
		});
	});
});
