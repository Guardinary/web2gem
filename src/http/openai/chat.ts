import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG } from "../../completion";
import type {
	CompletionProvider,
	CompletionRichOutput,
} from "../../completion";
import type { RuntimeConfig } from "../../config";
import { prepareOpenAIImageGenerationCompletion } from "../../completion/image-generation";
import { prepareOpenAICompletion } from "../../completion/openai";
import { elapsedMs, log, logStage, nowMs, nowSec } from "../../shared/logging";
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import { randHex } from "../../shared/crypto";
import { tokenEst } from "../../shared/tokens";
import { isRecord, type UnknownRecord } from "../../shared/types";
import { openAIErrorResponse, openAIUpstreamErrorResponse } from "./errors";
import {
	finalizeOpenAICompletionResult,
	imageGenerationChatContent,
	openAIChatUsageFromCompletionTokens,
} from "./format";
import { writeOpenAIChatStreamError } from "./format";
import { imageGenerationMode } from "./image-generation";
import {
	streamOpenAIChatPlain,
	streamOpenAIChatWithToolSieve,
} from "./chat-stream";

// POST /v1/chat/completions
export async function handleChat(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
) {
	const imageMode = imageGenerationMode(req);
	if (imageMode.enabled)
		return handleImageGenerationChat(req, cfg, provider, imageMode.forced);
	const messages = req.messages || [];
	const logRequests = !!cfg.log_requests;
	const prepareStart = logRequests ? nowMs() : 0;
	const prepared = await prepareOpenAICompletion(
		cfg,
		provider,
		req,
		messages,
		req.tools,
		{ emptyPromptMessage: "empty prompt" },
	);
	if ("error" in prepared) {
		await provider.dispose?.();
		if (logRequests)
			logStage(cfg, "openai_chat_prepare", {
				ms: elapsedMs(prepareStart),
				status: prepared.error.status,
				code: prepared.error.code,
			});
		return openAIErrorResponse(
			prepared.error.message,
			prepared.error.status,
			prepared.error.code,
			prepared.error.reason,
		);
	}
	const {
		rm,
		structured,
		allTools,
		tools,
		toolPolicy,
		promptToolChoice,
		prompt,
		fileRefs,
		promptTokens,
		contextFiles,
	} = prepared;
	if (logRequests) {
		logStage(cfg, "openai_chat_prepare", {
			ms: elapsedMs(prepareStart),
			status: 200,
			model: rm.name,
			promptChars: prompt.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
			contextFiles: !!contextFiles,
			contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
		});
	}

	const stream = !!req.stream;
	if (stream && structured) {
		return openAIErrorResponse(
			"response_format with stream is not supported by this worker because final JSON cannot be validated while streaming",
			400,
			"unsupported_response_format_stream",
		);
	}
	const cid = `chatcmpl-${randHex(12)}`;
	const streamOptions = isRecord(req.stream_options)
		? req.stream_options
		: null;
	const includeStreamUsage = !!streamOptions?.include_usage;
	const detectForbiddenToolCalls = !!(
		stream &&
		promptToolChoice === "none" &&
		allTools.length
	);

	if (
		stream &&
		(!tools || promptToolChoice === "none") &&
		!detectForbiddenToolCalls
	) {
		return sseResponse(
			async (write, signal) => {
				const generationStart = logRequests ? nowMs() : 0;
				await streamOpenAIChatPlain(write, cfg, {
					provider,
					id: cid,
					model: rm.name,
					prompt,
					rm,
					fileRefs,
					includeUsage: includeStreamUsage,
					promptTokens,
					signal,
				});
				if (logRequests)
					logStage(cfg, "openai_chat_stream_generate", {
						ms: elapsedMs(generationStart),
						model: rm.name,
						promptTokens,
						fileRefs: fileRefs ? fileRefs.length : 0,
					});
			},
			{
				onError: (write, e) =>
					writeOpenAIChatStreamError(write, cid, rm.name, e),
			},
		);
	}

	if (
		stream &&
		((tools && promptToolChoice !== "none") || detectForbiddenToolCalls)
	) {
		return sseResponse(
			async (write, signal) => {
				const generationStart = logRequests ? nowMs() : 0;
				await streamOpenAIChatWithToolSieve(write, cfg, {
					provider,
					id: cid,
					model: rm.name,
					prompt,
					rm,
					fileRefs,
					tools: tools || allTools,
					toolPolicy,
					includeUsage: includeStreamUsage,
					promptTokens,
					signal,
				});
				if (logRequests)
					logStage(cfg, "openai_chat_stream_generate", {
						ms: elapsedMs(generationStart),
						model: rm.name,
						promptTokens,
						fileRefs: fileRefs ? fileRefs.length : 0,
						tools: (tools || allTools).length,
					});
			},
			{
				onError: (write, e) =>
					writeOpenAIChatStreamError(write, cid, rm.name, e),
			},
		);
	}

	let text: string;
	const generationStart = logRequests ? nowMs() : 0;
	try {
		text = await provider.generateText({ prompt, rm, fileRefs });
	} catch (e) {
		if (logRequests)
			logStage(cfg, "openai_chat_generate", {
				ms: elapsedMs(generationStart),
				status: "error",
				model: rm.name,
			});
		log(
			cfg,
			`openai chat generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return openAIUpstreamErrorResponse(e);
	}
	if (logRequests)
		logStage(cfg, "openai_chat_generate", {
			ms: elapsedMs(generationStart),
			status: "ok",
			model: rm.name,
			completionChars: text.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});

	const finalized = finalizeOpenAICompletionResult(text, {
		tools,
		noneModeTools: allTools,
		promptToolChoice,
		structured,
		toolPolicy,
	});
	if (finalized.error)
		return openAIErrorResponse(
			finalized.error.message,
			finalized.error.status,
			finalized.error.code,
		);
	const { toolCalls } = finalized;
	text = finalized.text;
	if (!text && !toolCalls) {
		log(cfg, `openai chat generate produced no content model=${rm.name}`);
		return openAIErrorResponse(EMPTY_UPSTREAM_MSG, 502, "upstream_empty");
	}
	const msg: Record<string, unknown> = {
		role: "assistant",
		content: text || null,
	};
	if (toolCalls) msg.tool_calls = toolCalls;
	const finish = toolCalls ? "tool_calls" : "stop";

	const payload: Record<string, unknown> = {
		id: cid,
		object: "chat.completion",
		created: nowSec(),
		model: rm.name,
		choices: [{ index: 0, message: msg, finish_reason: finish }],
		usage: (() => {
			const completionTokens = tokenEst(text);
			return {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
			};
		})(),
	};
	return jsonResponse(payload);
}

async function handleImageGenerationChat(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	forced: boolean,
): Promise<Response> {
	if (req.stream)
		return openAIErrorResponse(
			"streaming image generation is not supported by this worker",
			400,
			"unsupported_image_generation_stream",
		);
	if (!provider.generateRich) {
		return openAIErrorResponse(
			"configured completion provider does not support image generation",
			502,
			"image_generation_provider_unsupported",
		);
	}

	const logRequests = !!cfg.log_requests;
	const prepareStart = logRequests ? nowMs() : 0;
	const prepared = await prepareOpenAIImageGenerationCompletion(
		cfg,
		provider,
		req,
		"chat",
		forced,
	);
	if ("error" in prepared) {
		await provider.dispose?.();
		if (logRequests)
			logStage(cfg, "openai_chat_image_prepare", {
				ms: elapsedMs(prepareStart),
				status: prepared.error.status,
				code: prepared.error.code,
			});
		return openAIErrorResponse(
			prepared.error.message,
			prepared.error.status,
			prepared.error.code,
			prepared.error.reason,
		);
	}
	const { rm, prompt, fileRefs, promptTokens } = prepared;
	if (logRequests) {
		logStage(cfg, "openai_chat_image_prepare", {
			ms: elapsedMs(prepareStart),
			status: 200,
			model: rm.name,
			promptChars: prompt.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});
	}

	const generationStart = logRequests ? nowMs() : 0;
	let rich: CompletionRichOutput;
	try {
		rich = await provider.generateRich({ prompt, rm, fileRefs });
	} catch (e) {
		if (logRequests)
			logStage(cfg, "openai_chat_image_generate", {
				ms: elapsedMs(generationStart),
				status: "error",
				model: rm.name,
			});
		log(
			cfg,
			`openai chat image generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return openAIUpstreamErrorResponse(e);
	}
	if (!String(rich.text || "").trim() && !rich.images.length) {
		return openAIErrorResponse(
			"Gemini returned empty image generation output",
			502,
			"upstream_image_generation_empty",
		);
	}
	if (forced && !rich.images.some((image) => image.source === "generated")) {
		return openAIErrorResponse(
			"Gemini returned no usable generated image",
			502,
			"upstream_image_generation_empty",
		);
	}
	if (logRequests) {
		logStage(cfg, "openai_chat_image_generate", {
			ms: elapsedMs(generationStart),
			status: "ok",
			model: rm.name,
			completionChars: rich.text.length,
			images: rich.images.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});
	}

	const content = imageGenerationChatContent(rich.text, rich.images);
	const completionTokens = tokenEst(rich.text);
	return jsonResponse({
		id: `chatcmpl-${randHex(12)}`,
		object: "chat.completion",
		created: nowSec(),
		model: rm.name,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		usage: openAIChatUsageFromCompletionTokens(promptTokens, completionTokens),
	});
}
