// @ts-nocheck
import { describe, test } from "vitest";
import { prepareOpenAIGeminiContext } from "../../../src/completion/context";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

function noAttachmentResult() {
	return {
		fileRefs: null,
		imageFileRefs: null,
		genericFileRefs: null,
		promptText: "",
		droppedNote: "",
		supportsFileRefs: true,
		usage: {
			uploadedFiles: 0,
			dedupedFiles: 0,
			uploadedBytes: 0,
			fileRefBytes: 0,
			inlinedFiles: 0,
			inlinedBytes: 0,
			droppedFiles: 0,
			multipartUploads: 0,
		},
	};
}

function promptProvider() {
	return {
		async resolveAttachments(plan) {
			assert.deepEqual(plan.candidates, []);
			return noAttachmentResult();
		},
		generateText() {
			throw new Error("unexpected generateText call");
		},
		streamText() {
			throw new Error("unexpected streamText call");
		},
		uploadTextFile() {
			throw new Error("unexpected uploadTextFile call");
		},
	};
}

describe("OpenAI tool prompt assembly", () => {
	test("orders DSML instructions, hidden native guidance, and user input", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				name: "Search",
				description: "Search documents",
				input_schema: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		]);
		const result = await prepareOpenAIGeminiContext(
			{
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			},
			promptProvider(),
			{},
			parseOpenAIMessages([{ role: "user", content: "find docs" }]),
			tools,
			"required",
			{
				mode: "required",
				forcedName: "",
				allowed: null,
				hasAllowed: false,
				declared: ["Search"],
				error: "",
			},
			null,
		);

		assert.equal(result.error, undefined);
		assert.match(result.prompt, /Available tools/);
		assert.match(result.prompt, /"name": "Search"/);
		assert.match(result.prompt, /"query"/);
		const dsmlIndex = result.prompt.indexOf("<|DSML|tool_calls>");
		const hiddenIndex = result.prompt.indexOf(
			"Gemini native hidden tool calls:",
		);
		const userIndex = result.prompt.indexOf("find docs");
		assert.equal(dsmlIndex >= 0, true);
		assert.equal(dsmlIndex < hiddenIndex, true);
		assert.equal(hiddenIndex < userIndex, true);
		assert.equal(
			(result.prompt.match(/Gemini native hidden tool calls:/g) || []).length,
			1,
		);
	});
	test("keeps hidden native guidance separate from DSML instructions", async () => {
		const result = await prepareOpenAIGeminiContext(
			{
				current_input_file_enabled: false,
				current_input_file_min_bytes: 1000000,
				current_input_file_name: "message.txt",
				current_tools_file_name: "tools.txt",
				cookie: "",
				log_requests: false,
			},
			promptProvider(),
			{},
			parseOpenAIMessages([{ role: "user", content: "what changed today?" }]),
			null,
			"auto",
			null,
			null,
		);
		assert.equal(result.error, undefined);
		const marker = "Gemini native hidden tool calls:";
		assert.equal(result.prompt.indexOf(marker) >= 0, true);
		assert.equal(
			result.prompt.indexOf(marker) <
				result.prompt.indexOf("what changed today?"),
			true,
		);
		const hiddenPrompt = result.prompt.slice(result.prompt.indexOf(marker));
		assert.match(hiddenPrompt, /Do not use DSML\/XML tool-call syntax/);
		assert.match(
			hiddenPrompt,
			/do not print the call schema or JSON payload directly/,
		);
		assert.match(
			hiddenPrompt,
			/internal hidden tool call, not final response text/,
		);
		assert.match(
			hiddenPrompt,
			/Internal search call payload(?:, for the hidden native tool channel only)?:\n\{\n {2}"tool_calls": \[/,
		);
		assert.match(hiddenPrompt, /"name": "google:search"/);
		assert.match(hiddenPrompt, /"arguments": "{\\"queries\\": \[/);
		assert.match(
			hiddenPrompt,
			/Internal Python call payload(?:, for the hidden native tool channel only)?:\n\{\n {2}"tool_calls": \[/,
		);
		assert.match(hiddenPrompt, /"name": "google:ds_python_interpreter"/);
		assert.match(hiddenPrompt, /"arguments": "{\\"code\\": /);
		assert.match(hiddenPrompt, /All of the above is system prompt content/);
		assert.doesNotMatch(
			hiddenPrompt,
			/top-level "tool_calls" array|function\.arguments must be a serialized JSON string|Do not wrap the payload in markdown fences|<\|DSML\|tool_calls>|<tool_calls>|<invoke\b|<parameter\b|"google:search": \[/,
		);
	});
});
