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

describe("OpenAI tool prompt assembly", () => {
	test("orders DSML instructions, hidden native guidance, and user input", async () => {
		const provider = {
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
			provider,
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
});
