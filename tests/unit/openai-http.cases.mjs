import { assert } from "./assertions.js";
import {
	attachmentResult,
	baseConfig,
	chunks,
	collectSSEData,
	fakeProvider,
	fakeStreamProvider,
	mod,
	resolvedModel,
	streamError,
	withConsoleLog,
} from "./helpers.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = mod.base64ToBytes(TINY_PNG_BASE64);

function tinyPngFile(name = "input.png") {
	return new File([TINY_PNG_BYTES], name, { type: "image/png" });
}

export const suiteName = "openai http";
export const cases = [
	[
		"detects explicit image generation metadata only",
		async () => {
			assert.deepEqual(
				mod.imageGenerationMode({ tool_choice: { type: "image_generation" } }),
				{
					enabled: true,
					forced: true,
					tool: { type: "image_generation" },
				},
			);
			assert.equal(
				mod.imageGenerationMode({
					tools: [{ type: "image_generation", output_format: "png" }],
				}).enabled,
				true,
			);
			assert.equal(
				mod.imageGenerationMode({
					tool_choice: "auto",
					tools: [{ type: "function", function: { name: "x" } }],
				}).enabled,
				false,
			);
			assert.equal(
				mod.isImageGenerationRequest({ input: "please generate an image" }),
				false,
			);
		},
	],
	[
		"requires cookie for image generation and rejects streaming before upstream work",
		async () => {
			let generated = false;
			const noCookie = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "draw a red square",
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "" }),
				fakeProvider({
					supportsAuthenticatedSession: false,
					async generateRich() {
						generated = true;
						return { text: "upstream no-cookie result", images: [] };
					},
				}),
			);
			assert.equal(noCookie.status, 422);
			const noCookieBody = await noCookie.json();
			assert.equal(
				noCookieBody.error.code,
				"gemini_authenticated_session_required",
			);
			assert.equal(noCookieBody.error.reason, "image");
			assert.equal(generated, false);

			const noCookieEndpoint = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw a red square",
				},
				baseConfig({ cookie: "" }),
				fakeProvider({
					supportsAuthenticatedSession: false,
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(noCookieEndpoint.status, 422);
			const noCookieEndpointBody = await noCookieEndpoint.json();
			assert.equal(
				noCookieEndpointBody.error.code,
				"gemini_authenticated_session_required",
			);
			assert.equal(noCookieEndpointBody.error.reason, "image");
			assert.equal(generated, false);

			const stream = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					stream: true,
					messages: [{ role: "user", content: "draw a red square" }],
					tool_choice: { type: "image_generation" },
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(stream.status, 400);
			assert.equal(
				(await stream.json()).error.code,
				"unsupported_image_generation_stream",
			);
		},
	],
	[
		"covers image generation preparation validation branches",
		async () => {
			const noPrompt = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
				{
					model: "gemini-3.5-flash",
					messages: null,
				},
				"chat",
				false,
			);
			assert.equal(noPrompt.error.code, "image_generation_empty_prompt");

			const invalidModel = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
				{
					model: "not-a-model",
					input: "draw",
				},
				"responses",
				false,
			);
			assert.equal(invalidModel.error.code, "model_not_found");

			const tooLarge = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({
					cookie: "SID=ok",
					current_input_file_min_bytes: 10,
				}),
				fakeProvider(),
				{
					model: "gemini-3.5-flash",
					input: `draw ${"x".repeat(100)}`,
				},
				"responses",
				false,
			);
			assert.equal(tooLarge.error.code, "image_generation_prompt_too_large");

			const uploadErr = new Error("upload refused");
			uploadErr.status = 504;
			uploadErr.code = "image_upload_refused";
			const uploadFailed = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
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

			const missingUploadRef = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
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

			const invalidBase64 = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
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

			const tooManyImages = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
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
		},
	],
	[
		"extracts image generation prompt and reference variants",
		async () => {
			const responseObject = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
				{
					model: "gemini-3.5-flash",
					input: { type: "input_text", text: "draw from a direct object" },
				},
				"responses",
				false,
			);
			assert.equal("error" in responseObject, false);
			assert.match(responseObject.prompt, /draw from a direct object/);

			const inputMessageText = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
				{
					model: "gemini-3.5-flash",
					input: [{ type: "input_message", role: "user", text: 42 }],
				},
				"responses",
				false,
			);
			assert.equal("error" in inputMessageText, false);
			assert.match(inputMessageText.prompt, /42/);

			const chatTextFallback = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
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

			const nestedExistingRef =
				await mod.prepareOpenAIImageGenerationCompletion(
					baseConfig({ cookie: "SID=ok" }),
					fakeProvider(),
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
			const inlineFile = await mod.prepareOpenAIImageGenerationCompletion(
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
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
			assert.equal(
				inlineFilePlans[0].candidates[0].filename,
				"inline-file.png",
			);
			assert.equal(inlineFilePlans[0].candidates[0].mime, "image/png");
			assert.deepEqual(inlineFile.fileRefs, [
				{ ref: "/uploaded/inline-file.png", name: "inline-file.png" },
			]);
		},
	],
	[
		"detects remote image-generation input variants before provider generation",
		async () => {
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
				const prepared = await mod.prepareOpenAIImageGenerationCompletion(
					baseConfig({ cookie: "SID=ok" }),
					fakeProvider({
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
		},
	],
	[
		"returns image provider unsupported and upstream errors consistently",
		async () => {
			const unsupportedChat = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "draw" }],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
			);
			assert.equal(unsupportedChat.status, 502);
			assert.equal(
				(await unsupportedChat.json()).error.code,
				"image_generation_provider_unsupported",
			);

			const unsupportedResponses = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "draw",
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
			);
			assert.equal(unsupportedResponses.status, 502);
			assert.equal(
				(await unsupportedResponses.json()).error.code,
				"image_generation_provider_unsupported",
			);

			const unsupportedImages = await mod.handleImageGenerations(
				{
					prompt: "draw",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider(),
			);
			assert.equal(unsupportedImages.status, 502);
			assert.equal(
				(await unsupportedImages.json()).error.code,
				"image_generation_provider_unsupported",
			);

			const upstreamErr = new Error("upstream refused image generation");
			upstreamErr.status = 503;
			upstreamErr.code = "upstream_refused";
			const upstreamFailure = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "draw",
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						throw upstreamErr;
					},
				}),
			);
			assert.equal(upstreamFailure.status, 503);
			assert.equal(
				(await upstreamFailure.json()).error.code,
				"upstream_refused",
			);

			const responseStream = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "draw",
					stream: true,
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						throw new Error("generateRich should not run for image streams");
					},
				}),
			);
			assert.equal(responseStream.status, 400);
			assert.equal(
				(await responseStream.json()).error.code,
				"unsupported_image_generation_stream",
			);
		},
	],
	[
		"routes Responses image generation through user-only prompt and image_generation_call output",
		async () => {
			const prompts = [];
			const plans = [];
			const provider = fakeProvider({
				async resolveAttachments(plan) {
					plans.push(plan);
					return attachmentResult({
						fileRefs: [{ ref: "/uploaded/input.png", name: "input.png" }],
						imageFileRefs: [{ ref: "/uploaded/input.png", name: "input.png" }],
					});
				},
				async generateRich(input) {
					prompts.push(input);
					return {
						text: "caption",
						images: [
							{
								url: "https://images.example/generated.png",
								source: "generated",
								base64: TINY_PNG_BASE64,
								outputFormat: "png",
							},
						],
					};
				},
			});
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					instructions: "LEAK instructions",
					input: [
						{ type: "message", role: "system", content: "LEAK system" },
						{ type: "output_text", text: "LEAK prior output" },
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "input_image",
									image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
								},
							],
						},
						{
							type: "message",
							role: "user",
							content: [
								{ type: "input_text", text: "draw a small blue logo" },
								{
									type: "input_image",
									image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
									filename: "input.png",
								},
							],
						},
					],
					tools: [
						{ type: "image_generation" },
						{
							type: "function",
							function: { name: "Search", description: "LEAK tool schema" },
						},
					],
				},
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(resp.status, 200);
			assert.equal(plans.length, 1);
			assert.equal(plans[0].candidates.length, 1);
			assert.equal(prompts.length, 1);
			assert.match(prompts[0].prompt, /draw a small blue logo/);
			assert.match(prompts[0].prompt, /IMAGE GENERATION ENABLED/);
			assert.doesNotMatch(
				prompts[0].prompt,
				/LEAK|Available tools|<\|DSML\|tool_calls>|\[image input\]/,
			);
			assert.deepEqual(prompts[0].fileRefs, [
				{ ref: "/uploaded/input.png", name: "input.png" },
			]);

			const body = await resp.json();
			const message = body.output.find((item) => item.type === "message");
			assert.equal(message.content[0].text, "caption");
			assert.doesNotMatch(message.content[0].text, /data:image/);
			const imageCall = body.output.find(
				(item) => item.type === "image_generation_call",
			);
			assert.equal(!!imageCall, true);
			assert.equal(imageCall.status, "completed");
			assert.equal(imageCall.result, TINY_PNG_BASE64);
			assert.equal(imageCall.output_format, "png");
		},
	],
	[
		"preserves image-mode user file ref encounter order including duplicates",
		async () => {
			const provider = fakeProvider({
				async resolveAttachments() {
					return attachmentResult({
						fileRefs: [{ ref: "/uploaded/second.png", name: "second.png" }],
					});
				},
			});
			const prepared = await mod.prepareOpenAIImageGenerationCompletion(
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
		},
	],
	[
		"rejects unsupported image-mode inputs clearly",
		async () => {
			const remote = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "edit it" },
								{
									type: "input_image",
									image_url: "https://cdn.example.com/image.png",
								},
							],
						},
					],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(remote.status, 400);
			assert.equal((await remote.json()).error.code, "image_input_unsupported");

			const remoteWithPartID = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "edit it" },
								{
									type: "input_image",
									id: "content_part_1",
									image_url: "https://cdn.example.com/image.png",
								},
							],
						},
					],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						throw new Error(
							"generateRich should not run for remote image URLs",
						);
					},
				}),
			);
			assert.equal(remoteWithPartID.status, 400);
			assert.equal(
				(await remoteWithPartID.json()).error.code,
				"image_input_unsupported",
			);

			const textBytes = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "edit it" },
								{
									type: "input_image",
									image_url: "data:text/plain;base64,aGVsbG8=",
								},
							],
						},
					],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(textBytes.status, 400);
			assert.equal(
				(await textBytes.json()).error.code,
				"image_input_unsupported",
			);

			const nonImageFile = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "edit it" },
								{
									type: "input_file",
									file_data: "data:application/pdf;base64,JVBERi0=",
									filename: "not-image.pdf",
								},
							],
						},
					],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						throw new Error(
							"generateRich should not run for non-image file inputs",
						);
					},
				}),
			);
			assert.equal(nonImageFile.status, 400);
			assert.equal(
				(await nonImageFile.json()).error.code,
				"image_input_unsupported",
			);
		},
	],
	[
		"returns client-usable Chat image generation markdown without counting image base64 as tokens",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [
						{ role: "system", content: "LEAK system" },
						{ role: "user", content: "ignored older user" },
						{ role: "assistant", content: "ignored assistant" },
						{
							role: "user",
							content: [{ type: "text", text: "draw a tiny icon" }],
						},
					],
					tool_choice: { type: "image_generation" },
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich(input) {
						assert.match(input.prompt, /draw a tiny icon/);
						assert.doesNotMatch(
							input.prompt,
							/LEAK|ignored older user|ignored assistant/,
						);
						return {
							text: "done",
							images: [
								{
									url: "https://images.example/generated.png",
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.match(
				body.choices[0].message.content,
				/^done\n\n!\[image\]\(data:image\/png;base64,/,
			);
			assert.equal(body.usage.completion_tokens < 10, true);
		},
	],
	[
		"passes through tools-only image mode text when upstream returns no image",
		async () => {
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "generate an image, but upstream replies with text",
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "upstream text only", images: [] };
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.equal(body.output[0].content[0].text, "upstream text only");
			assert.equal(
				body.output.some((item) => item.type === "image_generation_call"),
				false,
			);
		},
	],
	[
		"rejects empty tools-only image output instead of returning blank success",
		async () => {
			const chat = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "generate an image" }],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(chat.status, 502);
			assert.equal(
				(await chat.json()).error.code,
				"upstream_image_generation_empty",
			);

			const responses = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "generate an image",
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "   ", images: [] };
					},
				}),
			);
			assert.equal(responses.status, 502);
			assert.equal(
				(await responses.json()).error.code,
				"upstream_image_generation_empty",
			);
		},
	],
	[
		"keeps forced image mode no-image failure",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "generate an image" }],
					tool_choice: { type: "image_generation" },
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "text but no image", images: [] };
					},
				}),
			);
			assert.equal(resp.status, 502);
			assert.equal(
				(await resp.json()).error.code,
				"upstream_image_generation_empty",
			);

			const webOnlyChat = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "generate an image" }],
					tool_choice: { type: "image_generation" },
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return {
							text: "",
							images: [
								{ url: "https://images.example/web.png", source: "web" },
							],
						};
					},
				}),
			);
			assert.equal(webOnlyChat.status, 502);
			assert.equal(
				(await webOnlyChat.json()).error.code,
				"upstream_image_generation_empty",
			);

			const webOnlyResponses = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "generate an image",
					tool_choice: { type: "image_generation" },
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return {
							text: "",
							images: [
								{ url: "https://images.example/web.png", source: "web" },
							],
						};
					},
				}),
			);
			assert.equal(webOnlyResponses.status, 502);
			assert.equal(
				(await webOnlyResponses.json()).error.code,
				"upstream_image_generation_empty",
			);
		},
	],
	[
		"passes through URL-only image output as markdown",
		async () => {
			const chat = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "show an image" }],
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return {
							text: "see image",
							images: [
								{
									url: "https://images.example/generated.png",
									source: "generated",
									alt: "generated result",
								},
							],
						};
					},
				}),
			);
			assert.equal(chat.status, 200);
			assert.equal(
				(await chat.json()).choices[0].message.content,
				"see image\n\n![generated result](https://images.example/generated.png)",
			);

			const responses = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "show an image",
					tools: [{ type: "image_generation" }],
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return {
							text: "",
							images: [
								{
									url: "https://images.example/web.png",
									source: "web",
									alt: "web result",
								},
							],
						};
					},
				}),
			);
			assert.equal(responses.status, 200);
			const body = await responses.json();
			assert.equal(
				body.output[0].content[0].text,
				"![web result](https://images.example/web.png)",
			);
			assert.equal(
				body.output.some((item) => item.type === "image_generation_call"),
				false,
			);
		},
	],
	[
		"routes OpenAI Images generations through forced image mode",
		async () => {
			let seenInput = null;
			const resp = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw an endpoint logo",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich(input) {
						seenInput = input;
						return {
							text: "ignored text",
							images: [
								{
									url: "https://images.example/generated.png",
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.match(seenInput.prompt, /draw an endpoint logo/);
			assert.match(seenInput.prompt, /IMAGE GENERATION ENABLED/);
			assert.doesNotMatch(
				seenInput.prompt,
				/Available tools|<\|DSML\|tool_calls>/,
			);
			assert.equal(seenInput.fileRefs, null);
			const body = await resp.json();
			assert.equal(typeof body.created, "number");
			assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
		},
	],
	[
		"parses OpenAI Images JSON stream values compatibly",
		async () => {
			let generated = 0;
			const provider = fakeProvider({
				async generateRich() {
					generated += 1;
					return {
						text: "",
						images: [
							{
								url: "https://images.example/generated.png",
								source: "generated",
								base64: TINY_PNG_BASE64,
								outputFormat: "png",
							},
						],
					};
				},
			});

			const falseString = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw with string false stream",
					stream: "false",
				},
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(falseString.status, 200);
			assert.equal(generated, 1);

			const trueString = await mod.handleImageGenerations(
				{
					prompt: "draw with string true stream",
					stream: "true",
				},
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(trueString.status, 400);
			assert.equal(
				(await trueString.json()).error.code,
				"unsupported_image_generation_stream",
			);

			const invalidString = await mod.handleImageGenerations(
				{
					prompt: "draw with invalid stream",
					stream: "maybe",
				},
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(invalidString.status, 400);
			assert.equal((await invalidString.json()).error.code, "invalid_request");
			assert.equal(generated, 1);
		},
	],
	[
		"routes OpenAI Images edits through JSON image inputs",
		async () => {
			const plans = [];
			let seenInput = null;
			const resp = await mod.handleImageEdits(
				{
					model: "gemini-3.5-flash",
					prompt: "replace the background",
					image: { b64_json: TINY_PNG_BASE64, filename: "first.png" },
					image_url: {
						url: `data:image/png;base64,${TINY_PNG_BASE64}`,
						filename: "second.png",
					},
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async resolveAttachments(plan) {
						plans.push(plan);
						return attachmentResult({
							fileRefs: [
								{ ref: "/uploaded/first.png", name: "first.png" },
								{ ref: "/uploaded/second.png", name: "second.png" },
							],
						});
					},
					async generateRich(input) {
						seenInput = input;
						return {
							text: "",
							images: [
								{
									url: "https://images.example/edit.png",
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.equal(plans.length, 1);
			assert.equal(plans[0].candidates.length, 2);
			assert.deepEqual(
				plans[0].candidates.map((candidate) => candidate.kind),
				["image", "image"],
			);
			assert.deepEqual(seenInput.fileRefs, [
				{ ref: "/uploaded/first.png", name: "first.png" },
				{ ref: "/uploaded/second.png", name: "second.png" },
			]);
			const body = await resp.json();
			assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
		},
	],
	[
		"routes OpenAI Images multipart edits through ordered image inputs",
		async () => {
			const form = new FormData();
			form.append("model", "gemini-3.5-flash");
			form.append("prompt", "edit the uploaded references");
			form.append("image", tinyPngFile("first.png"));
			form.append("image_url", `data:image/png;base64,${TINY_PNG_BASE64}`);
			form.append("images[]", tinyPngFile("third.png"));

			const plans = [];
			let seenInput = null;
			const resp = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: form,
				}),
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async resolveAttachments(plan) {
						plans.push(plan);
						return attachmentResult({
							fileRefs: [
								{ ref: "/uploaded/first.png", name: "first.png" },
								{ ref: "/uploaded/second.png", name: "second.png" },
								{ ref: "/uploaded/third.png", name: "third.png" },
							],
						});
					},
					async generateRich(input) {
						seenInput = input;
						return {
							text: "",
							images: [
								{
									url: "https://images.example/edit.png",
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);

			assert.equal(resp.status, 200);
			assert.equal(plans.length, 1);
			assert.deepEqual(
				plans[0].candidates.map((candidate) => candidate.filename),
				["first.png", "image-2.png", "third.png"],
			);
			assert.deepEqual(seenInput.fileRefs, [
				{ ref: "/uploaded/first.png", name: "first.png" },
				{ ref: "/uploaded/second.png", name: "second.png" },
				{ ref: "/uploaded/third.png", name: "third.png" },
			]);
			const body = await resp.json();
			assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
		},
	],
	[
		"accepts OpenAI Images multipart edit field aliases and JSON reference strings",
		async () => {
			const form = new FormData();
			form.append("model", "gemini-3.5-flash");
			form.append("prompt", "edit all alias references");
			form.append("stream", "false");
			form.append("image[]", tinyPngFile("bracket.png"));
			form.append(
				"images",
				JSON.stringify([
					{ b64_json: TINY_PNG_BASE64, filename: "images-array-a.png" },
					{
						image_url: `data:image/png;base64,${TINY_PNG_BASE64}`,
						filename: "images-array-b.png",
					},
				]),
			);
			form.append("image_url[]", `data:image/png;base64,${TINY_PNG_BASE64}`);
			form.append(
				"input_image",
				JSON.stringify({ base64: TINY_PNG_BASE64, filename: "input-json.png" }),
			);
			form.append("input_image[]", tinyPngFile("input-bracket.png"));

			const plans = [];
			let seenInput = null;
			const resp = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: form,
				}),
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async resolveAttachments(plan) {
						plans.push(plan);
						return attachmentResult({
							fileRefs: plan.candidates.map((candidate) => ({
								ref: `/uploaded/${candidate.filename}`,
								name: candidate.filename,
							})),
						});
					},
					async generateRich(input) {
						seenInput = input;
						return {
							text: "",
							images: [
								{
									url: "https://images.example/edit.png",
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);

			assert.equal(resp.status, 200);
			assert.equal(plans.length, 1);
			const expectedNames = [
				"bracket.png",
				"images-array-a.png",
				"images-array-b.png",
				"image-4.png",
				"input-json.png",
				"input-bracket.png",
			];
			assert.deepEqual(
				plans[0].candidates.map((candidate) => candidate.filename),
				expectedNames,
			);
			assert.deepEqual(
				seenInput.fileRefs,
				expectedNames.map((name) => ({ ref: `/uploaded/${name}`, name })),
			);
			const body = await resp.json();
			assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
		},
	],
	[
		"dispatches multipart OpenAI Images edits before JSON parsing",
		async () => {
			const form = new FormData();
			form.append("prompt", "edit");
			form.append("stream", "true");
			form.append("image", tinyPngFile("input.png"));
			const resp = await mod.default.fetch(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: form,
				}),
				{
					GEMINI_DB: {
						prepare() {
							throw new Error("invalid multipart stream should not read D1");
						},
					},
				},
				{},
			);

			assert.equal(resp.status, 400);
			assert.equal(
				(await resp.json()).error.code,
				"unsupported_image_generation_stream",
			);
		},
	],
	[
		"rejects unsupported multipart OpenAI Images edit inputs before upstream work",
		async () => {
			let generated = false;
			const remoteForm = new FormData();
			remoteForm.append("model", "gemini-3.5-flash");
			remoteForm.append("prompt", "edit it");
			remoteForm.append("image_url", "https://cdn.example.com/image.png");
			const remote = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: remoteForm,
				}),
				baseConfig({ cookie: "SID=ok", request_body_max_bytes: 1 }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(remote.status, 400);
			assert.equal((await remote.json()).error.code, "image_input_unsupported");

			const textFileForm = new FormData();
			textFileForm.append("model", "gemini-3.5-flash");
			textFileForm.append("prompt", "edit it");
			textFileForm.append(
				"image",
				new File([new TextEncoder().encode("not an image")], "not-image.png", {
					type: "image/png",
				}),
			);
			const textFile = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: textFileForm,
				}),
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(textFile.status, 400);
			assert.equal(
				(await textFile.json()).error.code,
				"image_input_unsupported",
			);

			const tooLargeForm = new FormData();
			tooLargeForm.append("model", "gemini-3.5-flash");
			tooLargeForm.append("prompt", "edit it");
			tooLargeForm.append("image", tinyPngFile("large.png"));
			const tooLarge = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: tooLargeForm,
				}),
				baseConfig({ cookie: "SID=ok", generic_file_upload_max_bytes: 2 }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(tooLarge.status, 413);
			assert.equal((await tooLarge.json()).error.code, "image_input_too_large");

			const declaredTooLarge = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					headers: {
						"content-type": "multipart/form-data; boundary=x",
						"content-length": "1048577",
					},
					body: "--x--",
				}),
				baseConfig({ cookie: "SID=ok", generic_file_upload_max_bytes: 0 }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(declaredTooLarge.status, 413);
			assert.equal(
				(await declaredTooLarge.json()).error.code,
				"image_input_too_large",
			);
			assert.equal(generated, false);
		},
	],
	[
		"supports OpenAI Images url response format without Worker-hosted image URLs",
		async () => {
			let generateOptions;
			const resp = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw a URL-returned image",
					response_format: "url",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich(_input, options) {
						generateOptions = options;
						return {
							text: "",
							images: [
								{
									url: "https://images.example/generated.png",
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.deepEqual(body.data, [
				{ url: "https://images.example/generated.png" },
			]);
			assert.equal(String(body.data[0].url).startsWith("/images/"), false);
			assert.deepEqual(generateOptions, { hydrateGeneratedImageBytes: false });
		},
	],
	[
		"rejects unsupported OpenAI Images endpoint options before upstream work",
		async () => {
			let generated = false;
			const provider = fakeProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			});

			const stream = await mod.default.fetch(
				new Request("https://worker.example/v1/images/generations", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prompt: "draw", stream: true }),
				}),
				{
					GEMINI_DB: {
						prepare() {
							throw new Error("invalid image stream should not read D1");
						},
					},
				},
				{},
			);
			assert.equal(stream.status, 400);
			assert.equal(
				(await stream.json()).error.code,
				"unsupported_image_generation_stream",
			);

			const count = await mod.handleImageGenerations(
				{ prompt: "draw", n: 2 },
				baseConfig(),
				provider,
			);
			assert.equal(count.status, 400);
			assert.equal((await count.json()).error.code, "unsupported_image_count");

			const format = await mod.handleImageGenerations(
				{ prompt: "draw", response_format: "base64" },
				baseConfig(),
				provider,
			);
			assert.equal(format.status, 400);
			assert.equal((await format.json()).error.code, "invalid_response_format");
			assert.equal(generated, false);
		},
	],
	[
		"parses additional OpenAI Images endpoint option edges",
		async () => {
			let generated = 0;
			const provider = fakeProvider({
				async generateRich() {
					generated += 1;
					return {
						text: "",
						images: [
							{
								url: "https://images.example/generated.png",
								source: "generated",
								base64: TINY_PNG_BASE64,
								outputFormat: "png",
							},
						],
					};
				},
			});

			const stringCountAndNumberStream = await mod.handleImageGenerations(
				{
					prompt: "draw valid options",
					n: "1",
					stream: 0,
				},
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(stringCountAndNumberStream.status, 200);

			const emptyPrompt = await mod.handleImageGenerations(
				{ prompt: "   " },
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(emptyPrompt.status, 400);
			assert.equal(
				(await emptyPrompt.json()).error.code,
				"image_generation_empty_prompt",
			);

			const nonStringPrompt = await mod.handleImageGenerations(
				{ prompt: 123 },
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(nonStringPrompt.status, 400);
			assert.equal(
				(await nonStringPrompt.json()).error.code,
				"image_generation_empty_prompt",
			);

			const nonStringFormat = await mod.handleImageGenerations(
				{ prompt: "draw", response_format: 1 },
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(nonStringFormat.status, 400);
			assert.equal(
				(await nonStringFormat.json()).error.code,
				"invalid_response_format",
			);

			const nonStringStream = await mod.handleImageGenerations(
				{ prompt: "draw", stream: {} },
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(nonStringStream.status, 400);
			assert.equal(
				(await nonStringStream.json()).error.code,
				"invalid_request",
			);

			const badNumberStream = await mod.handleImageGenerations(
				{ prompt: "draw", stream: 2 },
				baseConfig({ cookie: "SID=ok" }),
				provider,
			);
			assert.equal(badNumberStream.status, 400);
			assert.equal(
				(await badNumberStream.json()).error.code,
				"invalid_request",
			);
			assert.equal(generated, 1);
		},
	],
	[
		"rejects OpenAI Images edits without local image inputs",
		async () => {
			let generated = false;
			const remote = await mod.handleImageEdits(
				{
					model: "gemini-3.5-flash",
					prompt: "edit it",
					image_url: "https://cdn.example.com/image.png",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(remote.status, 400);
			assert.equal((await remote.json()).error.code, "image_input_unsupported");

			const missing = await mod.handleImageEdits(
				{
					model: "gemini-3.5-flash",
					prompt: "edit it",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						generated = true;
						return { text: "", images: [] };
					},
				}),
			);
			assert.equal(missing.status, 400);
			assert.equal(
				(await missing.json()).error.code,
				"image_input_unsupported",
			);
			assert.equal(generated, false);
		},
	],
	[
		"fails forced OpenAI Images endpoints on text-only or URL-only b64_json output",
		async () => {
			const textOnly = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return { text: "policy text only", images: [] };
					},
				}),
			);
			assert.equal(textOnly.status, 502);
			assert.equal(
				(await textOnly.json()).error.code,
				"upstream_image_generation_empty",
			);

			const urlOnly = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return {
							text: "",
							images: [
								{
									url: "https://images.example/generated.png",
									source: "generated",
								},
							],
						};
					},
				}),
			);
			assert.equal(urlOnly.status, 502);
			assert.equal(
				(await urlOnly.json()).error.code,
				"upstream_image_fetch_failed",
			);
		},
	],
	[
		"fails OpenAI Images url format when generated images have no usable URL",
		async () => {
			const resp = await mod.handleImageGenerations(
				{
					model: "gemini-3.5-flash",
					prompt: "draw",
					response_format: "url",
				},
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						return {
							text: "",
							images: [
								{
									source: "generated",
									base64: TINY_PNG_BASE64,
									outputFormat: "png",
								},
							],
						};
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_image_generation_empty");
			assert.match(body.error.message, /without usable URLs/);
		},
	],
	[
		"rejects multipart OpenAI Images edits with invalid form fields or no images",
		async () => {
			const invalidStreamForm = new FormData();
			invalidStreamForm.append("prompt", "edit");
			invalidStreamForm.append("stream", "maybe");
			invalidStreamForm.append("image", tinyPngFile("input.png"));
			const invalidStream = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: invalidStreamForm,
				}),
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						throw new Error(
							"generateRich should not run for invalid multipart stream values",
						);
					},
				}),
			);
			assert.equal(invalidStream.status, 400);
			assert.equal((await invalidStream.json()).error.code, "invalid_request");

			const noImageForm = new FormData();
			noImageForm.append("prompt", "edit");
			noImageForm.append("n", "1");
			noImageForm.append("size", "1024x1024");
			noImageForm.append("response_format", "b64_json");
			const noImage = await mod.handleImageEditsMultipart(
				new Request("https://worker.example/v1/images/edits", {
					method: "POST",
					body: noImageForm,
				}),
				baseConfig({ cookie: "SID=ok" }),
				fakeProvider({
					async generateRich() {
						throw new Error(
							"generateRich should not run without multipart images",
						);
					},
				}),
			);
			assert.equal(noImage.status, 400);
			assert.equal(
				(await noImage.json()).error.code,
				"image_input_unsupported",
			);
		},
	],
	[
		"logs image generation stages when request logging is enabled",
		async () => {
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					const resp = await mod.handleImageGenerations(
						{
							model: "gemini-3.5-flash",
							prompt: "draw with logging",
						},
						baseConfig({ cookie: "SID=ok", log_requests: true }),
						fakeProvider({
							async generateRich() {
								return {
									text: "",
									images: [
										{
											url: "https://images.example/generated.png",
											source: "generated",
											base64: TINY_PNG_BASE64,
											outputFormat: "png",
										},
									],
								};
							},
						}),
					);
					assert.equal(resp.status, 200);
				},
			);
			assert.equal(
				logs.some((line) => line.includes("openai_images_generations_prepare")),
				true,
			);
			assert.equal(
				logs.some((line) =>
					line.includes("openai_images_generations_generate"),
				),
				true,
			);
		},
	],
	[
		"logs Chat and Responses image generation stages when request logging is enabled",
		async () => {
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					const provider = fakeProvider({
						async generateRich() {
							return {
								text: "done",
								images: [
									{
										url: "https://images.example/generated.png",
										source: "generated",
										base64: TINY_PNG_BASE64,
										outputFormat: "png",
									},
								],
							};
						},
					});

					const chat = await mod.handleChat(
						{
							model: "gemini-3.5-flash",
							messages: [{ role: "user", content: "draw with chat logging" }],
							tool_choice: { type: "image_generation" },
						},
						baseConfig({ cookie: "SID=ok", log_requests: true }),
						provider,
					);
					assert.equal(chat.status, 200);

					const responses = await mod.handleResponses(
						{
							model: "gemini-3.5-flash",
							input: "draw with responses logging",
							tool_choice: { type: "image_generation" },
						},
						baseConfig({ cookie: "SID=ok", log_requests: true }),
						provider,
					);
					assert.equal(responses.status, 200);
				},
			);
			assert.equal(
				logs.some((line) => line.includes("openai_chat_image_prepare")),
				true,
			);
			assert.equal(
				logs.some((line) => line.includes("openai_chat_image_generate")),
				true,
			);
			assert.equal(
				logs.some((line) => line.includes("openai_responses_image_prepare")),
				true,
			);
			assert.equal(
				logs.some((line) => line.includes("openai_responses_image_generate")),
				true,
			);
		},
	],
	[
		"normalizes Responses input without leaking unknown event payloads",
		async () => {
			const messages = mod.normalizeResponsesInputAsMessages({
				input: [
					{ type: "input_text", text: "known text" },
					{
						type: "custom_event",
						text: "do not leak text",
						content: [{ type: "input_text", text: "do not leak content" }],
						metadata: { secret: "do not leak json" },
					},
					{ custom: "do not leak object" },
				],
			});
			assert.deepEqual(messages, [{ role: "user", content: "known text" }]);
			assert.deepEqual(
				mod.normalizeResponsesInputAsMessages({
					input: { type: "custom_event", text: "do not leak root" },
				}),
				[],
			);
		},
	],
	[
		"rejects invalid Responses model before provider generation",
		async () => {
			let generated = false;
			const provider = {
				async generateText() {
					generated = true;
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "",
					input: "plain request",
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "model_not_found");
			assert.equal(generated, false);
		},
	],
	[
		"rejects invalid OpenAI response format before provider generation",
		async () => {
			let generated = false;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "return json" }],
					response_format: {
						type: "json_schema",
						json_schema: { name: "missing_schema" },
					},
				},
				baseConfig(),
				fakeProvider({
					async generateText() {
						generated = true;
						return "{}";
					},
				}),
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "invalid_response_format");
			assert.equal(
				body.error.message,
				"response_format json_schema requires a schema object",
			);
			assert.equal(generated, false);
		},
	],
	[
		"rejects empty OpenAI prompts before provider generation",
		async () => {
			let generated = false;
			const chat = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [],
				},
				baseConfig(),
				fakeProvider({
					async generateText() {
						generated = true;
						return "unexpected";
					},
				}),
			);
			assert.equal(chat.status, 400);
			assert.equal((await chat.json()).error.message, "empty prompt");

			const responses = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [],
				},
				baseConfig(),
				fakeProvider({
					async generateText() {
						generated = true;
						return "unexpected";
					},
				}),
			);
			assert.equal(responses.status, 400);
			assert.equal((await responses.json()).error.message, "empty input");
			assert.equal(generated, false);
		},
	],
	[
		"maps OpenAI context upload failures during prepare",
		async () => {
			let generated = false;
			const uploadErr = new Error("upload refused");
			uploadErr.status = 504;
			uploadErr.code = "context_upload_failed";
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [
						{ role: "user", content: `large prompt ${"x".repeat(80)}` },
					],
				},
				baseConfig({
					current_input_file_enabled: true,
					current_input_file_min_bytes: 1,
					cookie: "SID=ok",
					supports_authenticated_session: true,
				}),
				fakeProvider({
					async uploadTextFile() {
						throw uploadErr;
					},
					async generateText() {
						generated = true;
						return "unexpected";
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "large_context_file_upload_failed");
			assert.match(
				body.error.message,
				/failed to upload history context text file/,
			);
			assert.equal(generated, false);
		},
	],
	[
		"rejects oversized inline context before resolving request-local attachments",
		async () => {
			let generated = false;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: `large prompt ${"x".repeat(80)}` },
								{
									type: "input_file",
									file_url: "https://files.example/expensive.bin",
									filename: "expensive.bin",
								},
							],
						},
					],
				},
				baseConfig({
					current_input_file_enabled: true,
					current_input_file_min_bytes: 1,
					cookie: "",
				}),
				fakeProvider({
					async resolveAttachments() {
						throw new Error("resolveAttachments should not run");
					},
					async generateText() {
						generated = true;
						return "unexpected";
					},
				}),
			);
			assert.equal(resp.status, 422);
			const body = await resp.json();
			assert.equal(body.error.code, "gemini_authenticated_session_required");
			assert.equal(body.error.reason, "large_context");
			assert.equal(generated, false);
		},
	],
	[
		"fails context upload before resolving request-local attachments",
		async () => {
			let generated = false;
			const uploadErr = new Error("upload refused before attachment fetch");
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: `large prompt ${"x".repeat(80)}` },
								{
									type: "input_file",
									file_url: "https://files.example/expensive.bin",
									filename: "expensive.bin",
								},
							],
						},
					],
				},
				baseConfig({
					current_input_file_enabled: true,
					current_input_file_min_bytes: 1,
					cookie: "SID=ok",
					supports_authenticated_session: true,
				}),
				fakeProvider({
					async resolveAttachments() {
						throw new Error("resolveAttachments should not run");
					},
					async uploadTextFile() {
						throw uploadErr;
					},
					async generateText() {
						generated = true;
						return "unexpected";
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "large_context_file_upload_failed");
			assert.match(
				body.error.message,
				/failed to upload history context text file/,
			);
			assert.equal(generated, false);
		},
	],
	[
		"adds dropped image note when Responses image upload is unavailable",
		async () => {
			let generated = false;
			const prompts = [];
			const provider = {
				async generateText(input) {
					generated = true;
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult({
						droppedNote:
							"\n\n[Note: 1 image(s) were provided but ignored - image input requires a configured Gemini account pool.]",
					});
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "describe this" },
								{
									type: "input_image",
									image_url: "data:image/png;base64,AAAA",
								},
							],
						},
					],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 200);
			assert.equal(generated, true);
			assert.match(prompts[0], /image\(s\) were provided but ignored/);
		},
	],
	[
		"adds DSML tool instructions for Responses tools",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "find docs",
					tools: [
						{
							type: "function",
							name: "Search",
							description: "Search docs",
							input_schema: {
								type: "object",
								properties: { query: { type: "string" } },
							},
						},
					],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 200);
			assert.match(prompts[0], /Available tools/);
			assert.match(prompts[0], /<\|DSML\|tool_calls>/);
			assert.match(prompts[0], /"name": "Search"/);
			assert.match(prompts[0], /"query"/);
		},
	],
	[
		"adds DSML tool instructions for wrapped Responses tools",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "find docs",
					tools: {
						tools: [
							{
								type: "function",
								name: "WrappedSearch",
								description: "Search docs",
								parameters: {
									type: "object",
									properties: { query: { type: "string" } },
								},
							},
						],
					},
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 200);
			assert.match(prompts[0], /Available tools/);
			assert.match(prompts[0], /<\|DSML\|tool_calls>/);
			assert.match(prompts[0], /"name": "WrappedSearch"/);
		},
	],
	[
		"moves large Responses tools into attached tools file",
		async () => {
			const prompts = [];
			const uploads = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(text, filename) {
					uploads.push({ text, filename });
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: `find docs ${"x".repeat(120)}`,
					tools: [
						{
							type: "function",
							name: "Search",
							description: "Search docs",
							input_schema: {
								type: "object",
								properties: { query: { type: "string" } },
							},
						},
					],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: true,
					current_input_file_min_bytes: 40,
					current_input_file_name: "message.txt",
					current_tools_file_name: "tools.txt",
					cookie: "SID=ok",
					supports_authenticated_session: true,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 200);
			assert.equal(uploads.length, 2);
			assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
			assert.match(
				prompts[0],
				/Continue from the latest state in the attached `message\.txt` context/,
			);
			assert.match(prompts[0], /tools\.txt/);
			assert.match(
				prompts[0],
				/All text above this sentence is system prompt content/,
			);
			assert.doesNotMatch(prompts[0], /Gemini native hidden tool calls/);
			assert.doesNotMatch(prompts[0], /Available tools/);
			assert.doesNotMatch(prompts[0], /"query"/);
			assert.match(uploads[1].text, /Available tool descriptions/);
			assert.match(uploads[1].text, /Tool call format instructions/);
			assert.match(uploads[1].text, /<\|DSML\|tool_calls>/);
			assert.match(uploads[1].text, /Gemini native hidden tool calls/);
			assert.match(uploads[1].text, /"name": "Search"/);
			assert.match(uploads[1].text, /"query"/);
		},
	],
	[
		"omits tool instructions for plain Responses requests",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "plain request",
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 200);
			assert.doesNotMatch(prompts[0], /<\|DSML\|tool_calls>/);
			assert.doesNotMatch(prompts[0], /Available tools/);
		},
	],
	[
		"prevents unknown Responses input events from reaching prompt text",
		async () => {
			const prompts = [];
			const provider = {
				async generateText(input) {
					prompts.push(input.prompt);
					return "done";
				},
				streamText() {
					return chunks([]);
				},
				async resolveAttachments() {
					return attachmentResult();
				},
				async uploadTextFile(_text, filename) {
					return { ref: `/uploaded/${filename}`, name: filename };
				},
			};
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{ type: "input_text", text: "visible request" },
						{
							type: "custom_event",
							text: "do not leak text",
							content: [{ type: "input_text", text: "do not leak content" }],
							metadata: { secret: "do not leak json" },
						},
					],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				provider,
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "unsupported_responses_input");
			assert.match(body.error.message, /unsupported type: custom_event/);
			assert.deepEqual(prompts, []);
		},
	],
	[
		"returns OpenAI chat completions with text usage and stop finish",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "say hi" }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText(input) {
						assert.match(input.prompt, /say hi/);
						return "hello";
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.equal(body.object, "chat.completion");
			assert.equal(body.choices[0].message.content, "hello");
			assert.equal(body.choices[0].finish_reason, "stop");
			assert.equal(body.usage.total_tokens >= body.usage.prompt_tokens, true);
		},
	],
	[
		"passes OpenAI referenced file ids from chat request fields to provider",
		async () => {
			let seenFileRefs = null;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					ref_file_ids: ["file_top", "file_dup"],
					file_ids: ["file_dup", "file_list"],
					attachments: [
						{ file_id: "file_attach", filename: "../attach.txt" },
						{ type: "input_file", id: "file_typed", file_name: "typed.txt" },
						{ file: { id: "file_nested", filename: "nested.txt" } },
					],
					messages: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "summarize files" },
								{
									type: "input_file",
									file_id: "file_content",
									filename: "content.txt",
								},
							],
						},
					],
					input: [
						{
							content: [
								{
									type: "input_file",
									file_id: "file_input",
									filename: "input.txt",
								},
							],
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async generateText(input) {
						seenFileRefs = input.fileRefs;
						return "done";
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.deepEqual(seenFileRefs, [
				"file_top",
				"file_dup",
				"file_list",
				{ id: "file_attach", name: "attach.txt" },
				{ id: "file_typed", name: "typed.txt" },
				{ id: "file_nested", name: "nested.txt" },
				{ id: "file_content", name: "content.txt" },
				{ id: "file_input", name: "input.txt" },
			]);
		},
	],
	[
		"passes OpenAI inline input_file uploads to provider without treating bytes as file ids",
		async () => {
			let seenFiles = null;
			let seenFileRefs = null;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					ref_file_ids: ["file_existing"],
					messages: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "review this code" },
								{
									type: "input_file",
									id: "part_1",
									filename: "../main.py",
									file_data: "data:text/x-python;base64,cHJpbnQoMSkK",
								},
							],
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async resolveAttachments(plan) {
						seenFiles = plan.candidates.map(simplifyAttachmentCandidate);
						return attachmentResult({
							fileRefs: [{ ref: "/uploaded/main-py", name: "main.py" }],
							genericFileRefs: [{ ref: "/uploaded/main-py", name: "main.py" }],
						});
					},
					async generateText(input) {
						seenFileRefs = input.fileRefs;
						return "done";
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.deepEqual(seenFiles, [
				{ b64: "cHJpbnQoMSkK", mime: "text/x-python", filename: "main.py" },
			]);
			assert.deepEqual(seenFileRefs, [
				"file_existing",
				{ ref: "/uploaded/main-py", name: "main.py" },
			]);
		},
	],
	[
		"does not treat nested inline input_file file.id as an existing file ref",
		async () => {
			let seenFiles = null;
			let seenFileRefs = null;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [
						{
							role: "user",
							content: [
								{
									type: "input_file",
									file: {
										id: "local_part",
										data: "aGVsbG8=",
										filename: "note.txt",
										mime_type: "text/plain",
									},
								},
							],
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async resolveAttachments(plan) {
						seenFiles = plan.candidates.map(simplifyAttachmentCandidate);
						return attachmentResult({
							fileRefs: [{ ref: "/uploaded/note", name: "note.txt" }],
							genericFileRefs: [{ ref: "/uploaded/note", name: "note.txt" }],
						});
					},
					async generateText(input) {
						seenFileRefs = input.fileRefs;
						return "done";
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.deepEqual(seenFiles, [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
			]);
			assert.deepEqual(seenFileRefs, [
				{ ref: "/uploaded/note", name: "note.txt" },
			]);
		},
	],
	[
		"passes top-level Responses input_file uploads to provider",
		async () => {
			let seenFiles = null;
			let seenFileRefs = null;
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: [
						{ type: "input_text", text: "review this note" },
						{
							type: "input_file",
							filename: "../note.txt",
							file_data: { data: "aGVsbG8=", mime_type: "text/plain" },
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async resolveAttachments(plan) {
						seenFiles = plan.candidates.map(simplifyAttachmentCandidate);
						return attachmentResult({
							fileRefs: [{ ref: "/uploaded/note", name: "note.txt" }],
							genericFileRefs: [{ ref: "/uploaded/note", name: "note.txt" }],
						});
					},
					async generateText(input) {
						seenFileRefs = input.fileRefs;
						return "done";
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.deepEqual(seenFiles, [
				{ b64: "aGVsbG8=", mime: "text/plain", filename: "note.txt" },
			]);
			assert.deepEqual(seenFileRefs, [
				{ ref: "/uploaded/note", name: "note.txt" },
			]);
		},
	],
	[
		"passes top-level OpenAI attachments inline uploads to provider",
		async () => {
			let seenFiles = null;
			let seenFileRefs = null;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "review attachments" }],
					attachments: [
						{
							type: "input_file",
							id: "local_part",
							filename: "../top.txt",
							file_data: "dG9w",
							mime_type: "text/plain",
						},
						{
							type: "file",
							file_id: "file_existing",
							filename: "existing.txt",
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async resolveAttachments(plan) {
						seenFiles = plan.candidates.map(simplifyAttachmentCandidate);
						return attachmentResult({
							fileRefs: [{ ref: "/uploaded/top", name: "top.txt" }],
							genericFileRefs: [{ ref: "/uploaded/top", name: "top.txt" }],
						});
					},
					async generateText(input) {
						seenFileRefs = input.fileRefs;
						return "done";
					},
				}),
			);
			assert.equal(resp.status, 200);
			assert.deepEqual(seenFiles, [
				{ b64: "dG9w", mime: "text/plain", filename: "top.txt" },
			]);
			assert.deepEqual(seenFileRefs, [
				{ id: "file_existing", name: "existing.txt" },
				{ ref: "/uploaded/top", name: "top.txt" },
			]);
		},
	],
	[
		"adds dropped generic file note and continues OpenAI chat generation",
		async () => {
			let seenPrompt = "";
			let seenFileRefs = "unset";
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [
						{
							role: "user",
							content: [
								{ type: "input_file", data: "aGVsbG8=", filename: "note.txt" },
							],
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async resolveAttachments() {
						return attachmentResult({
							droppedNote:
								"\n\n[Note: 1 file(s) were provided but ignored - attachment upload failed.]",
						});
					},
					async generateText(input) {
						seenPrompt = input.prompt;
						seenFileRefs = input.fileRefs;
						return "continued";
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.equal(body.choices[0].message.content, "continued");
			assert.match(
				seenPrompt,
				/\[Note: 1 file\(s\) were provided but ignored - attachment upload failed\.\]/,
			);
			assert.equal(seenFileRefs, null);
		},
	],
	[
		"inlines anonymous generic file text and suppresses file refs before OpenAI chat generation",
		async () => {
			let seenPrompt = "";
			let seenFileRefs = "unset";
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					ref_file_ids: ["file_existing"],
					messages: [
						{
							role: "user",
							content: [
								{ type: "input_text", text: "summarize this" },
								{
									type: "input_file",
									data: "aGVsbG8=",
									filename: "note.txt",
									mime: "text/plain",
								},
							],
						},
					],
				},
				baseConfig(),
				fakeProvider({
					async resolveAttachments() {
						return attachmentResult({
							promptText:
								"\n\n[File attachment: note.txt]\nhello\n[/File attachment]",
							supportsFileRefs: false,
						});
					},
					async generateText(input) {
						seenPrompt = input.prompt;
						seenFileRefs = input.fileRefs;
						return "continued";
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.equal(body.choices[0].message.content, "continued");
			assert.match(seenPrompt, /summarize this/);
			assert.match(
				seenPrompt,
				/\[File attachment: note\.txt\]\nhello\n\[\/File attachment\]/,
			);
			assert.equal(seenFileRefs, null);
		},
	],
	[
		"returns OpenAI chat upstream_empty error without model text",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "say something" }],
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText() {
						return "";
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_empty");
			assert.equal(body.error.message, mod.EMPTY_UPSTREAM_MSG);
			assert.equal(body.choices, undefined);
		},
	],
	[
		"canonicalizes non-stream structured OpenAI chat JSON output",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "return json" }],
					response_format: { type: "json_object" },
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText(input) {
						assert.match(input.prompt, /STRUCTURED OUTPUT REQUIREMENT/);
						return '```json\n{"ok":true}\n```';
					},
				}),
			);
			assert.equal(resp.status, 200);
			const body = await resp.json();
			assert.equal(body.choices[0].message.content, '{"ok":true}');
			assert.equal(body.choices[0].finish_reason, "stop");
		},
	],
	[
		"rejects invalid non-stream structured OpenAI chat JSON schema output",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					messages: [{ role: "user", content: "return strict json" }],
					response_format: {
						type: "json_schema",
						json_schema: {
							name: "strict_result",
							schema: {
								type: "object",
								required: ["ok"],
								additionalProperties: false,
								properties: { ok: { type: "boolean" } },
							},
						},
					},
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText(input) {
						assert.match(input.prompt, /Schema name: strict_result/);
						return '{"ok":true,"extra":1}';
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "structured_output_validation_failed");
			assert.match(body.error.message, /extra is not allowed/);
		},
	],
	[
		"maps non-stream OpenAI Chat upstream errors to OpenAI error format",
		async () => {
			const err = streamError("chat overloaded secret", "chat_overloaded");
			err.status = 503;
			const logs = [];
			const resp = await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.handleChat(
						{
							model: "gemini-3.5-flash",
							messages: [{ role: "user", content: "try once" }],
						},
						{
							default_model: "gemini-3.5-flash",
							current_input_file_enabled: false,
							current_input_file_min_bytes: 1000000,
							log_requests: true,
						},
						fakeProvider({
							async generateText() {
								throw err;
							},
						}),
					),
			);
			assert.equal(resp.status, 503);
			const body = await resp.json();
			assert.equal(body.error.code, "chat_overloaded");
			assert.equal(body.error.type, "service_unavailable_error");
			assert.match(
				body.error.message,
				/upstream error: chat overloaded secret/,
			);
			const failureLog = logs.find((line) =>
				line.includes("openai chat generate failed"),
			);
			assert.match(
				failureLog,
				/error=type=Error code=chat_overloaded status=503/,
			);
			assert.doesNotMatch(failureLog, /chat overloaded secret/);
		},
	],
	[
		"maps non-stream OpenAI Chat upstream empty errors instead of returning fallback 200",
		async () => {
			const err = streamError(
				"Gemini upstream HTTP 200 returned no parseable text (non-stream)",
				"upstream_empty_response",
			);
			err.status = 502;
			err.upstreamStatus = 200;
			err.rawLength = 31;
			const logs = [];
			const resp = await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.handleChat(
						{
							model: "gemini-3.5-flash",
							messages: [{ role: "user", content: "try once" }],
						},
						baseConfig({ log_requests: true }),
						fakeProvider({
							async generateText() {
								throw err;
							},
						}),
					),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_empty_response");
			assert.equal(body.error.type, "api_error");
			assert.match(
				body.error.message,
				/upstream error: Gemini upstream HTTP 200 returned no parseable text/,
			);
			const failureLog = logs.find((line) =>
				line.includes("openai chat generate failed"),
			);
			assert.match(
				failureLog,
				/error=type=Error code=upstream_empty_response status=502 upstreamStatus=200 rawLength=31/,
			);
		},
	],
	[
		"rejects invalid non-stream structured OpenAI Responses JSON schema output",
		async () => {
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "return strict json",
					text: {
						format: {
							type: "json_schema",
							name: "strict_response",
							schema: {
								type: "object",
								required: ["ok"],
								additionalProperties: false,
								properties: { ok: { type: "boolean" } },
							},
						},
					},
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText(input) {
						assert.match(input.prompt, /Schema name: strict_response/);
						return '{"ok":true,"extra":1}';
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "structured_output_validation_failed");
			assert.match(body.error.message, /extra is not allowed/);
		},
	],
	[
		"maps non-stream OpenAI Responses upstream errors to OpenAI error format",
		async () => {
			const err = streamError(
				"responses overloaded secret",
				"upstream_overloaded",
			);
			err.status = 503;
			const logs = [];
			const resp = await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.handleResponses(
						{
							model: "gemini-3.5-flash",
							input: "try once",
						},
						{
							default_model: "gemini-3.5-flash",
							current_input_file_enabled: false,
							current_input_file_min_bytes: 1000000,
							log_requests: true,
						},
						fakeProvider({
							async generateText() {
								throw err;
							},
						}),
					),
			);
			assert.equal(resp.status, 503);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_overloaded");
			assert.equal(body.error.type, "service_unavailable_error");
			assert.match(
				body.error.message,
				/upstream error: responses overloaded secret/,
			);
			const failureLog = logs.find((line) =>
				line.includes("openai responses generate failed"),
			);
			assert.match(
				failureLog,
				/error=type=Error code=upstream_overloaded status=503/,
			);
			assert.doesNotMatch(failureLog, /responses overloaded secret/);
		},
	],
	[
		"formats OpenAI error envelopes usage chunks and response output edges",
		async () => {
			assert.equal(mod.openAIErrorType(400), "invalid_request_error");
			assert.equal(mod.openAIErrorType(401), "authentication_error");
			assert.equal(mod.openAIErrorType(403), "permission_error");
			assert.equal(mod.openAIErrorType(429), "rate_limit_error");
			assert.equal(mod.openAIErrorType(503), "service_unavailable_error");
			assert.equal(mod.openAIErrorType(500), "api_error");
			assert.equal(mod.openAIErrorType(418), "invalid_request_error");

			const forbidden = mod.openAIErrorResponse(
				"blocked",
				403,
				"policy_blocked",
			);
			assert.equal(forbidden.status, 403);
			assert.equal(forbidden.headers.get("content-type"), "application/json");
			assert.deepEqual(await forbidden.json(), {
				error: {
					message: "blocked",
					type: "permission_error",
					code: "policy_blocked",
					param: null,
				},
			});
			const defaultErr = await mod.openAIErrorResponse("bad request").json();
			assert.equal(defaultErr.error.type, "invalid_request_error");
			assert.equal(defaultErr.error.code, null);

			const upstream = streamError("gateway down", "upstream_down");
			const upstreamResp = mod.openAIUpstreamErrorResponse(upstream);
			assert.equal(upstreamResp.status, 502);
			const upstreamBody = await upstreamResp.json();
			assert.equal(upstreamBody.error.type, "api_error");
			assert.equal(upstreamBody.error.code, "upstream_down");
			assert.match(upstreamBody.error.message, /upstream error: gateway down/);

			const usageWrites = [];
			mod.writeOpenAIChatUsageTokenChunk(
				(chunk) => usageWrites.push(chunk),
				"chatcmpl_usage",
				0,
				-2,
				"3",
			);
			const usageFrame = collectSSEData(usageWrites)[0];
			assert.equal(usageFrame.id, "chatcmpl_usage");
			assert.deepEqual(usageFrame.choices, []);
			assert.deepEqual(usageFrame.usage, {
				prompt_tokens: 0,
				completion_tokens: 3,
				total_tokens: 3,
			});

			const errorWrites = [];
			mod.writeOpenAIChatStreamError(
				(chunk) => errorWrites.push(chunk),
				"chatcmpl_error",
				"gemini-3.5-flash",
				upstream,
			);
			const errorFrames = collectSSEData(errorWrites);
			assert.equal(errorFrames[0].error.code, "upstream_down");
			assert.equal(errorFrames[0].error.message, "gateway down");
			assert.equal(errorFrames[0].choices, undefined);
			assert.equal(errorFrames[1], "[DONE]");

			const responsesUsage = mod.openAIResponsesUsage(-5, "abcd");
			assert.equal(responsesUsage.input_tokens, 0);
			assert.equal(responsesUsage.output_tokens > 0, true);
			assert.equal(responsesUsage.total_tokens, responsesUsage.output_tokens);

			const onlyValidTool = mod.buildResponsesOutput(
				"",
				[
					"skip",
					{ id: "call_bad", function: { name: "MissingArguments" } },
					{
						id: "call_1",
						function: { name: "Lookup", arguments: '{"id":"1"}' },
					},
				],
				"msg_skip",
			);
			assert.equal(onlyValidTool.length, 1);
			assert.equal(onlyValidTool[0].type, "function_call");
			assert.equal(onlyValidTool[0].call_id, "call_1");

			const emptyArrayOutput = mod.buildResponsesOutput("", [], "msg_empty");
			assert.equal(emptyArrayOutput[0].type, "message");
			assert.equal(emptyArrayOutput[0].content[0].text, "");
			const nonArrayOutput = mod.buildResponsesOutput("", null, "msg_null");
			assert.equal(nonArrayOutput[0].type, "message");
		},
	],
	[
		"rejects missing OpenAI Responses request objects",
		async () => {
			const resp = await mod.handleResponses(
				undefined,
				baseConfig(),
				fakeProvider(),
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.message, "request body must be a JSON object");
		},
	],
	[
		"returns OpenAI Responses upstream_empty error without model output",
		async () => {
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					input: "say something",
				},
				baseConfig(),
				fakeProvider({
					async generateText() {
						return "";
					},
				}),
			);
			assert.equal(resp.status, 502);
			const body = await resp.json();
			assert.equal(body.error.code, "upstream_empty");
			assert.equal(body.error.message, mod.EMPTY_UPSTREAM_MSG);
			assert.equal(body.output, undefined);
		},
	],
	[
		"rejects unsupported streaming structured OpenAI Responses",
		async () => {
			let generated = false;
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					stream: true,
					input: "json please",
					text: { format: { type: "json_object" } },
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText() {
						generated = true;
						return "{}";
					},
				}),
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "unsupported_response_format_stream");
			assert.equal(generated, false);
		},
	],
	[
		"streams OpenAI Responses plain output through handler path",
		async () => {
			const logs = [];
			let resp;
			let body = "";
			await withConsoleLog(
				(line) => logs.push(String(line)),
				async () => {
					resp = await mod.handleResponses(
						{
							model: "gemini-3.5-flash",
							stream: true,
							input: "say hello",
						},
						baseConfig({ log_requests: true }),
						fakeStreamProvider(["he", "llo"]),
					);
					body = await resp.text();
				},
			);
			assert.equal(resp.status, 200);
			const frames = collectSSEData([body]);
			assert.equal(frames[0].type, "response.created");
			assert.equal(
				frames
					.filter((frame) => frame.type === "response.output_text.delta")
					.map((frame) => frame.delta)
					.join(""),
				"hello",
			);
			const completed = frames.find(
				(frame) => frame.type === "response.completed",
			);
			assert.equal(completed.response.output[0].content[0].text, "hello");
			assert.equal(completed.response.status, "completed");
			assert.equal(
				logs.some((line) => line.includes("stage=openai_responses_prepare")),
				true,
			);
			assert.equal(
				logs.some((line) =>
					line.includes("stage=openai_responses_stream_generate"),
				),
				true,
			);
		},
	],
	[
		"streams OpenAI Responses tool-choice none violations through handler path",
		async () => {
			const resp = await mod.handleResponses(
				{
					model: "gemini-3.5-flash",
					stream: true,
					input: "do not call tools",
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					tool_choice: "none",
				},
				baseConfig(),
				fakeStreamProvider([
					'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
				]),
			);
			assert.equal(resp.status, 200);
			const frames = collectSSEData([await resp.text()]);
			const failed = frames.find((frame) => frame.type === "response.failed");
			assert.equal(failed.response.status, "failed");
			assert.equal(failed.response.error.code, "tool_choice_violation");
			assert.match(
				failed.response.error.message,
				/does not allow tool\(s\): Read/,
			);
		},
	],
	[
		"streams OpenAI chat tool-choice none violations through handler path",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					stream: true,
					messages: [{ role: "user", content: "do not call tools" }],
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					tool_choice: "none",
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeStreamProvider([
					'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
				]),
			);
			assert.equal(resp.status, 200);
			const body = await resp.text();
			assert.match(body, /tool_choice does not allow tool\(s\): Read/);
			assert.match(body, /data: \[DONE\]/);
		},
	],
	[
		"rejects unsupported streaming structured OpenAI chat responses",
		async () => {
			let generated = false;
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					stream: true,
					messages: [{ role: "user", content: "json please" }],
					response_format: { type: "json_object" },
				},
				{
					default_model: "gemini-3.5-flash",
					current_input_file_enabled: false,
					current_input_file_min_bytes: 1000000,
					log_requests: false,
				},
				fakeProvider({
					async generateText() {
						generated = true;
						return "{}";
					},
				}),
			);
			assert.equal(resp.status, 400);
			const body = await resp.json();
			assert.equal(body.error.code, "unsupported_response_format_stream");
			assert.equal(generated, false);
		},
	],
	[
		"streams OpenAI chat warning usage and DONE after partial output",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamOpenAIChatPlain(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									return chunks(["hello"], 0);
								},
							}),
							id: "chatcmpl_test",
							model: "gemini-3.5-flash",
							prompt: "say hello",
							rm: resolvedModel(),
							fileRefs: null,
							includeUsage: true,
							promptTokens: 3,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(frames[0].choices[0].delta.role, "assistant");
			assert.equal(
				frames.some(
					(frame) =>
						frame.warning && frame.warning.code === "stream_interrupted",
				),
				true,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.choices?.[0]?.delta &&
						String(frame.choices[0].delta.content || "").includes(
							"stream interrupted after partial output",
						),
				),
				false,
			);
			assert.equal(
				frames.some(
					(frame) =>
						Array.isArray(frame.choices) &&
						frame.choices.length === 0 &&
						frame.usage.total_tokens >= 3,
				),
				true,
			);
			assert.equal(frames[frames.length - 1], "[DONE]");
			const warningLog = logs.find((line) =>
				line.includes("openai chat stream interrupted after partial output"),
			);
			assert.match(warningLog, /error=type=Error/);
			assert.doesNotMatch(warningLog, /stream broke/);
		},
	],
	[
		"streams OpenAI chat protocol error before any output",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamOpenAIChatPlain(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									throw streamError("upstream down secret", "upstream_down");
								},
							}),
							id: "chatcmpl_error",
							model: "gemini-3.5-flash",
							prompt: "fail",
							rm: resolvedModel(),
							fileRefs: null,
							includeUsage: false,
							promptTokens: 1,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			const errorFrame = frames.find((frame) => frame.error);
			assert.equal(errorFrame.error.code, "upstream_down");
			assert.equal(errorFrame.error.message, "upstream down secret");
			assert.equal(errorFrame.choices, undefined);
			assert.equal(frames[frames.length - 1], "[DONE]");
			const failureLog = logs.find((line) =>
				line.includes("openai chat stream failed before output"),
			);
			assert.match(failureLog, /error=type=Error code=upstream_down/);
			assert.doesNotMatch(failureLog, /upstream down secret/);
		},
	],
	[
		"streams OpenAI chat plain output through handler path with usage",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					stream: true,
					stream_options: { include_usage: true },
					messages: [{ role: "user", content: "say hello" }],
				},
				baseConfig(),
				fakeStreamProvider(["he", "llo"]),
			);
			assert.equal(resp.status, 200);
			const frames = collectSSEData([await resp.text()]);
			assert.equal(frames[0].choices[0].delta.role, "assistant");
			const text = frames
				.filter((frame) => frame.choices?.[0]?.delta?.content)
				.map((frame) => frame.choices[0].delta.content)
				.join("");
			assert.equal(text, "hello");
			assert.equal(
				frames.some(
					(frame) =>
						Array.isArray(frame.choices) &&
						frame.choices.length === 0 &&
						frame.usage.total_tokens >= frame.usage.prompt_tokens,
				),
				true,
			);
			assert.equal(frames[frames.length - 1], "[DONE]");
		},
	],
	[
		"streams OpenAI chat upstream_empty protocol error through handler path",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					stream: true,
					messages: [{ role: "user", content: "say something" }],
				},
				baseConfig(),
				fakeStreamProvider([]),
			);
			assert.equal(resp.status, 200);
			const frames = collectSSEData([await resp.text()]);
			const errorFrame = frames.find((frame) => frame.error);
			assert.equal(errorFrame.error.code, "upstream_empty");
			assert.equal(errorFrame.error.message, mod.EMPTY_UPSTREAM_MSG);
			assert.equal(frames[frames.length - 1], "[DONE]");
		},
	],
	[
		"streams OpenAI chat protocol errors through handler path",
		async () => {
			const resp = await mod.handleChat(
				{
					model: "gemini-3.5-flash",
					stream: true,
					messages: [{ role: "user", content: "fail stream" }],
				},
				baseConfig(),
				fakeProvider({
					streamText() {
						throw streamError("handler upstream down", "handler_down");
					},
				}),
			);
			assert.equal(resp.status, 200);
			const frames = collectSSEData([await resp.text()]);
			const errorFrame = frames.find((frame) => frame.error);
			assert.equal(errorFrame.error.code, "handler_down");
			assert.equal(errorFrame.error.message, "handler upstream down");
			assert.equal(frames[frames.length - 1], "[DONE]");
		},
	],
	[
		"streams OpenAI chat tool call deltas and usage",
		async () => {
			const writes = [];
			await mod.streamOpenAIChatWithToolSieve(
				(chunk) => writes.push(chunk),
				baseConfig(),
				{
					provider: fakeStreamProvider([
						'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
					]),
					id: "chatcmpl_tool",
					model: "gemini-3.5-flash",
					prompt: "read",
					rm: resolvedModel(),
					fileRefs: null,
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					toolPolicy: null,
					includeUsage: true,
					promptTokens: 2,
					signal: new AbortController().signal,
				},
			);
			const frames = collectSSEData(writes);
			const toolFrame = frames.find(
				(frame) => frame.choices?.[0].delta.tool_calls,
			);
			assert.equal(toolFrame.choices[0].finish_reason, "tool_calls");
			assert.equal(
				toolFrame.choices[0].delta.tool_calls[0].function.name,
				"Read",
			);
			assert.equal(
				frames.some(
					(frame) =>
						Array.isArray(frame.choices) &&
						frame.choices.length === 0 &&
						frame.usage.total_tokens >= 2,
				),
				true,
			);
			assert.equal(frames[frames.length - 1], "[DONE]");
		},
	],
	[
		"streams OpenAI chat warning when tool call stream interrupts after a parsed call",
		async () => {
			const writes = [];
			await mod.streamOpenAIChatWithToolSieve(
				(chunk) => writes.push(chunk),
				baseConfig(),
				{
					provider: fakeProvider({
						streamText() {
							return chunks(
								[
									'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
								],
								0,
							);
						},
					}),
					id: "chatcmpl_tool_warning",
					model: "gemini-3.5-flash",
					prompt: "read",
					rm: resolvedModel(),
					fileRefs: null,
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					toolPolicy: null,
					includeUsage: false,
					promptTokens: 2,
					signal: new AbortController().signal,
				},
			);
			const frames = collectSSEData(writes);
			assert.equal(
				frames.some(
					(frame) =>
						frame.warning && frame.warning.code === "stream_interrupted",
				),
				true,
			);
			const toolFrame = frames.find(
				(frame) => frame.choices?.[0].delta.tool_calls,
			);
			assert.equal(toolFrame.choices[0].finish_reason, "tool_calls");
			assert.equal(
				toolFrame.choices[0].delta.tool_calls[0].function.name,
				"Read",
			);
			assert.equal(frames[frames.length - 1], "[DONE]");
		},
	],
	[
		"streams OpenAI chat upstream_empty error when tool sieve has no output",
		async () => {
			const writes = [];
			await mod.streamOpenAIChatWithToolSieve(
				(chunk) => writes.push(chunk),
				baseConfig(),
				{
					provider: fakeStreamProvider([]),
					id: "chatcmpl_tool_empty",
					model: "gemini-3.5-flash",
					prompt: "read",
					rm: resolvedModel(),
					fileRefs: null,
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					toolPolicy: null,
					includeUsage: false,
					promptTokens: 2,
					signal: new AbortController().signal,
				},
			);
			const frames = collectSSEData(writes);
			const errorFrame = frames.find((frame) => frame.error);
			assert.equal(errorFrame.error.code, "upstream_empty");
			assert.equal(errorFrame.error.message, mod.EMPTY_UPSTREAM_MSG);
			assert.equal(frames[frames.length - 1], "[DONE]");
		},
	],
	[
		"streams OpenAI chat warning when tool sieve text stream interrupts",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamOpenAIChatWithToolSieve(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									return chunks(["partial answer"], 0);
								},
							}),
							id: "chatcmpl_tool_partial",
							model: "gemini-3.5-flash",
							prompt: "answer",
							rm: resolvedModel(),
							fileRefs: null,
							tools: [
								{
									type: "function",
									function: { name: "Read", parameters: { type: "object" } },
								},
							],
							toolPolicy: null,
							includeUsage: false,
							promptTokens: 2,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(
				frames.some(
					(frame) =>
						frame.warning && frame.warning.code === "stream_interrupted",
				),
				true,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.choices &&
						String(frame.choices[0].delta.content || "").includes(
							"stream interrupted after partial output",
						),
				),
				false,
			);
			assert.equal(
				frames.some(
					(frame) => frame.choices && frame.choices[0].finish_reason === "stop",
				),
				true,
			);
			assert.equal(frames[frames.length - 1], "[DONE]");
			const warningLog = logs.find((line) =>
				line.includes("openai chat stream interrupted after partial output"),
			);
			assert.match(warningLog, /error=type=Error/);
			assert.doesNotMatch(warningLog, /stream broke/);
		},
	],
	[
		"streams Responses warning after partial plain output",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamResponsesWithToolSieve(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									return chunks(["partial"], 0);
								},
							}),
							rid: "resp_partial",
							rm: resolvedModel(),
							prompt: "partial",
							fileRefs: null,
							tools: null,
							toolPolicy: null,
							promptTokens: 3,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(
				frames.some(
					(frame) =>
						frame.type === "response.warning" &&
						frame.warning.code === "stream_interrupted",
				),
				true,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.type === "response.output_text.delta" &&
						String(frame.delta || "").includes(
							"stream interrupted after partial output",
						),
				),
				false,
			);
			const completed = frames.find(
				(frame) => frame.type === "response.completed",
			);
			assert.equal(completed.response.status, "completed");
			assert.equal(completed.response.usage.input_tokens, 3);
			const warningLog = logs.find((line) =>
				line.includes(
					"openai responses stream interrupted after partial output",
				),
			);
			assert.match(warningLog, /error=type=Error/);
			assert.doesNotMatch(warningLog, /stream broke/);
		},
	],
	[
		"streams Responses function call output without message text",
		async () => {
			const writes = [];
			await mod.streamResponsesWithToolSieve(
				(chunk) => writes.push(chunk),
				baseConfig(),
				{
					provider: fakeStreamProvider([
						'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
					]),
					rid: "resp_tool",
					rm: resolvedModel(),
					prompt: "read",
					fileRefs: null,
					tools: [
						{
							type: "function",
							function: { name: "Read", parameters: { type: "object" } },
						},
					],
					toolPolicy: null,
					promptTokens: 2,
					signal: new AbortController().signal,
				},
			);
			const frames = collectSSEData(writes);
			const added = frames.find(
				(frame) =>
					frame.type === "response.output_item.added" &&
					frame.item.type === "function_call",
			);
			assert.equal(added.item.name, "Read");
			const argsDone = frames.find(
				(frame) => frame.type === "response.function_call_arguments.done",
			);
			assert.equal(argsDone.name, "Read");
			assert.match(argsDone.arguments, /README\.md/);
			const completed = frames.find(
				(frame) => frame.type === "response.completed",
			);
			assert.equal(
				completed.response.output.some(
					(item) => item.type === "function_call" && item.name === "Read",
				),
				true,
			);
		},
	],
	[
		"streams Responses failure when tool stream errors before output",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamResponsesWithToolSieve(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									throw streamError("upstream down secret", "upstream_down");
								},
							}),
							rid: "resp_tool_error",
							rm: resolvedModel(),
							prompt: "read",
							fileRefs: null,
							tools: [
								{
									type: "function",
									function: { name: "Read", parameters: { type: "object" } },
								},
							],
							toolPolicy: null,
							promptTokens: 2,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			const failed = frames.find((frame) => frame.type === "response.failed");
			assert.equal(failed.response.status, "failed");
			assert.equal(failed.response.error.code, "upstream_down");
			assert.match(
				failed.response.error.message,
				/upstream error: upstream down secret/,
			);
			const failureLog = logs.find((line) =>
				line.includes("openai responses stream failed before output"),
			);
			assert.match(failureLog, /error=type=Error code=upstream_down/);
			assert.doesNotMatch(failureLog, /upstream down secret/);
		},
	],
	[
		"streams Responses warning when tool stream errors after a parsed call",
		async () => {
			const writes = [];
			const logs = [];
			await withConsoleLog(
				(line) => logs.push(String(line)),
				() =>
					mod.streamResponsesWithToolSieve(
						(chunk) => writes.push(chunk),
						baseConfig({ log_requests: true }),
						{
							provider: fakeProvider({
								streamText() {
									return chunks(
										[
											'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>',
										],
										0,
									);
								},
							}),
							rid: "resp_tool_warning",
							rm: resolvedModel(),
							prompt: "read",
							fileRefs: null,
							tools: [
								{
									type: "function",
									function: { name: "Read", parameters: { type: "object" } },
								},
							],
							toolPolicy: null,
							promptTokens: 2,
							signal: new AbortController().signal,
						},
					),
			);
			const frames = collectSSEData(writes);
			assert.equal(
				frames.some(
					(frame) =>
						frame.type === "response.warning" &&
						frame.warning.code === "stream_interrupted",
				),
				true,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.type === "response.output_text.delta" &&
						String(frame.delta || "").includes(
							"stream interrupted after partial output",
						),
				),
				false,
			);
			assert.equal(
				frames.some(
					(frame) =>
						frame.type === "response.function_call_arguments.done" &&
						frame.name === "Read",
				),
				true,
			);
			const warningLog = logs.find((line) =>
				line.includes(
					"openai responses stream interrupted after partial output",
				),
			);
			assert.match(warningLog, /error=type=Error/);
			assert.doesNotMatch(warningLog, /stream broke/);
		},
	],
	[
		"streams Responses upstream_empty failure without output text",
		async () => {
			const writes = [];
			await mod.streamResponsesWithToolSieve(
				(chunk) => writes.push(chunk),
				baseConfig(),
				{
					provider: fakeStreamProvider([]),
					rid: "resp_empty",
					rm: resolvedModel(),
					prompt: "empty",
					fileRefs: null,
					tools: null,
					toolPolicy: null,
					promptTokens: 1,
					signal: new AbortController().signal,
				},
			);
			const frames = collectSSEData(writes);
			const failed = frames.find((frame) => frame.type === "response.failed");
			assert.equal(failed.response.error.code, "upstream_empty");
			assert.equal(failed.response.error.message, mod.EMPTY_UPSTREAM_MSG);
			assert.deepEqual(failed.response.output, []);
		},
	],
];

function simplifyAttachmentCandidate(candidate) {
	const out = {};
	if (candidate.source?.type === "base64") out.b64 = candidate.source.data;
	if (candidate.mime) out.mime = candidate.mime;
	if (candidate.filename) out.filename = candidate.filename;
	return out;
}
