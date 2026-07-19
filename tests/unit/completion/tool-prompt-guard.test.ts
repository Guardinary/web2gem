import { describe, test } from "vitest";
import { ensureInlineToolPrompt } from "../../../src/completion/tool-prompt-guard";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

describe("inline tool prompt guard", () => {
	test("guards inline tool prompts without duplicating known metadata", async () => {
		const tools = createToolBundle([
			{
				name: "Read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		]);
		const instruction =
			'\n\nIMPORTANT: You MUST call the tool "Read". Do not call other tools.';
		const alreadyPrepared =
			"Available tools:\n[]\n\n<|DSML|tool_calls>\nuser prompt";
		assert.equal(
			ensureInlineToolPrompt(alreadyPrepared, tools, instruction, null, {
				hasToolPrompt: true,
				hasToolInstructions: true,
			}),
			alreadyPrepared,
		);
		const guarded = ensureInlineToolPrompt(
			"user prompt",
			tools,
			instruction,
			null,
			{
				hasToolPrompt: false,
				hasToolInstructions: false,
			},
		);
		assert.match(guarded, /Available tools/);
		assert.match(guarded, /"name": "Read"/);
		assert.match(guarded, /You MUST call the tool "Read"/);
		assert.match(guarded, /user prompt/);
		assert.doesNotMatch(guarded, /Gemini native hidden tool calls/);
		assert.equal(
			ensureInlineToolPrompt(guarded, tools, instruction, null, {
				hasToolPrompt: true,
				hasToolInstructions: true,
			}),
			guarded,
		);
		assert.equal((guarded.match(/Available tools:/g) || []).length, 1);
		assert.equal(
			(guarded.match(/IMPORTANT: You MUST call the tool "Read"/g) || []).length,
			1,
		);
	});
	test("guards context-file prompts with instructions but without inline schemas", async () => {
		const tools = createToolBundle([
			{
				name: "Read",
				description: "Read a file",
				parameters: { type: "object" },
			},
		]);
		const instruction =
			"\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
		const guarded = ensureInlineToolPrompt(
			"Continue from the latest state in the attached tools.txt context",
			tools,
			instruction,
			{ fileRefs: [] },
			{ hasToolPrompt: false, hasToolInstructions: false },
		);
		assert.doesNotMatch(guarded, /Available tools/);
		assert.match(guarded, /<\|DSML\|tool_calls>/);
		assert.match(guarded, /You MUST call at least one tool/);
		assert.match(guarded, /Continue from the latest state/);

		assert.equal(
			ensureInlineToolPrompt(
				"Continue from the latest state",
				tools,
				instruction,
				{ fileRefs: [] },
				{
					hasToolPrompt: false,
					hasToolInstructions: true,
				},
			),
			"Continue from the latest state",
		);
	});
	test("adds missing tool-choice instruction once when no tools are declared", async () => {
		const instruction =
			"\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
		const guarded = ensureInlineToolPrompt(
			"plain prompt",
			null,
			instruction,
			null,
			{
				hasToolPrompt: false,
				hasToolInstructions: false,
			},
		);
		assert.match(guarded, /^\s*IMPORTANT: Do NOT call any tools/);
		assert.match(guarded, /plain prompt$/);
		assert.equal(
			ensureInlineToolPrompt(
				guarded,
				null,
				instruction,
				{
					fileRefs: [],
				},
				{ hasToolPrompt: false, hasToolInstructions: false },
			),
			guarded,
		);
	});
});
