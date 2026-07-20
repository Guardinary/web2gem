import { describe, test } from "vitest";
import type { AttachmentPlan } from "../../../../src/attachments/types";
import type { CompletionTextInput } from "../../../../src/completion/ports";
import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../src/config";
import { handleChat } from "../../../../src/http/openai/chat";
import { handleImageGenerations } from "../../../../src/http/openai/images";
import { handleResponses } from "../../../../src/http/openai/responses";
import {
	isRecord,
	type ErrorWithMetadata,
	type UnknownRecord,
} from "../../../../src/shared/types";
import { assert } from "../../assertions.js";
import { withConsoleLog } from "../../_support/globals.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { strictProvider } from "../_support/provider.js";

function openAIConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { ...createRuntimeConfig(getConfig()), ...overrides };
}

const baseConfig = openAIConfig;

function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label} object`);
	return value;
}

function responseError(value: unknown): UnknownRecord {
	return record(record(value, "response").error, "response error");
}

function records(value: unknown, label: string): UnknownRecord[] {
	if (!Array.isArray(value)) throw new Error(`expected ${label} array`);
	return value.map((item, index) => record(item, `${label} ${index}`));
}

function firstRecord(value: unknown, label: string): UnknownRecord {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error(`expected ${label}`);
	return record(value[0], label);
}

function chatMessageText(value: unknown): unknown {
	const body = record(value, "chat response");
	const choice = firstRecord(body.choices, "chat choice");
	const message = record(choice.message, "chat message");
	if (typeof message.content === "string") return message.content;
	return firstRecord(message.content, "chat message content").text;
}

function outputMessageText(value: unknown): unknown {
	const body = record(value, "Responses response");
	const item = firstRecord(body.output, "Responses output");
	return firstRecord(item.content, "Responses message content").text;
}

function required<T>(
	value: T | null | undefined,
	label: string,
): NonNullable<T> {
	if (value === null || value === undefined)
		throw new Error(`${label} is required`);
	return value;
}

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
		const noCookieBody = responseError(await noCookie.json());
		assert.equal(noCookieBody.code, "gemini_authenticated_session_required");
		assert.equal(noCookieBody.reason, "image");
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
		const noCookieEndpointBody = responseError(await noCookieEndpoint.json());
		assert.equal(
			noCookieEndpointBody.code,
			"gemini_authenticated_session_required",
		);
		assert.equal(noCookieEndpointBody.reason, "image");
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
			responseError(await stream.json()).code,
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
			responseError(await unsupportedChat.json()).code,
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
			responseError(await unsupportedResponses.json()).code,
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
			responseError(await unsupportedImages.json()).code,
			"image_generation_provider_unsupported",
		);
	});

	test("maps image-generation upstream errors through Responses", async () => {
		const upstreamErr: ErrorWithMetadata = new Error(
			"upstream refused image generation",
		);
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
		assert.equal(
			responseError(await upstreamFailure.json()).code,
			"upstream_refused",
		);
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
			responseError(await responseStream.json()).code,
			"unsupported_image_generation_stream",
		);
	});
	test("routes Responses image generation through user-only prompt and image_generation_call output", async () => {
		const prompts: CompletionTextInput[] = [];
		const plans: AttachmentPlan[] = [];
		const provider = strictProvider({
			async resolveAttachments(attachmentPlan) {
				plans.push(attachmentPlan);
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
		const plan = required<AttachmentPlan>(plans[0], "attachment plan");
		const prompt = required<CompletionTextInput>(
			prompts[0],
			"generation prompt",
		);
		assert.equal(plan.candidates.length, 1);
		assert.equal(prompts.length, 1);
		assert.match(prompt.prompt, /draw a small blue logo/);
		assert.match(prompt.prompt, /IMAGE GENERATION ENABLED/);
		assert.doesNotMatch(
			prompt.prompt,
			/LEAK|Available tools|<\|DSML\|tool_calls>|\[image input\]/,
		);
		assert.deepEqual(prompt.fileRefs, [
			{ ref: "/uploaded/input.png", name: "input.png" },
		]);

		const body = record(await resp.json(), "image Responses response");
		const output = records(body.output, "Responses output");
		const message = required(
			output.find((item) => item.type === "message"),
			"message output",
		);
		const messageText = firstRecord(message.content, "message content").text;
		assert.equal(messageText, "caption");
		assert.doesNotMatch(messageText, /data:image/);
		const imageCall = output.find(
			(item) => item.type === "image_generation_call",
		);
		const completedCall = required(imageCall, "image generation call");
		assert.equal(completedCall.status, "completed");
		assert.equal(completedCall.result, TINY_PNG_BASE64);
		assert.equal(completedCall.output_format, "png");
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
		assert.equal(
			responseError(await remote.json()).code,
			"image_input_unsupported",
		);

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
			responseError(await remoteWithPartID.json()).code,
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
			responseError(await textBytes.json()).code,
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
			responseError(await nonImageFile.json()).code,
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
			chatMessageText(body),
			/^done\n\n!\[image\]\(data:image\/png;base64,/,
		);
		const imageBody = record(body, "chat image response");
		const usage = record(imageBody.usage, "chat image usage");
		if (typeof usage.completion_tokens !== "number")
			throw new Error("expected completion token count");
		assert.equal(usage.completion_tokens < 10, true);
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
		assert.equal(outputMessageText(body), "upstream text only");
		assert.equal(
			records(
				record(body, "text-only Responses response").output,
				"Responses output",
			).some((item) => item.type === "image_generation_call"),
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
			responseError(await chat.json()).code,
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
			responseError(await responses.json()).code,
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
			responseError(await resp.json()).code,
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
			responseError(await webOnlyChat.json()).code,
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
			responseError(await webOnlyResponses.json()).code,
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
			chatMessageText(await chat.json()),
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
		const body = record(await responses.json(), "URL-only Responses response");
		const output = records(body.output, "Responses output");
		assert.equal(
			firstRecord(
				firstRecord(output, "Responses output").content,
				"image output content",
			).text,
			"![web result](https://images.example/web.png)",
		);
		assert.equal(
			output.some((item) => item.type === "image_generation_call"),
			false,
		);
	});
	test("logs Chat and Responses image generation stages when request logging is enabled", async () => {
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
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
