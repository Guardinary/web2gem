import { describe, test } from "vitest";
import type { AttachmentSource } from "../../../src/attachments/types";
import { openAIAttachmentPlanFromRequest } from "../../../src/promptcompat/attachment-inputs";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { assert } from "../assertions.js";

function base64Data(source: AttachmentSource): unknown {
	if (source.type !== "base64")
		throw new TypeError("expected a base64 attachment source");
	return source.data;
}

describe("prompt compatibility request attachments", () => {
	test("classifies OpenAI request attachments without upload transport", async () => {
		const request = {
			ref_file_ids: ["file-top"],
			input: [
				{
					type: "input_file",
					file_id: "file-input",
					filename: "responses-existing.txt",
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "input_file",
							data: "ZG9udA==",
							filename: "content-direct.txt",
							mime_type: "text/plain",
						},
						{
							type: "input_file",
							file_id: "file-message",
							filename: "message-existing.txt",
						},
					],
					attachments: [
						{
							type: "input_file",
							file_data: "bXNn",
							filename: "message-attach.txt",
							mime_type: "text/plain",
						},
					],
				},
			],
			attachments: [
				{
					type: "input_file",
					id: "inline-id",
					file_data: "aGVsbG8=",
					filename: "note.txt",
					mime: "text/plain",
				},
				{
					type: "input_file",
					file_id: "file-existing",
					filename: "existing.txt",
				},
				{
					type: "input_file",
					file: {
						id: "nested-inline-id",
						data: "AA==",
						filename: "nested.txt",
						mime: "application/octet-stream",
					},
				},
				{ type: "input_file", filename: "missing.txt" },
				{
					content: [
						{
							type: "input_file",
							file_data: "d3JhcA==",
							filename: "wrapped.txt",
							mime_type: "text/plain",
						},
					],
				},
				{ type: "text", text: "ignored" },
			],
		};
		const plan = openAIAttachmentPlanFromRequest(
			request,
			parseOpenAIMessages(request.messages),
		);
		assert.deepEqual(plan.existingFileRefs, [
			"file-top",
			{ id: "file-existing", name: "existing.txt" },
			{ id: "file-message", name: "message-existing.txt" },
			{ id: "file-input", name: "responses-existing.txt" },
		]);
		assert.equal(plan.candidates.length, 5);
		assert.deepEqual(
			plan.candidates.map((candidate) => ({
				kind: candidate.kind,
				filename: candidate.filename,
				mime: candidate.mime,
				sourceType: candidate.source.type,
			})),
			[
				{
					kind: "file",
					filename: "note.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "nested.txt",
					mime: "application/octet-stream",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "wrapped.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "content-direct.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
				{
					kind: "file",
					filename: "message-attach.txt",
					mime: "text/plain",
					sourceType: "base64",
				},
			],
		);
		assert.deepEqual(
			plan.dropped.map((drop) => ({
				kind: drop.kind,
				code: drop.code,
				filename: drop.filename,
			})),
			[{ kind: "file", code: "invalid_file_input", filename: "missing.txt" }],
		);
	});
	test("classifies OpenAI request-level image blocks without upload transport", async () => {
		const plan = openAIAttachmentPlanFromRequest(
			{
				attachments: [
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,QUJDRA==" },
						filename: "../outer.png",
					},
					{
						type: "image_url",
						url: "data:image/gif;base64,R0lGODlh",
						filename: "direct.gif",
					},
				],
				files: [
					{
						type: "input_image",
						image_url: "data:;base64,BBBB",
						mime_type: "image/jpeg",
						filename: "inline.jpg",
					},
				],
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: {
									url: "data:image/png;base64,SHOULD_NOT_DUPLICATE==",
								},
							},
						],
					},
				],
			},
			[],
		);
		assert.equal(plan.candidates.length, 3);
		assert.deepEqual(
			plan.candidates.map((candidate) => ({
				kind: candidate.kind,
				filename: candidate.filename,
				mime: candidate.mime,
				sourceType: candidate.source.type,
				data: base64Data(candidate.source),
			})),
			[
				{
					kind: "image",
					filename: "outer.png",
					mime: "image/png",
					sourceType: "base64",
					data: "QUJDRA==",
				},
				{
					kind: "image",
					filename: "direct.gif",
					mime: "image/gif",
					sourceType: "base64",
					data: "R0lGODlh",
				},
				{
					kind: "image",
					filename: "inline.jpg",
					mime: "image/jpeg",
					sourceType: "base64",
					data: "BBBB",
				},
			],
		);
		assert.deepEqual(
			openAIAttachmentPlanFromRequest(
				{
					attachments: [
						{
							type: "image_url",
							image_url: { url: "data:image/webp;base64,V0VCUA==" },
							filename: "outer.webp",
						},
					],
				},
				[],
			).candidates.map((candidate) => ({
				b64: base64Data(candidate.source),
				mime: candidate.mime,
				filename: candidate.filename,
			})),
			[{ b64: "V0VCUA==", mime: "image/webp", filename: "outer.webp" }],
		);
	});
});
