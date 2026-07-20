import { describe, test } from "vitest";
import type { ApplicationExecutionContext } from "../../../../src/app";
import { base64ToBytes } from "../../../../src/attachments/base64";
import type { AttachmentPlan } from "../../../../src/attachments/types";
import type {
	CompletionRichOptions,
	CompletionTextInput,
} from "../../../../src/completion/ports";
import {
	handleImageEdits,
	handleImageEditsMultipart,
	handleImageGenerations,
} from "../../../../src/http/openai/images";
import worker from "../../../../src/index";
import { assert } from "../../assertions.js";
import { withConsoleLog } from "../../_support/globals.js";
import { attachmentResult } from "../../attachments/_support/result.js";
import { strictProvider } from "../_support/provider.js";
import {
	openAIConfig,
	record,
	required,
	responseError,
} from "./_support/fixtures.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const TINY_PNG_BYTES = base64ToBytes(TINY_PNG_BASE64);

const execution: ApplicationExecutionContext = { waitUntil() {} };

const baseConfig = openAIConfig;

function tinyPngFile(name = "input.png") {
	return new File([TINY_PNG_BYTES.buffer as ArrayBuffer], name, {
		type: "image/png",
	});
}

describe("OpenAI Images endpoint", () => {
	test("routes OpenAI Images generations through forced image mode", async () => {
		let seenInput: CompletionTextInput | null = null;
		const resp = await handleImageGenerations(
			{
				model: "gemini-3.5-flash",
				prompt: "draw an endpoint logo",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich(generationInput) {
					seenInput = generationInput;
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
		const input = required<CompletionTextInput>(seenInput, "generation input");
		assert.match(input.prompt, /draw an endpoint logo/);
		assert.match(input.prompt, /IMAGE GENERATION ENABLED/);
		assert.doesNotMatch(input.prompt, /Available tools|<\|DSML\|tool_calls>/);
		assert.equal(input.fileRefs, null);
		const body = record(await resp.json(), "image generation response");
		assert.equal(typeof body.created, "number");
		assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
	});
	test("parses OpenAI Images JSON stream values compatibly", async () => {
		let generated = 0;
		const provider = strictProvider({
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

		const falseString = await handleImageGenerations(
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

		const trueString = await handleImageGenerations(
			{
				prompt: "draw with string true stream",
				stream: "true",
			},
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(trueString.status, 400);
		assert.equal(
			responseError(await trueString.json()).code,
			"unsupported_image_generation_stream",
		);

		const invalidString = await handleImageGenerations(
			{
				prompt: "draw with invalid stream",
				stream: "maybe",
			},
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(invalidString.status, 400);
		assert.equal(
			responseError(await invalidString.json()).code,
			"invalid_request",
		);
		assert.equal(generated, 1);
	});
	test("routes OpenAI Images edits through JSON image inputs", async () => {
		const plans: AttachmentPlan[] = [];
		let seenInput: CompletionTextInput | null = null;
		const resp = await handleImageEdits(
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
			strictProvider({
				async resolveAttachments(jsonPlan) {
					plans.push(jsonPlan);
					return attachmentResult({
						fileRefs: [
							{ ref: "/uploaded/first.png", name: "first.png" },
							{ ref: "/uploaded/second.png", name: "second.png" },
						],
					});
				},
				async generateRich(jsonInput) {
					seenInput = jsonInput;
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
		const plan = required<AttachmentPlan>(plans[0], "JSON image plan");
		const input = required<CompletionTextInput>(seenInput, "JSON image input");
		assert.equal(plan.candidates.length, 2);
		assert.deepEqual(
			plan.candidates.map((candidate) => candidate.kind),
			["image", "image"],
		);
		assert.deepEqual(input.fileRefs, [
			{ ref: "/uploaded/first.png", name: "first.png" },
			{ ref: "/uploaded/second.png", name: "second.png" },
		]);
		const body = record(await resp.json(), "JSON edit response");
		assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
	});
	test("routes OpenAI Images multipart edits through ordered image inputs", async () => {
		const form = new FormData();
		form.append("model", "gemini-3.5-flash");
		form.append("prompt", "edit the uploaded references");
		form.append("image", tinyPngFile("first.png"));
		form.append("image_url", `data:image/png;base64,${TINY_PNG_BASE64}`);
		form.append("images[]", tinyPngFile("third.png"));

		const plans: AttachmentPlan[] = [];
		let seenInput: CompletionTextInput | null = null;
		const resp = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: form,
			}),
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async resolveAttachments(multipartPlan) {
					plans.push(multipartPlan);
					return attachmentResult({
						fileRefs: [
							{ ref: "/uploaded/first.png", name: "first.png" },
							{ ref: "/uploaded/second.png", name: "second.png" },
							{ ref: "/uploaded/third.png", name: "third.png" },
						],
					});
				},
				async generateRich(multipartInput) {
					seenInput = multipartInput;
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
		const plan = required<AttachmentPlan>(plans[0], "multipart image plan");
		const input = required<CompletionTextInput>(
			seenInput,
			"multipart image input",
		);
		assert.equal(plans.length, 1);
		assert.deepEqual(
			plan.candidates.map((candidate) => candidate.filename),
			["first.png", "image-2.png", "third.png"],
		);
		assert.deepEqual(input.fileRefs, [
			{ ref: "/uploaded/first.png", name: "first.png" },
			{ ref: "/uploaded/second.png", name: "second.png" },
			{ ref: "/uploaded/third.png", name: "third.png" },
		]);
		const body = record(await resp.json(), "multipart edit response");
		assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
	});
	test("accepts OpenAI Images multipart edit field aliases and JSON reference strings", async () => {
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

		const plans: AttachmentPlan[] = [];
		let seenInput: CompletionTextInput | null = null;
		const resp = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: form,
			}),
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async resolveAttachments(aliasAttachmentPlan) {
					plans.push(aliasAttachmentPlan);
					return attachmentResult({
						fileRefs: aliasAttachmentPlan.candidates.map((candidate) => {
							const filename = candidate.filename;
							if (!filename) throw new Error("expected candidate filename");
							return { ref: `/uploaded/${filename}`, name: filename };
						}),
					});
				},
				async generateRich(aliasGenerationInput) {
					seenInput = aliasGenerationInput;
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
		const aliasPlan = required<AttachmentPlan>(plans[0], "alias image plan");
		const aliasInput = required<CompletionTextInput>(
			seenInput,
			"alias image input",
		);
		assert.deepEqual(
			aliasPlan.candidates.map((candidate) => candidate.filename),
			expectedNames,
		);
		assert.deepEqual(
			aliasInput.fileRefs,
			expectedNames.map((name) => ({ ref: `/uploaded/${name}`, name })),
		);
		const body = record(await resp.json(), "alias edit response");
		assert.deepEqual(body.data, [{ b64_json: TINY_PNG_BASE64 }]);
	});
	test("dispatches multipart OpenAI Images edits before JSON parsing", async () => {
		const form = new FormData();
		form.append("prompt", "edit");
		form.append("stream", "true");
		form.append("image", tinyPngFile("input.png"));
		const resp = await worker.fetch(
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
			execution,
		);

		assert.equal(resp.status, 400);
		assert.equal(
			responseError(await resp.json()).code,
			"unsupported_image_generation_stream",
		);
	});
	test("rejects unsupported multipart OpenAI Images edit inputs before upstream work", async () => {
		let generated = false;
		const remoteForm = new FormData();
		remoteForm.append("model", "gemini-3.5-flash");
		remoteForm.append("prompt", "edit it");
		remoteForm.append("image_url", "https://cdn.example.com/image.png");
		const remote = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: remoteForm,
			}),
			baseConfig({ cookie: "SID=ok", request_body_max_bytes: 1 }),
			strictProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(remote.status, 400);
		assert.equal(
			responseError(await remote.json()).code,
			"image_input_unsupported",
		);

		const textFileForm = new FormData();
		textFileForm.append("model", "gemini-3.5-flash");
		textFileForm.append("prompt", "edit it");
		textFileForm.append(
			"image",
			new File([new TextEncoder().encode("not an image")], "not-image.png", {
				type: "image/png",
			}),
		);
		const textFile = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: textFileForm,
			}),
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(textFile.status, 400);
		assert.equal(
			responseError(await textFile.json()).code,
			"image_input_unsupported",
		);

		const tooLargeForm = new FormData();
		tooLargeForm.append("model", "gemini-3.5-flash");
		tooLargeForm.append("prompt", "edit it");
		tooLargeForm.append("image", tinyPngFile("large.png"));
		const tooLarge = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: tooLargeForm,
			}),
			baseConfig({ cookie: "SID=ok", generic_file_upload_max_bytes: 2 }),
			strictProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(tooLarge.status, 413);
		assert.equal(
			responseError(await tooLarge.json()).code,
			"image_input_too_large",
		);

		const declaredTooLarge = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				headers: {
					"content-type": "multipart/form-data; boundary=x",
					"content-length": "1048577",
				},
				body: "--x--",
			}),
			baseConfig({ cookie: "SID=ok", generic_file_upload_max_bytes: 0 }),
			strictProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(declaredTooLarge.status, 413);
		assert.equal(
			responseError(await declaredTooLarge.json()).code,
			"image_input_too_large",
		);
		assert.equal(generated, false);
	});
	test("supports OpenAI Images url response format without Worker-hosted image URLs", async () => {
		let generateOptions: CompletionRichOptions | undefined;
		const resp = await handleImageGenerations(
			{
				model: "gemini-3.5-flash",
				prompt: "draw a URL-returned image",
				response_format: "url",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
		const body = record(await resp.json(), "URL image response");
		const data = Array.isArray(body.data) ? body.data : [];
		const firstData = record(data[0], "URL image data");
		assert.deepEqual(body.data, [
			{ url: "https://images.example/generated.png" },
		]);
		assert.equal(String(firstData.url).startsWith("/images/"), false);
		assert.deepEqual(generateOptions, { hydrateGeneratedImageBytes: false });
	});
	test("rejects unsupported OpenAI Images endpoint options before upstream work", async () => {
		let generated = false;
		const provider = strictProvider({
			async generateRich() {
				generated = true;
				return { text: "", images: [] };
			},
		});

		const stream = await worker.fetch(
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
			execution,
		);
		assert.equal(stream.status, 400);
		assert.equal(
			responseError(await stream.json()).code,
			"unsupported_image_generation_stream",
		);

		const count = await handleImageGenerations(
			{ prompt: "draw", n: 2 },
			baseConfig(),
			provider,
		);
		assert.equal(count.status, 400);
		assert.equal(
			responseError(await count.json()).code,
			"unsupported_image_count",
		);

		const format = await handleImageGenerations(
			{ prompt: "draw", response_format: "base64" },
			baseConfig(),
			provider,
		);
		assert.equal(format.status, 400);
		assert.equal(
			responseError(await format.json()).code,
			"invalid_response_format",
		);
		assert.equal(generated, false);
	});
	test("normalizes scalar image options and rejects invalid option types", async () => {
		let generated = 0;
		const provider = strictProvider({
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

		const stringCountAndNumberStream = await handleImageGenerations(
			{
				prompt: "draw valid options",
				n: "1",
				stream: 0,
			},
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(stringCountAndNumberStream.status, 200);

		const emptyPrompt = await handleImageGenerations(
			{ prompt: "   " },
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(emptyPrompt.status, 400);
		assert.equal(
			responseError(await emptyPrompt.json()).code,
			"image_generation_empty_prompt",
		);

		const nonStringPrompt = await handleImageGenerations(
			{ prompt: 123 },
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(nonStringPrompt.status, 400);
		assert.equal(
			responseError(await nonStringPrompt.json()).code,
			"image_generation_empty_prompt",
		);

		const nonStringFormat = await handleImageGenerations(
			{ prompt: "draw", response_format: 1 },
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(nonStringFormat.status, 400);
		assert.equal(
			responseError(await nonStringFormat.json()).code,
			"invalid_response_format",
		);

		const nonStringStream = await handleImageGenerations(
			{ prompt: "draw", stream: {} },
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(nonStringStream.status, 400);
		assert.equal(
			responseError(await nonStringStream.json()).code,
			"invalid_request",
		);

		const badNumberStream = await handleImageGenerations(
			{ prompt: "draw", stream: 2 },
			baseConfig({ cookie: "SID=ok" }),
			provider,
		);
		assert.equal(badNumberStream.status, 400);
		assert.equal(
			responseError(await badNumberStream.json()).code,
			"invalid_request",
		);
		assert.equal(generated, 1);
	});
	test("rejects OpenAI Images edits without local image inputs", async () => {
		let generated = false;
		const remote = await handleImageEdits(
			{
				model: "gemini-3.5-flash",
				prompt: "edit it",
				image_url: "https://cdn.example.com/image.png",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(remote.status, 400);
		assert.equal(
			responseError(await remote.json()).code,
			"image_input_unsupported",
		);

		const missing = await handleImageEdits(
			{
				model: "gemini-3.5-flash",
				prompt: "edit it",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					generated = true;
					return { text: "", images: [] };
				},
			}),
		);
		assert.equal(missing.status, 400);
		assert.equal(
			responseError(await missing.json()).code,
			"image_input_unsupported",
		);
		assert.equal(generated, false);
	});
	test("fails forced OpenAI Images endpoints on text-only or URL-only b64_json output", async () => {
		const textOnly = await handleImageGenerations(
			{
				model: "gemini-3.5-flash",
				prompt: "draw",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					return { text: "policy text only", images: [] };
				},
			}),
		);
		assert.equal(textOnly.status, 502);
		assert.equal(
			responseError(await textOnly.json()).code,
			"upstream_image_generation_empty",
		);

		const urlOnly = await handleImageGenerations(
			{
				model: "gemini-3.5-flash",
				prompt: "draw",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
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
			responseError(await urlOnly.json()).code,
			"upstream_image_fetch_failed",
		);
	});
	test("fails OpenAI Images url format when generated images have no usable URL", async () => {
		const resp = await handleImageGenerations(
			{
				model: "gemini-3.5-flash",
				prompt: "draw",
				response_format: "url",
			},
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					return {
						text: "",
						images: [
							{
								url: "",
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
		const error = responseError(await resp.json());
		assert.equal(error.code, "upstream_image_generation_empty");
		assert.match(error.message, /without usable URLs/);
	});
	test("rejects multipart OpenAI Images edits with invalid form fields or no images", async () => {
		const invalidStreamForm = new FormData();
		invalidStreamForm.append("prompt", "edit");
		invalidStreamForm.append("stream", "maybe");
		invalidStreamForm.append("image", tinyPngFile("input.png"));
		const invalidStream = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: invalidStreamForm,
			}),
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					throw new Error(
						"generateRich should not run for invalid multipart stream values",
					);
				},
			}),
		);
		assert.equal(invalidStream.status, 400);
		assert.equal(
			responseError(await invalidStream.json()).code,
			"invalid_request",
		);

		const noImageForm = new FormData();
		noImageForm.append("prompt", "edit");
		noImageForm.append("n", "1");
		noImageForm.append("size", "1024x1024");
		noImageForm.append("response_format", "b64_json");
		const noImage = await handleImageEditsMultipart(
			new Request("https://worker.example/v1/images/edits", {
				method: "POST",
				body: noImageForm,
			}),
			baseConfig({ cookie: "SID=ok" }),
			strictProvider({
				async generateRich() {
					throw new Error(
						"generateRich should not run without multipart images",
					);
				},
			}),
		);
		assert.equal(noImage.status, 400);
		assert.equal(
			responseError(await noImage.json()).code,
			"image_input_unsupported",
		);
	});
	test("logs image generation stages when request logging is enabled", async () => {
		const logs: string[] = [];
		await withConsoleLog(
			(line: unknown) => logs.push(String(line)),
			async () => {
				const resp = await handleImageGenerations(
					{
						model: "gemini-3.5-flash",
						prompt: "draw with logging",
					},
					baseConfig({ cookie: "SID=ok", log_requests: true }),
					strictProvider({
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
			logs.some((line) => line.includes("openai_images_generations_generate")),
			true,
		);
	});
});
