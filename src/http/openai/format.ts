import type { SSEWrite } from "../core/sse";
import { nowSec } from "../../shared/logging";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";
import { tokenEst } from "../../shared/tokens";
import { isRecord } from "../../shared/types";
import type { GeneratedImage } from "../../completion/ports";

export { finalizeOpenAICompletionResult } from "../../completion/turn";

type OpenAIChunkDelta = Record<string, unknown>;
type OpenAIToolCall = {
	id: string;
	function: { name: string; arguments: string };
};

export type OpenAIImagesResponseFormat = "b64_json" | "url";

export function openAIChatChunk(
	id: string,
	model: unknown,
	delta: OpenAIChunkDelta | null | undefined,
	finishReason: string | null,
) {
	return {
		id,
		object: "chat.completion.chunk",
		created: nowSec(),
		model: String(model || ""),
		choices: [
			{
				index: 0,
				delta: delta || {},
				finish_reason: finishReason == null ? null : finishReason,
			},
		],
	};
}

export function openAIChatUsageFromCompletionTokens(
	promptTokens: unknown,
	completionTokens: unknown,
) {
	const promptTokenCount = Math.max(0, Number(promptTokens) || 0);
	const completionTokenCount = Math.max(0, Number(completionTokens) || 0);
	return {
		prompt_tokens: promptTokenCount,
		completion_tokens: completionTokenCount,
		total_tokens: promptTokenCount + completionTokenCount,
	};
}

export async function writeOpenAIChatUsageTokenChunk(
	write: SSEWrite,
	id: string,
	model: unknown,
	promptTokens: unknown,
	completionTokens: unknown,
): Promise<void> {
	const result = write(
		`data: ${JSON.stringify({
			id,
			object: "chat.completion.chunk",
			created: nowSec(),
			model: String(model || ""),
			choices: [],
			usage: openAIChatUsageFromCompletionTokens(
				promptTokens,
				completionTokens,
			),
		})}\n\n`,
	);
	if (isPromiseLike(result)) await result;
}

export async function writeOpenAIChatStreamError(
	write: SSEWrite,
	id: string,
	model: unknown,
	e: unknown,
): Promise<void> {
	const error: Record<string, unknown> = {
		message: upstreamErrorMessage(e),
		type: "api_error",
		code: upstreamErrorCode(e) || "upstream_error",
		param: null,
	};
	const reason = upstreamErrorReason(e);
	if (reason) error.reason = reason;
	let result = write(
		`event: error\ndata: ${JSON.stringify({ error, id, model: String(model || "") })}\n\n`,
	);
	if (isPromiseLike(result)) await result;
	result = write("data: [DONE]\n\n");
	if (isPromiseLike(result)) await result;
}

export function openAIResponsesUsage(
	promptTokens: unknown,
	outputText: unknown,
) {
	const inputTokens = Math.max(0, Number(promptTokens) || 0);
	const outputTokens = tokenEst(outputText);
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: inputTokens + outputTokens,
	};
}

export function buildResponsesOutput(
	text: unknown,
	toolCalls: unknown,
	mid: string,
) {
	const output: Record<string, unknown>[] = [];
	if (Array.isArray(toolCalls)) {
		for (const tc of toolCalls) {
			if (!isOpenAIToolCall(tc)) continue;
			const call = tc;
			output.push({
				type: "function_call",
				id: call.id,
				call_id: call.id,
				name: call.function.name,
				arguments: call.function.arguments,
				status: "completed",
			});
		}
	}
	if (text || !Array.isArray(toolCalls) || !toolCalls.length) {
		output.push({
			type: "message",
			id: mid,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: text || "", annotations: [] }],
		});
	}
	return output;
}

export function buildImageResponsesOutput(
	text: unknown,
	images: readonly GeneratedImage[],
	mid: string,
	idForIndex: (index: number) => string,
) {
	const output: Record<string, unknown>[] = [];
	const imageCalls = images.filter(hasImageCallBytes);
	const messageText = imageGenerationChatContent(
		text,
		imageCalls.length
			? images.filter((image) => !hasImageCallBytes(image))
			: images,
	);
	if (messageText || !imageCalls.length) {
		output.push({
			type: "message",
			id: mid,
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: messageText, annotations: [] }],
		});
	}
	imageCalls.forEach((image, index) => {
		output.push(imageGenerationCallItem(image, idForIndex(index)));
	});
	return output;
}

export function imageGenerationChatContent(
	text: unknown,
	images: readonly GeneratedImage[],
): string {
	const parts: string[] = [];
	const textValue = String(text || "").trim();
	if (textValue) parts.push(textValue);
	for (const image of images) {
		const source =
			image.base64 && image.outputFormat
				? `data:image/${image.outputFormat};base64,${image.base64}`
				: image.url;
		if (!source) continue;
		parts.push(`![${image.alt || image.title || "image"}](${source})`);
	}
	return parts.join("\n\n");
}

export function buildOpenAIImagesResponse(
	images: readonly GeneratedImage[],
	options: { created: number; responseFormat: OpenAIImagesResponseFormat },
): Record<string, unknown> {
	const data: Record<string, string>[] = [];
	for (const image of images) {
		if (options.responseFormat === "b64_json") {
			if (image.base64) data.push({ b64_json: image.base64 });
			continue;
		}
		if (image.url) data.push({ url: image.url });
	}
	return { created: options.created, data };
}

function hasImageCallBytes(image: GeneratedImage): boolean {
	return !!(image.base64 && image.outputFormat);
}

function imageGenerationCallItem(
	image: GeneratedImage,
	id: string,
): Record<string, unknown> {
	return {
		type: "image_generation_call",
		id,
		status: "completed",
		result: image.base64 || "",
		output_format: image.outputFormat || null,
		revised_prompt: null,
	};
}

function isOpenAIToolCall(value: unknown): value is OpenAIToolCall {
	if (!isRecord(value) || !isRecord(value.function)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.function.name === "string" &&
		typeof value.function.arguments === "string"
	);
}

function isPromiseLike(value: unknown): value is Promise<void> {
	return !!value && typeof (value as Promise<void>).then === "function";
}
