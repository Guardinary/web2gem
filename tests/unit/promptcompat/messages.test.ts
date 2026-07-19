import { describe, test } from "vitest";
import { parseGoogleRequest } from "../../../src/promptcompat/google";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { messagesToPrompt } from "../../../src/promptcompat/messages";
import {
	googleToolChoiceInstructionFromPolicy,
	parseGoogleToolChoicePolicy,
} from "../../../src/toolcall/policy-google";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("omits OpenAI tool prompt when tool choice is none", async () => {
		const result = messagesToPrompt(
			parseOpenAIMessages([{ role: "user", content: "answer without tools" }]),
			{
				bundle: createToolBundle([
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				]),
				choiceInstruction: "",
				include: false,
			},
			1000000,
		);
		assert.equal(result.text, "answer without tools");
		assert.equal(result.metadata.hasToolPrompt, false);
		assert.equal(result.metadata.hasToolInstructions, false);
	});
	test("keeps OpenAI tool prompt metadata aligned with provided tool defs", async () => {
		const result = messagesToPrompt(
			parseOpenAIMessages([{ role: "user", content: "answer without tools" }]),
			{ bundle: createToolBundle([]), choiceInstruction: "", include: true },
			1000000,
		);
		assert.equal(result.text, "answer without tools");
		assert.equal(result.metadata.hasToolPrompt, false);
		assert.equal(result.metadata.hasToolInstructions, false);
	});
	test("formats assistant tool-call history and tool-result fallbacks", async () => {
		const result = messagesToPrompt(
			parseOpenAIMessages([
				"ignored",
				{
					role: "assistant",
					reasoning_content: "should not be duplicated",
					content: "[reasoning_content]\nkept\n[/reasoning_content]\nanswer",
					tool_calls: [
						{ function: { name: "Run", arguments: "not json" } },
						{ function: { name: "Lookup", arguments: '{"query":"docs"}' } },
					],
				},
				{ role: "tool", content: null, tool_call_id: "call_1" },
				{
					role: "user",
					content: [{ type: "text", text: "latest user text" }],
				},
			]),
			null,
			1000000,
		);
		assert.match(result.text, /\[Assistant\]: \[reasoning_content\]\nkept/);
		assert.doesNotMatch(result.text, /should not be duplicated/);
		assert.match(
			result.text,
			/<\|DSML\|tool_calls><\|DSML\|invoke name="Run"><\/\|DSML\|invoke><\/\|DSML\|tool_calls>/,
		);
		assert.match(
			result.text,
			/<\|DSML\|parameter name="query"><!\[CDATA\[docs\]\]><\/\|DSML\|parameter>/,
		);
		assert.match(result.text, /\[Tool result for id=call_1\]: null/);
		assert.equal(result.latestInputText, "latest user text");
	});
	test("renders Google messages with canonical tool policy metadata", async () => {
		const request = {
			systemInstruction: { parts: [{ text: "be concise" }] },
			tools: [
				{
					functionDeclarations: [
						{
							name: "Search",
							description: "Search docs",
							parameters: { type: "object" },
						},
					],
				},
			],
			toolConfig: {
				functionCallingConfig: {
					mode: "ANY",
					allowedFunctionNames: ["Search"],
				},
			},
			contents: [
				{
					role: "user",
					parts: [
						{ text: "look up docs" },
						{
							inlineData: {
								data: "R0lGODlh",
								mimeType: "image/gif",
							},
						},
					],
				},
				{
					role: "model",
					parts: [
						{ text: "I will search" },
						{ functionCall: { name: "Search", args: { query: "docs" } } },
					],
				},
				{
					role: "user",
					parts: [
						{ text: "tool output follows" },
						{ functionResponse: { name: "Search", response: { ok: true } } },
					],
				},
			],
		};
		const bundle = createToolBundle(request.tools);
		const policy = parseGoogleToolChoicePolicy(request, bundle);
		const result = messagesToPrompt(
			parseGoogleRequest(request),
			{
				bundle,
				choiceInstruction: googleToolChoiceInstructionFromPolicy(policy),
				include: true,
			},
			1000000,
		);

		assert.match(result.text, /\[System instruction\]: be concise/);
		assert.match(result.text, /\[image input\]/);
		assert.match(result.text, /Available tools/);
		assert.match(result.text, /MUST call one of these tools: "Search"/);
		assert.match(result.text, /look up docs/);
		assert.match(result.text, /\[Assistant\]: I will search/);
		assert.match(
			result.text,
			/<\|DSML\|tool_calls><\|DSML\|invoke name="Search">/,
		);
		assert.match(result.text, /\[Tool result for Search\]: \{"ok":true\}/);
		assert.equal(result.latestInputText, "tool output follows");
		assert.deepEqual(result.metadata, {
			hasToolPrompt: true,
			hasToolInstructions: true,
		});
	});

	test("renders Google assistant text without tool-call markup", async () => {
		const result = messagesToPrompt(
			parseGoogleRequest({
				contents: [
					{ role: "user", parts: [{ text: "first question" }] },
					{ role: "model", parts: [{ text: "previous answer" }] },
					{ role: "user", parts: [{ text: "latest question" }] },
				],
			}),
			null,
			1000000,
		);

		assert.match(result.text, /\[Assistant\]: previous answer/);
		assert.doesNotMatch(result.text, /<\|DSML\|tool_calls>/);
		assert.equal(result.latestInputText, "latest question");
	});
	test("omits Google tool prompt when function calling mode is NONE", async () => {
		const request = {
			tools: [
				{
					functionDeclarations: [
						{ name: "Search", parameters: { type: "object" } },
					],
				},
			],
			toolConfig: { functionCallingConfig: { mode: "NONE" } },
			contents: [{ role: "user", parts: [{ text: "answer directly" }] }],
		};
		const bundle = createToolBundle(request.tools);
		const policy = parseGoogleToolChoicePolicy(request, bundle);
		const result = messagesToPrompt(
			parseGoogleRequest(request),
			{
				bundle,
				choiceInstruction: googleToolChoiceInstructionFromPolicy(policy),
				include: false,
			},
			1000000,
		);

		assert.equal(result.text, "answer directly");
		assert.deepEqual(result.metadata, {
			hasToolPrompt: false,
			hasToolInstructions: false,
		});
		assert.match(
			googleToolChoiceInstructionFromPolicy(policy),
			/Do NOT call any tools/,
		);
	});
	test("marks prompt conversion as over byte budget", async () => {
		const result = messagesToPrompt(
			parseOpenAIMessages([{ role: "user", content: "x".repeat(40) }]),
			null,
			10,
		);
		const byteCheck = result.byteCheck;
		if (!byteCheck) throw new TypeError("expected bounded prompt byte check");
		assert.equal(byteCheck.exceeded, true);
		assert.equal(byteCheck.exact, false);
		assert.equal(byteCheck.bytes > 10, true);
	});
});
