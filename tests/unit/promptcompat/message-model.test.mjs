import { describe, test } from "vitest";
import {
	flattenText,
	historyContentText,
	parseOpenAIMessages,
	rawRecordReasoningText,
} from "../../../src/promptcompat/message-model";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("renders history and flattened content fallbacks", async () => {
		const cyclic = {};
		cyclic.self = cyclic;
		const [message] = parseOpenAIMessages([{ role: "user", content: cyclic }]);
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
		const [imageMessage, fileMessage, textMessage] = parseOpenAIMessages([
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

		assert.deepEqual(
			{
				kind: imageMessage.parts[0].kind,
				filename: imageMessage.parts[0].filename,
				hasInline: imageMessage.parts[0].hasInline,
				mime: imageMessage.parts[0].mime,
			},
			{
				kind: "image",
				filename: "inline.gif",
				hasInline: true,
				mime: "image/gif",
			},
		);
		assert.deepEqual(fileMessage.parts[0].fileRef, {
			id: "file-1",
			name: "document.txt",
		});
		assert.equal(textMessage.parts[0].text, "fallback output");
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

		const [message] = parseOpenAIMessages([
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
		]);
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
		const cyclic = {};
		cyclic.self = cyclic;
		const [cyclicMessage] = parseOpenAIMessages([
			{ role: "user", content: cyclic },
		]);
		assert.equal(cyclicMessage.parts[0].text, "[object Object]");
	});
});
