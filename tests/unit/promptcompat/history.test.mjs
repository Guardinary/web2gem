import { describe, test } from "vitest";
import { parseGoogleRequest } from "../../../src/promptcompat/google";
import {
	buildOpenAIHistoryTranscript,
	latestOpenAIUserInputText,
} from "../../../src/promptcompat/history";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("builds OpenAI history transcript with reasoning tool call and tool metadata", async () => {
		const transcript = buildOpenAIHistoryTranscript(
			parseOpenAIMessages([
				{ role: "system", content: "system guide" },
				{
					role: "user",
					content: [
						{ type: "text", text: "hello" },
						{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
					],
				},
				{
					role: "assistant",
					content: "I will read it",
					reasoning_content: "need file",
					tool_calls: [
						{
							function: {
								name: "Read",
								arguments: '{"file_path":"README.md"}',
							},
						},
					],
				},
				{
					role: "tool",
					name: "Read",
					tool_call_id: "call_1",
					content: { ok: true },
				},
			]),
			"history.txt",
		);
		assert.match(transcript, /# history\.txt/);
		assert.match(transcript, /=== 1\. SYSTEM ===/);
		assert.match(transcript, /\[reasoning_content\]\nneed file/);
		assert.match(
			transcript,
			/<\|DSML\|tool_calls><\|DSML\|invoke name="Read">/,
		);
		assert.match(transcript, /\[name=Read tool_call_id=call_1\]/);
		assert.match(transcript, /\{"ok":true\}/);
	});
	test("returns empty history transcripts for invalid or contentless inputs", async () => {
		assert.equal(buildOpenAIHistoryTranscript([], "empty.txt"), "");
		assert.equal(
			buildOpenAIHistoryTranscript(
				parseOpenAIMessages([{ role: "assistant", content: "" }]),
				"empty.txt",
			),
			"",
		);
		assert.equal(latestOpenAIUserInputText([]), "");
		assert.equal(
			latestOpenAIUserInputText(
				parseOpenAIMessages([{ role: "assistant", content: "answer" }]),
			),
			"",
		);
	});
	test("builds Google history transcript and latest user text from rich parts", async () => {
		const req = {
			systemInstruction: {
				parts: [{ text: "be concise" }, { ignored: true }],
			},
			contents: [
				{
					role: "user",
					parts: [{ text: "inspect" }, { inlineData: { data: "AAAA" } }],
				},
				{
					role: "model",
					parts: [{ functionCall: { name: "Lookup", args: { id: "1" } } }],
				},
				{
					role: "user",
					parts: [
						{ functionResponse: { name: "Lookup", response: { ok: true } } },
					],
				},
				{
					role: "user",
					parts: [
						{ fileData: { fileUri: "gemini://file/1" } },
						{ text: "latest" },
					],
				},
			],
		};
		const messages = parseGoogleRequest(req);
		const transcript = buildOpenAIHistoryTranscript(messages, "google.txt");
		assert.match(transcript, /be concise/);
		assert.match(transcript, /\[image input\]/);
		assert.match(
			transcript,
			/<\|DSML\|tool_calls><\|DSML\|invoke name="Lookup">/,
		);
		assert.match(transcript, /\[name=Lookup\]\n\{"ok":true\}/);
		assert.match(transcript, /\[file input gemini:\/\/file\/1\]\nlatest/);
		assert.equal(
			latestOpenAIUserInputText(messages),
			"[file input gemini://file/1]\nlatest",
		);
	});
	test("extracts latest Google user text from image and file-only turns", async () => {
		assert.equal(
			latestOpenAIUserInputText(
				parseGoogleRequest({
					contents: [
						{ role: "model", parts: [{ text: "assistant" }] },
						{ role: "user", parts: [{ inlineData: { data: "AAAA" } }] },
					],
				}),
			),
			"[image input]",
		);
		assert.equal(
			latestOpenAIUserInputText(
				parseGoogleRequest({
					contents: [{ role: "user", parts: [{ fileData: {} }] }],
				}),
			),
			"[file input]",
		);
		assert.equal(
			latestOpenAIUserInputText(
				parseGoogleRequest({
					contents: [{ role: "model", parts: [{ text: "assistant only" }] }],
				}),
			),
			"",
		);
	});
	test("extracts latest OpenAI user text while ignoring empty and assistant messages", async () => {
		assert.equal(
			latestOpenAIUserInputText(
				parseOpenAIMessages([
					{ role: "user", content: "first" },
					{ role: "assistant", content: "answer" },
					{ role: "user", content: [{ type: "input_text", text: "" }] },
					{ role: "user", content: [{ type: "text", text: "latest" }] },
				]),
			),
			"latest",
		);
	});
	test("uses normalized Google file parts in history for snake case fields", async () => {
		const messages = parseGoogleRequest({
			contents: [
				{
					role: "user",
					parts: [
						{
							file_data: {
								file_uri: "gemini://file/3",
								mime_type: "text/plain",
								display_name: "notes.txt",
							},
						},
						{
							inline_data: {
								data: "IyBUaXRsZQ==",
								mime_type: "text/markdown",
								display_name: "readme.md",
							},
						},
					],
				},
			],
		});
		const transcript = buildOpenAIHistoryTranscript(
			messages,
			"snake-google-files.txt",
		);

		assert.match(transcript, /\[file input notes\.txt\]/);
		assert.match(transcript, /\[file input readme\.md\]/);
		assert.doesNotMatch(transcript, /\[image input\]/);
		assert.equal(
			latestOpenAIUserInputText(messages),
			"[file input notes.txt]\n[file input readme.md]",
		);
	});
});
