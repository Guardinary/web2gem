import { describe, test } from "vitest";
import { handleChat } from "../../../../src/http/openai/chat";
import { handleImageGenerations } from "../../../../src/http/openai/images";
import { handleResponses } from "../../../../src/http/openai/responses";
import { assert } from "../../assertions.js";
import { withConsoleLog } from "../../_support/globals.js";
import { baseConfig } from "../../_support/runtime-config.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { strictProvider } from "../_support/provider.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("OpenAI image-mode handler", () => {
	test("requires cookie for image generation and rejects streaming before upstream work", async () => {
		let generated = false;
		const noCookie = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "draw a red square",
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "" }),
			strictProvider({
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

		const noCookieEndpoint = await handleImageGenerations(
			{
				model: "gemini-3.5-flash",
				prompt: "draw a red square",
			},
			baseConfig({ cookie: "" }),
			strictProvider({
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

		const stream = await handleChat(
			{
				model: "gemini-3.5-flash",
				stream: true,
				messages: [{ role: "user", content: "draw a red square" }],
				tool_choice: { type: "image_generation" },
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
		assert.equal(generated, false);
	});
	test("returns image provider unsupported errors across OpenAI endpoints", async () => {
		const unsupportedChat = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "draw" }],
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
		);
		assert.equal(unsupportedChat.status, 502);
		assert.equal(
			(await unsupportedChat.json()).error.code,
			"image_generation_provider_unsupported",
		);

		const unsupportedResponses = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "draw",
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
		);
		assert.equal(unsupportedResponses.status, 502);
		assert.equal(
			(await unsupportedResponses.json()).error.code,
			"image_generation_provider_unsupported",
		);

		const unsupportedImages = await handleImageGenerations(
			{
				prompt: "draw",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider(),
		);
		assert.equal(unsupportedImages.status, 502);
		assert.equal(
			(await unsupportedImages.json()).error.code,
			"image_generation_provider_unsupported",
		);
	});

	test("maps image-generation upstream errors through Responses", async () => {
		const upstreamErr = new Error("upstream refused image generation");
		upstreamErr.status = 503;
		upstreamErr.code = "upstream_refused";
		const upstreamFailure = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "draw",
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					throw upstreamErr;
				},
			}),
		);
		assert.equal(upstreamFailure.status, 503);
		assert.equal((await upstreamFailure.json()).error.code, "upstream_refused");
	});

	test("rejects streaming Responses image generation before provider work", async () => {
		const responseStream = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "draw",
				stream: true,
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
	});
	test("routes Responses image generation through user-only prompt and image_generation_call output", async () => {
		const prompts = [];
		const plans = [];
		const provider = strictProvider({
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
		const resp = await handleResponses(
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
	});
	test("rejects unsupported image-mode inputs clearly", async () => {
		const remote = await handleResponses(
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
			strictProvider({
				async generateRich() {
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(remote.status, 400);
		assert.equal((await remote.json()).error.code, "image_input_unsupported");

		const remoteWithPartID = await handleResponses(
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
			strictProvider({
				async generateRich() {
					throw new Error("generateRich should not run for remote image URLs");
				},
			}),
		);
		assert.equal(remoteWithPartID.status, 400);
		assert.equal(
			(await remoteWithPartID.json()).error.code,
			"image_input_unsupported",
		);

		const textBytes = await handleResponses(
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
			strictProvider({
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

		const nonImageFile = await handleResponses(
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
			strictProvider({
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
	});
	test("returns client-usable Chat image generation markdown without counting image base64 as tokens", async () => {
		const resp = await handleChat(
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
			strictProvider({
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
	});
	test("passes through tools-only image mode text when upstream returns no image", async () => {
		const resp = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "generate an image, but upstream replies with text",
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
	});
	test("rejects empty tools-only image output instead of returning blank success", async () => {
		const chat = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "generate an image" }],
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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

		const responses = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "generate an image",
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
	});
	test("keeps forced image mode no-image failure", async () => {
		const resp = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "generate an image" }],
				tool_choice: { type: "image_generation" },
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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

		const webOnlyChat = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "generate an image" }],
				tool_choice: { type: "image_generation" },
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					return {
						text: "",
						images: [{ url: "https://images.example/web.png", source: "web" }],
					};
				},
			}),
		);
		assert.equal(webOnlyChat.status, 502);
		assert.equal(
			(await webOnlyChat.json()).error.code,
			"upstream_image_generation_empty",
		);

		const webOnlyResponses = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "generate an image",
				tool_choice: { type: "image_generation" },
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					return {
						text: "",
						images: [{ url: "https://images.example/web.png", source: "web" }],
					};
				},
			}),
		);
		assert.equal(webOnlyResponses.status, 502);
		assert.equal(
			(await webOnlyResponses.json()).error.code,
			"upstream_image_generation_empty",
		);
	});
	test("passes through URL-only image output as markdown", async () => {
		const chat = await handleChat(
			{
				model: "gemini-3.5-flash",
				messages: [{ role: "user", content: "show an image" }],
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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

		const responses = await handleResponses(
			{
				model: "gemini-3.5-flash",
				input: "show an image",
				tools: [{ type: "image_generation" }],
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
	});
	test("logs Chat and Responses image generation stages when request logging is enabled", async () => {
		const logs = [];
		await withConsoleLog(
			(line) => logs.push(String(line)),
			async () => {
				const provider = strictProvider({
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

				const chat = await handleChat(
					{
						model: "gemini-3.5-flash",
						messages: [{ role: "user", content: "draw with chat logging" }],
						tool_choice: { type: "image_generation" },
					},
					baseConfig({ cookie: "SID=ok", log_requests: true }),
					provider,
				);
				assert.equal(chat.status, 200);

				const responses = await handleResponses(
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
	});
});
