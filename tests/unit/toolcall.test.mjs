import { describe, test } from "vitest";
import { prepareOpenAIGeminiContext } from "../../src/completion/context";
import { prepareContextFilesWithUploader } from "../../src/completion/context-files";
import { streamOpenAIChatWithToolSieve } from "../../src/http/openai/chat-stream";
import { streamResponsesWithToolSieve } from "../../src/http/openai/responses-stream";
import { parseOpenAIMessages } from "../../src/promptcompat/message-model";
import { createToolBundle } from "../../src/toolcall/tool-bundle";
import { assert } from "./assertions.js";
import { fakeStreamProvider } from "./helpers.js";

describe("toolcall", () => {
	test("streams OpenAI tool choice violation and DONE marker", async () => {
		const writes = [];
		await streamOpenAIChatWithToolSieve(
			(chunk) => writes.push(chunk),
			{},
			{
				provider: fakeStreamProvider([
					'<tool_calls><invoke name="Read"><parameter name="file_path">README.md</parameter></invoke></tool_calls>',
				]),
				id: "chatcmpl_test",
				model: "gemini-3.5-flash",
				prompt: "do not call tools",
				rm: { name: "gemini-3.5-flash" },
				fileRefs: null,
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				toolPolicy: {
					mode: "none",
					forcedName: "",
					allowed: {},
					hasAllowed: true,
					declared: ["Read"],
					error: "",
				},
				includeUsage: false,
				promptTokens: 1,
				signal: new AbortController().signal,
			},
		);
		const body = writes.join("");
		assert.match(body, /tool_choice does not allow tool\(s\): Read/);
		assert.match(body, /data: \[DONE\]/);
	});
	test("streams Responses failure for missing required tool call", async () => {
		const writes = [];
		await streamResponsesWithToolSieve(
			(chunk) => writes.push(chunk),
			{},
			{
				provider: fakeStreamProvider(["plain answer"]),
				rid: "resp_test",
				rm: { name: "gemini-3.5-flash" },
				prompt: "must call a tool",
				fileRefs: null,
				tools: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Read"],
					error: "",
				},
				promptTokens: 1,
				signal: new AbortController().signal,
			},
		);
		const body = writes.join("");
		assert.match(body, /event: response.failed/);
		assert.match(body, /tool_choice requires at least one valid tool call/);
	});
	test("moves large tool context into attached tools file", async () => {
		const cfg = {
			current_input_file_enabled: true,
			current_input_file_min_bytes: 10,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "SID=ok",
			supports_authenticated_session: true,
			log_requests: false,
		};
		const uploads = [];
		const result = await prepareContextFilesWithUploader(
			cfg,
			"user history with latest request",
			[
				{
					name: "Read",
					description: "Read a file",
					parameters: { type: "object" },
				},
			],
			"must call Read",
			"latest request",
			"x".repeat(40),
			async (text, filename) => {
				uploads.push({ text, filename });
				return { ref: `/uploaded/${filename}`, name: filename };
			},
		);
		assert.equal(result.error, undefined);
		assert.equal(result.fileRefs.length, 2);
		assert.equal(uploads[0].filename, "message.txt");
		assert.equal(uploads[1].filename, "tools.txt");
		assert.match(
			result.prompt,
			/Continue from the latest state in the attached `message\.txt` context/,
		);
		assert.match(
			result.prompt,
			/All text above this sentence is system prompt content/,
		);
		assert.doesNotMatch(result.prompt, /<\|DSML\|tool_calls>/);
		assert.doesNotMatch(result.prompt, /must call Read/);
		assert.doesNotMatch(result.prompt, /Gemini native hidden tool calls/);
		assert.match(uploads[1].text, /Available tool descriptions/);
		assert.match(uploads[1].text, /Tool call format instructions/);
		assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
		assert.match(uploads[1].text, /Tool choice policy:\nmust call Read/);
		assert.match(uploads[1].text, /Gemini native hidden tool calls/);
		assert.match(uploads[1].text, /All of the above is system prompt content/);
		assert.match(result.promptTokenText, /user history/);
		assert.match(result.promptTokenText, /Available tool descriptions/);
		assert.match(result.promptTokenText, /Gemini native hidden tool calls/);
	});
	test("keeps hidden native tool prompt separate from DSML instructions", async () => {
		const cfg = {
			current_input_file_enabled: false,
			current_input_file_min_bytes: 1000000,
			current_input_file_name: "message.txt",
			current_tools_file_name: "tools.txt",
			cookie: "",
			log_requests: false,
		};
		const result = await prepareOpenAIGeminiContext(
			cfg,
			fakeStreamProvider([]),
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
