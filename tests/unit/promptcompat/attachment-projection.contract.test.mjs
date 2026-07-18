import { describe, test } from "vitest";
import {
	attachmentInputsFromMessages,
	attachmentPlanFromMessages,
} from "../../../src/promptcompat/attachment-inputs";
import { parseGoogleRequest } from "../../../src/promptcompat/google";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { messagesToPrompt } from "../../../src/promptcompat/messages";
import { parseResponsesInput } from "../../../src/promptcompat/responses-input";
import { assert } from "../assertions.js";

describe("prompt compatibility", () => {
	test("projects top-level Responses input_file items into upload candidates", async () => {
		const parsed = parseResponsesInput({
			input: [
				{ type: "input_text", text: "review this" },
				{
					type: "input_file",
					filename: "../note.txt",
					data: "aGVsbG8=",
					mime_type: "text/plain",
				},
			],
		});
		assert.equal(parsed.error, undefined);

		const result = messagesToPrompt(parsed.messages, null, 1000000);
		assert.match(result.text, /\[file input note\.txt\]/);
		assert.deepEqual(
			attachmentPlanFromMessages(parsed.messages).candidates.map((c) => ({
				mime: c.mime,
				filename: c.filename,
				data: c.source.type === "base64" ? c.source.data : undefined,
			})),
			[{ mime: "text/plain", filename: "note.txt", data: "aGVsbG8=" }],
		);
	});
	test("converts mixed Responses content parts to prompt text and image refs", async () => {
		const messages = parseOpenAIMessages([
			{
				role: "user",
				content: [
					"plain",
					{ type: "input_text", text: "hello" },
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "checked" }],
					},
					{
						type: "image_url",
						image_url: {
							url: "https://cdn.example.com/folder/photo%201.png?x=1",
							filename: "../remote.jpg",
						},
					},
					{
						type: "input_image",
						source: {
							data: "AAAA",
							media_type: "image/jpeg",
							file_name: "nested.jpg",
						},
					},
					{
						type: "input_image",
						image_url: "data:image/webp;base64,BBBB",
						name: "data.webp",
					},
					{ type: "input_file", file_id: "file_1" },
					{
						type: "custom",
						output: [{ type: "output_text", text: "custom output" }],
					},
				],
			},
		]);
		const text = messagesToPrompt(messages, null, 1000000).text;
		const { images } = attachmentInputsFromMessages(messages);
		assert.match(text, /plain\nhello/);
		assert.match(
			text,
			/\[reasoning_content\]\nchecked\n\[\/reasoning_content\]/,
		);
		assert.equal((text.match(/\[image input\]/g) || []).length, 3);
		assert.match(text, /\[file input file_1\]/);
		assert.match(text, /custom output/);
		assert.deepEqual(images, [
			{
				b64: "AAAA",
				mime: "image/jpeg",
				filename: "nested.jpg",
			},
			{
				b64: "BBBB",
				mime: "image/webp",
				filename: "data.webp",
			},
		]);
	});
	test("collects inline input_file parts and treats remote file URLs as missing payloads", async () => {
		const messages = parseOpenAIMessages([
			{
				role: "user",
				content: [
					{ type: "input_text", text: "inspect code" },
					{
						type: "input_file",
						filename: "../main.py",
						file_data: "data:text/x-python;base64,cHJpbnQoMSkK",
					},
					{
						type: "input_file",
						filename: "note.txt",
						file_data: { data: "aGVsbG8=", mime_type: "text/plain" },
					},
					{
						type: "input_file",
						filename: "empty.txt",
						file_data: "",
						mime_type: "text/plain",
					},
					{
						type: "file",
						file_url: "https://files.example/archive/app.ts?sig=secret",
						filename: "app.ts",
					},
					{ type: "input_file", filename: "missing.txt" },
					{
						type: "input_file",
						file_id: "file_existing",
						filename: "existing.txt",
					},
				],
			},
		]);
		const text = messagesToPrompt(messages, null, 1000000).text;
		const { files, images } = attachmentInputsFromMessages(messages);
		assert.match(text, /inspect code/);
		assert.match(text, /\[file input main\.py\]/);
		assert.match(text, /\[file input note\.txt\]/);
		assert.match(text, /\[file input empty\.txt\]/);
		assert.match(text, /\[file input app\.ts\]/);
		assert.match(text, /\[file input missing\.txt\]/);
		assert.match(text, /\[file input file_existing\]/);
		assert.deepEqual(images, []);
		assert.deepEqual(files, [
			{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "main.py" },
			{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
			{ b64: "", mime: "text/plain", filename: "empty.txt" },
			{
				invalidReason: "missing generic file upload data",
				mime: "text/typescript",
				filename: "app.ts",
			},
			{
				invalidReason: "missing generic file upload data",
				mime: "text/plain",
				filename: "missing.txt",
			},
		]);

		const parsedFileMsg = parseOpenAIMessages([
			{
				role: "user",
				content: [
					{ type: "input_file", data: "aGVsbG8=", filename: "note.txt" },
				],
			},
		]);
		const result = messagesToPrompt(parsedFileMsg, null, 1000000);
		assert.match(result.text, /\[file input note\.txt\]/);
		assert.deepEqual(
			attachmentPlanFromMessages(parsedFileMsg).candidates.map((c) => ({
				mime: c.mime,
				filename: c.filename,
				data: c.source.type === "base64" ? c.source.data : undefined,
			})),
			[{ mime: "text/plain", filename: "note.txt", data: "aGVsbG8=" }],
		);
	});
	test("uses explicit image_url MIME metadata when a data URL omits MIME", async () => {
		const messages = parseOpenAIMessages([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "data:;base64,AAAA", mime_type: "image/jpeg" },
						filename: "photo.jpg",
					},
				],
			},
		]);
		const text = messagesToPrompt(messages, null, 1000000).text;
		const { images } = attachmentInputsFromMessages(messages);
		assert.equal(text, "[image input]");
		assert.deepEqual(images, [
			{ b64: "AAAA", mime: "image/jpeg", filename: "photo.jpg" },
		]);
	});
	test("uses top-level image_url data URL when image_url object is omitted", async () => {
		const messages = parseOpenAIMessages([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						url: "data:image/gif;base64,R0lGODlh",
						filename: "direct.gif",
					},
				],
			},
		]);
		const text = messagesToPrompt(messages, null, 1000000).text;
		const { images } = attachmentInputsFromMessages(messages);
		assert.equal(text, "[image input]");
		assert.deepEqual(images, [
			{ b64: "R0lGODlh", mime: "image/gif", filename: "direct.gif" },
		]);
	});
	test("projects normalized Google inline file parts into attachment plans", async () => {
		const camelPlan = attachmentPlanFromMessages(
			parseGoogleRequest({
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
			}),
		);
		const snakePlan = attachmentPlanFromMessages(
			parseGoogleRequest({
				contents: [
					{
						role: "user",
						parts: [
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
			}),
		);

		assert.deepEqual(
			camelPlan.candidates.map((candidate) => ({
				kind: candidate.kind,
				filename: candidate.filename,
				mime: candidate.mime,
				data: candidate.source.data,
			})),
			[
				{
					kind: "file",
					filename: "inline.js",
					mime: "text/javascript",
					data: "Y29uc29sZS5sb2coMSk=",
				},
			],
		);
		assert.deepEqual(
			snakePlan.candidates.map((candidate) => ({
				filename: candidate.filename,
				mime: candidate.mime,
				data: candidate.source.data,
			})),
			[
				{
					filename: "readme.md",
					mime: "text/markdown",
					data: "IyBUaXRsZQ==",
				},
			],
		);
	});

	test("projects normalized Google inline images into attachment plans", async () => {
		const plan = attachmentPlanFromMessages(
			parseGoogleRequest({
				contents: [
					{
						role: "user",
						parts: [
							{
								inline_data: {
									data: "R0lGODlh",
									mime_type: "image/gif",
									display_name: "diagram.gif",
								},
							},
							{
								fileData: {
									fileUri: "https://files.example/remote.png",
									mimeType: "image/png",
								},
							},
						],
					},
				],
			}),
		);

		assert.deepEqual(
			plan.candidates.map((candidate) => ({
				kind: candidate.kind,
				filename: candidate.filename,
				mime: candidate.mime,
				data: candidate.source.data,
			})),
			[
				{
					kind: "image",
					filename: "diagram.gif",
					mime: "image/gif",
					data: "R0lGODlh",
				},
			],
		);
	});
});
