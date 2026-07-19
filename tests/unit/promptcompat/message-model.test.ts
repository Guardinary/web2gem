import { describe, test } from "vitest";
import {
	type FilePart,
	flattenText,
	historyContentText,
	type ImagePart,
	type InternalMessage,
	parseMessageContent,
	parseOpenAIMessages,
	rawRecordReasoningText,
	type TextPart,
} from "../../../src/promptcompat/message-model";
import { assert } from "../assertions.js";

function messageAt(
	messages: readonly InternalMessage[],
	index: number,
): InternalMessage {
	const message = messages[index];
	if (!message) throw new TypeError(`expected message at index ${index}`);
	return message;
}

function textPartAt(message: InternalMessage, index: number): TextPart {
	const part = message.parts[index];
	if (part?.kind !== "text")
		throw new TypeError(`expected text part at index ${index}`);
	return part;
}

function imagePartAt(message: InternalMessage, index: number): ImagePart {
	const part = message.parts[index];
	if (part?.kind !== "image")
		throw new TypeError(`expected image part at index ${index}`);
	return part;
}

function filePartAt(message: InternalMessage, index: number): FilePart {
	const part = message.parts[index];
	if (part?.kind !== "file")
		throw new TypeError(`expected file part at index ${index}`);
	return part;
}

describe("prompt compatibility", () => {
	test("keeps recognized singleton content parts equivalent to arrays", () => {
		for (const part of [
			{ type: "input_text", text: "input" },
			{ type: "output_text", text: "output" },
			{ type: "summary_text", text: "summary" },
			{ type: "reasoning", text: "thought" },
			{ type: "input_image", image_url: "data:image/png;base64,QUJD" },
			{ type: "input_file", file_id: "file-1" },
		]) {
			assert.deepEqual(parseMessageContent(part), parseMessageContent([part]));
		}
	});

	test("retains explicit legacy fallback for unknown singleton content", () => {
		assert.deepEqual(parseMessageContent({ type: "custom", text: "legacy" }), [
			{ kind: "text", text: "legacy", inputText: true },
		]);
		assert.deepEqual(
			parseMessageContent([{ type: "custom", text: "ignored" }]),
			[{ kind: "text", text: "ignored", inputText: false }],
		);
	});
	test("renders history and flattened content fallbacks", async () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const message = messageAt(
			parseOpenAIMessages([{ role: "user", content: cyclic }]),
			0,
		);
		assert.equal(historyContentText(message), "[object Object]");
		assert.equal(
			flattenText([
				{ type: "text", text: "a" },
				2,
				true,
				{ type: "input_file", file_id: "f1" },
			]),
			"a 2 true [file input f1]",
		);
	});

	test("normalizes object-shaped message content at the content boundary", async () => {
		const parsedMessages = parseOpenAIMessages([
			{
				role: "user",
				content: {
					type: "input_image",
					source: {
						data: "CCCC",
						mime_type: "image/gif",
						file_name: "inline.gif",
					},
				},
			},
			{
				role: "user",
				content: {
					type: "file",
					file_id: "file-1",
					filename: "document.txt",
				},
			},
			{
				role: "user",
				content: {
					text: { type: "output_text", text: "fallback output" },
				},
			},
		]);
		const imageMessage = messageAt(parsedMessages, 0);
		const fileMessage = messageAt(parsedMessages, 1);
		const textMessage = messageAt(parsedMessages, 2);
		const image = imagePartAt(imageMessage, 0);
		const file = filePartAt(fileMessage, 0);
		const text = textPartAt(textMessage, 0);

		assert.deepEqual(
			{
				kind: image.kind,
				filename: image.filename,
				hasInline: image.hasInline,
				mime: image.mime,
			},
			{
				kind: "image",
				filename: "inline.gif",
				hasInline: true,
				mime: "image/gif",
			},
		);
		assert.deepEqual(file.fileRef, {
			id: "file-1",
			name: "document.txt",
		});
		assert.equal(text.text, "fallback output");
	});
	test("normalizes reasoning and object-shaped message parts", async () => {
		assert.equal(
			rawRecordReasoningText({
				content: [
					{ type: "reasoning", text: "checked plan" },
					{ type: "thinking", text: "picked tool" },
					{ type: "text", text: "visible" },
				],
			}),
			"checked plan\npicked tool",
		);
		assert.equal(
			flattenText({
				text: [{ type: "summary_text", text: "nested summary" }],
			}),
			"nested summary",
		);
		assert.equal(
			flattenText({
				output: { type: "output_text", text: "nested output" },
			}),
			"nested output",
		);

		const message = messageAt(
			parseOpenAIMessages([
				{
					role: "user",
					content: [
						{
							type: "input_image",
							source: {
								data: "CCCC",
								mime_type: "image/gif",
								file_name: "inline.gif",
							},
						},
						{
							type: "image_url",
							image_url: { url: "https://cdn.example.com/assets/raw.png" },
						},
						{ type: "file" },
						{ text: { type: "output_text", text: "fallback output" } },
					],
				},
			]),
			0,
		);
		assert.deepEqual(
			message.parts.map((part) => ({
				kind: part.kind,
				text: part.kind === "text" ? part.text : undefined,
				filename: "filename" in part ? part.filename : undefined,
				remoteUrl: "remoteUrl" in part ? part.remoteUrl : undefined,
				hasInline: "hasInline" in part ? part.hasInline : undefined,
			})),
			[
				{
					kind: "image",
					text: undefined,
					filename: "inline.gif",
					remoteUrl: "",
					hasInline: true,
				},
				{
					kind: "image",
					text: undefined,
					filename: "",
					remoteUrl: "https://cdn.example.com/assets/raw.png",
					hasInline: false,
				},
				{
					kind: "file",
					text: undefined,
					filename: "",
					remoteUrl: "",
					hasInline: undefined,
				},
				{
					kind: "text",
					text: "fallback output",
					filename: undefined,
					remoteUrl: undefined,
					hasInline: undefined,
				},
			],
		);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const cyclicMessage = messageAt(
			parseOpenAIMessages([{ role: "user", content: cyclic }]),
			0,
		);
		assert.equal(textPartAt(cyclicMessage, 0).text, "[object Object]");
	});
});
