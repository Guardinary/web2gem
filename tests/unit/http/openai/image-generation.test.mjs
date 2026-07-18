import { describe, test } from "vitest";
import { prepareOpenAIImageGenerationCompletion as prepareOpenAIImageGenerationFromMessages } from "../../../../src/completion/image-generation";
import {
	imageGenerationMode,
	isImageGenerationRequest,
} from "../../../../src/http/openai/image-generation";
import { parseOpenAIMessages } from "../../../../src/promptcompat/message-model";
import { normalizeResponsesInputAsMessages } from "../../../../src/promptcompat/responses-input";
import { assert } from "../../assertions.js";
import { attachmentResult, baseConfig } from "../../helpers.js";
import { strictProvider } from "../_support/provider.js";

function prepareOpenAIImageGenerationCompletion(
	cfg,
	provider,
	req,
	route,
	forced,
) {
	const messages =
		route === "responses"
			? parseOpenAIMessages(normalizeResponsesInputAsMessages(req, true))
			: parseOpenAIMessages(req.messages);
	return prepareOpenAIImageGenerationFromMessages(
		cfg,
		provider,
		req,
		route,
		forced,
		messages,
	);
}

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("OpenAI image generation preparation", () => {
	test("detects explicit image generation metadata only", async () => {
		assert.deepEqual(
			imageGenerationMode({ tool_choice: { type: "image_generation" } }),
			{
				enabled: true,
				forced: true,
				tool: { type: "image_generation" },
			},
		);
		assert.equal(
			imageGenerationMode({
				tools: [{ type: "image_generation", output_format: "png" }],
			}).enabled,
			true,
		);
		assert.equal(
			imageGenerationMode({
				tool_choice: "auto",
				tools: [{ type: "function", function: { name: "x" } }],
			}).enabled,
			false,
		);
		assert.equal(
			isImageGenerationRequest({ input: "please generate an image" }),
			false,
		);
	});
	test("rejects empty or oversized image-generation prompts and unknown models", async () => {
		const noPrompt = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				messages: null,
			},
			"chat",
			false,
		);
		assert.equal(noPrompt.error.code, "image_generation_empty_prompt");

		const invalidModel = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "not-a-model",
				input: "draw",
			},
			"responses",
			false,
		);
		assert.equal(invalidModel.error.code, "model_not_found");

		const tooLarge = await prepareOpenAIImageGenerationCompletion(
			baseConfig({
				cookie: "SID=ok",
				current_input_file_min_bytes: 10,
			}),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				input: `draw ${"x".repeat(100)}`,
			},
			"responses",
			false,
		);
		assert.equal(tooLarge.error.code, "image_generation_prompt_too_large");
	});

	test("maps image-generation attachment resolve failures and missing refs", async () => {
		const uploadErr = new Error("upload refused");
		uploadErr.status = 504;
		uploadErr.code = "image_upload_refused";
		const uploadFailed = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async resolveAttachments() {
					throw uploadErr;
				},
			}),
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "edit it" },
							{
								type: "input_image",
								image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
							},
						],
					},
				],
			},
			"responses",
			true,
		);
		assert.equal(uploadFailed.error.status, 504);
		assert.equal(uploadFailed.error.code, "image_upload_refused");

		const missingUploadRef = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async resolveAttachments() {
					return attachmentResult({ fileRefs: [] });
				},
			}),
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "edit it" },
							{
								type: "input_image",
								image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
							},
						],
					},
				],
			},
			"responses",
			false,
		);
		assert.equal(missingUploadRef.error.code, "image_input_upload_failed");
	});

	test("rejects invalid image base64 and excessive image counts", async () => {
		const invalidBase64 = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "edit it" },
							{ type: "input_image", image_url: "data:image/png;base64,%%%" },
						],
					},
				],
			},
			"responses",
			false,
		);
		assert.equal(invalidBase64.error.code, "image_input_unsupported");

		const tooManyImages = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "edit all images" },
							...Array.from({ length: 51 }, () => ({
								type: "input_image",
								image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
							})),
						],
					},
				],
			},
			"responses",
			false,
		);
		assert.equal(tooManyImages.error.code, "image_input_unsupported");
		assert.match(tooManyImages.error.message, /at most 50/);
	});
	test("extracts image-generation prompts from Responses and Chat input shapes", async () => {
		const responseObject = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				input: { type: "input_text", text: "draw from a direct object" },
			},
			"responses",
			false,
		);
		assert.equal("error" in responseObject, false);
		assert.match(responseObject.prompt, /draw from a direct object/);

		const inputMessageText = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				input: [{ type: "input_message", role: "user", text: 42 }],
			},
			"responses",
			false,
		);
		assert.equal("error" in inputMessageText, false);
		assert.match(inputMessageText.prompt, /42/);

		const chatTextFallback = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				messages: [
					{ role: "assistant", content: "ignored" },
					{ role: "user", text: "draw from message text" },
				],
			},
			"chat",
			false,
		);
		assert.equal("error" in chatTextFallback, false);
		assert.match(chatTextFallback.prompt, /draw from message text/);
	});

	test("extracts existing and inline image-generation file references", async () => {
		const nestedExistingRef = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{ type: "input_text", text: "edit the attached file" },
							{
								type: "input_file",
								file: { id: "nested_file", filename: "nested.png" },
							},
						],
					},
				],
			},
			"responses",
			false,
		);
		assert.equal("error" in nestedExistingRef, false);
		assert.deepEqual(nestedExistingRef.fileRefs, [
			{ id: "nested_file", name: "nested.png" },
		]);

		const inlineFilePlans = [];
		const inlineFile = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async resolveAttachments(plan) {
					inlineFilePlans.push(plan);
					return attachmentResult({
						fileRefs: [
							{ ref: "/uploaded/inline-file.png", name: "inline-file.png" },
						],
					});
				},
			}),
			{
				model: "gemini-3.5-flash",
				input: [
					"edit this file image",
					{
						type: "input_file",
						file_data: {
							data: TINY_PNG_BASE64,
							mime_type: "image/png",
							filename: "inline-file.png",
						},
					},
				],
			},
			"responses",
			false,
		);
		assert.equal("error" in inlineFile, false);
		assert.equal(inlineFilePlans.length, 1);
		assert.equal(inlineFilePlans[0].candidates[0].filename, "inline-file.png");
		assert.equal(inlineFilePlans[0].candidates[0].mime, "image/png");
		assert.deepEqual(inlineFile.fileRefs, [
			{ ref: "/uploaded/inline-file.png", name: "inline-file.png" },
		]);
	});
	test("preserves image-mode user file ref encounter order including duplicates", async () => {
		const provider = strictProvider({
			async resolveAttachments() {
				return attachmentResult({
					fileRefs: [{ ref: "/uploaded/second.png", name: "second.png" }],
				});
			},
		});
		const prepared = await prepareOpenAIImageGenerationCompletion(
			baseConfig({ cookie: "SID=ok" }),
			provider,
			{
				model: "gemini-3.5-flash",
				input: [
					{
						role: "user",
						content: [
							{
								type: "input_text",
								text: "combine the first and second image",
							},
							{
								type: "input_image",
								file_id: "file_first",
								filename: "first.png",
							},
							{
								type: "input_image",
								image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
								filename: "second.png",
							},
							{
								type: "input_image",
								file_id: "file_first",
								filename: "first-again.png",
							},
						],
					},
				],
			},
			"responses",
			false,
		);
		assert.equal(!("error" in prepared), true);
		assert.deepEqual(prepared.fileRefs, [
			{ id: "file_first", name: "first.png" },
			{ ref: "/uploaded/second.png", name: "second.png" },
			{ id: "file_first", name: "first-again.png" },
		]);
	});
	test("detects remote image-generation input variants before provider generation", async () => {
		const variants = [
			{ type: "input_image", url: "https://cdn.example.com/direct.png" },
			{
				type: "input_image",
				source: { url: "https://cdn.example.com/source.png" },
			},
			{
				type: "input_image",
				image_url: { url: "https://cdn.example.com/nested.png" },
			},
			{
				type: "input_file",
				file: { url: "https://cdn.example.com/file.png" },
			},
			{
				type: "input_file",
				file_data: { file_uri: "https://cdn.example.com/data.png" },
			},
		];
		for (const part of variants) {
			const prepared = await prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				strictProvider({
					async resolveAttachments() {
						throw new Error(
							"resolveAttachments should not run for remote image inputs",
						);
					},
				}),
				{
					model: "gemini-3.5-flash",
					input: [
						{
							role: "user",
							content: [{ type: "input_text", text: "edit it" }, part],
						},
					],
				},
				"responses",
				false,
			);
			assert.equal(prepared.error.code, "image_input_unsupported");
		}
	});
});
