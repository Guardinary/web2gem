// @ts-nocheck
import { describe, test } from "vitest";
import { parseGoogleRequest } from "../../../src/promptcompat/google";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("normalizes Google system image tool-call and tool-response parts", async () => {
		const messages = parseGoogleRequest({
			systemInstruction: {
				parts: [
					{ text: "be concise" },
					{ text: "cite sources" },
					{ ignored: true },
				],
			},
			contents: [
				{
					role: "user",
					parts: [
						{ text: "look up docs" },
						{
							inline_data: {
								data: "BBBB",
								mime_type: "image/jpeg",
								display_name: "diagram.jpg",
							},
						},
						{ fileData: { fileUri: "gemini://file/2" } },
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
		});

		assert.deepEqual(
			messages.map((message) => message.role),
			["system", "user", "assistant", "user", "tool"],
		);
		assert.equal(messages[0].parts[0].text, "be concise cite sources");
		assert.deepEqual(
			messages[1].parts.map((part) => part.kind),
			["text", "image", "file"],
		);
		assert.deepEqual(
			{
				mime: messages[1].parts[1].mime,
				filename: messages[1].parts[1].filename,
				hasInline: messages[1].parts[1].hasInline,
			},
			{ mime: "image/jpeg", filename: "diagram.jpg", hasInline: true },
		);
		assert.equal(messages[1].parts[2].label, "gemini://file/2");
		assert.deepEqual(messages[2].toolCalls, [
			{ id: "", name: "Search", args: { query: "docs" } },
		]);
		assert.equal(messages[3].parts[0].text, "tool output follows");
		assert.equal(messages[4].toolName, "Search");
		assert.equal(messages[4].parts[0].text, '{"ok":true}');
	});

	test("normalizes camelCase and snake_case Google file parts", async () => {
		const [camelMessage] = parseGoogleRequest({
			contents: [
				{
					role: "user",
					parts: [
						{
							fileData: {
								fileUri: "https://files.example/main.py",
								mimeType: "text/x-python",
								displayName: "main.py",
							},
						},
						{
							inlineData: {
								data: "Y29uc29sZS5sb2coMSk=",
								mimeType: "text/javascript",
								displayName: "inline.js",
							},
						},
					],
				},
			],
		});
		const [snakeMessage] = parseGoogleRequest({
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

		assert.deepEqual(
			camelMessage.parts.map((part) => ({
				kind: part.kind,
				label: part.label,
				remoteUrl: part.remoteUrl,
				upload: part.upload,
			})),
			[
				{
					kind: "file",
					label: "main.py",
					remoteUrl: "https://files.example/main.py",
					upload: null,
				},
				{
					kind: "file",
					label: "inline.js",
					remoteUrl: "",
					upload: {
						b64: "Y29uc29sZS5sb2coMSk=",
						mime: "text/javascript",
						filename: "inline.js",
					},
				},
			],
		);
		assert.deepEqual(
			snakeMessage.parts.map((part) => ({
				label: part.label,
				uploadMime: part.upload?.mime || "",
			})),
			[
				{ label: "notes.txt", uploadMime: "" },
				{ label: "readme.md", uploadMime: "text/markdown" },
			],
		);
	});
});
