import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG } from "../../completion";
import type {
	CompletionProvider,
	CompletionRichOutput,
} from "../../completion";
import { prepareOpenAIImageGenerationCompletion } from "../../completion/image-generation";
import { prepareOpenAICompletion } from "../../completion/openai";
import { normalizeResponsesInputAsMessagesStrict } from "../../promptcompat/responses-input";
import { elapsedMs, log, logStage, nowMs, nowSec } from "../../shared/logging";
import {
	errorLogSummary,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";
import { randHex } from "../../shared/crypto";
import { openAIErrorResponse, openAIUpstreamErrorResponse } from "./errors";
import {
	buildImageResponsesOutput,
	buildResponsesOutput,
	finalizeOpenAICompletionResult,
	openAIResponsesUsage,
} from "./format";
import { imageGenerationMode } from "./image-generation";
import {
	streamResponsesWithToolSieve,
	writeResponsesEvent,
} from "./responses-stream";
import type { RuntimeConfig } from "../../config";

// POST /v1/responses(Codex CLI 用)
export async function handleResponses(
	req: Record<string, unknown> | undefined,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
) {
	if (!req)
		return openAIErrorResponse("request body must be a JSON object", 400);
	const imageMode = imageGenerationMode(req);
	if (imageMode.enabled)
		return handleImageGenerationResponses(req, cfg, provider, imageMode.forced);
	const normalized = normalizeResponsesInputAsMessagesStrict(req);
	if (normalized.error)
		return openAIErrorResponse(
			normalized.error,
			400,
			"unsupported_responses_input",
		);
	const messages = normalized.messages;

	const logRequests = !!cfg.log_requests;
	const prepareStart = logRequests ? nowMs() : 0;
	const prepared = await prepareOpenAICompletion(
		cfg,
		provider,
		req,
		messages,
		req.tools,
		{ emptyPromptMessage: "empty input" },
	);
	if ("error" in prepared) {
		await provider.dispose?.();
		if (logRequests)
			logStage(cfg, "openai_responses_prepare", {
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
		toolPolicy,
		tools: filteredTools,
		promptToolChoice,
		prompt,
		fileRefs,
		promptTokens,
		contextFiles,
	} = prepared;
	if (logRequests) {
		logStage(cfg, "openai_responses_prepare", {
			ms: elapsedMs(prepareStart),
			status: 200,
			model: rm.name,
			promptChars: prompt.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
			contextFiles: !!contextFiles,
			contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
			rawTools: allTools.length,
			filteredTools: Array.isArray(filteredTools) ? filteredTools.length : 0,
		});
	}
	const tools = filteredTools;

	if (req.stream && structured) {
		return openAIErrorResponse(
			"response_format with stream is not supported by this worker because final JSON cannot be validated while streaming",
			400,
			"unsupported_response_format_stream",
		);
	}

	if (req.stream) {
		const rid = `resp_${randHex(16)}`;
		let streamTools: unknown[] | null = null;
		if (tools && promptToolChoice !== "none") streamTools = tools;
		else if (promptToolChoice === "none") streamTools = allTools;
		return sseResponse(
			async (write, signal) => {
				const generationStart = logRequests ? nowMs() : 0;
				await streamResponsesWithToolSieve(write, cfg, {
					provider,
					rid,
					rm,
					prompt,
					fileRefs,
					tools: streamTools,
					toolPolicy,
					promptTokens,
					signal,
				});
				if (logRequests)
					logStage(cfg, "openai_responses_stream_generate", {
						ms: elapsedMs(generationStart),
						model: rm.name,
						promptTokens,
						fileRefs: fileRefs ? fileRefs.length : 0,
						tools: Array.isArray(streamTools) ? streamTools.length : 0,
					});
			},
			{
				onError: (write, e) =>
					writeResponsesEvent(write, "response.failed", {
						response: {
							id: rid,
							object: "response",
							status: "failed",
							model: rm.name,
							output: [],
							error: {
								message: upstreamErrorMessage(e),
								code: upstreamErrorCode(e) || "stream_error",
								...(upstreamErrorReason(e)
									? { reason: upstreamErrorReason(e) }
									: {}),
							},
						},
					}),
			},
		);
	}

	let text: string;
	const generationStart = logRequests ? nowMs() : 0;
	try {
		text = await provider.generateText({ prompt, rm, fileRefs });
	} catch (e) {
		if (logRequests)
			logStage(cfg, "openai_responses_generate", {
				ms: elapsedMs(generationStart),
				status: "error",
				model: rm.name,
			});
		log(
			cfg,
			`openai responses generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return openAIUpstreamErrorResponse(e);
	}
	if (logRequests)
		logStage(cfg, "openai_responses_generate", {
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

	const rid = `resp_${randHex(16)}`;
	const mid = `msg_${randHex(12)}`;
	if (!text && !toolCalls) {
		log(cfg, `openai responses generate produced no content model=${rm.name}`);
		return openAIErrorResponse(EMPTY_UPSTREAM_MSG, 502, "upstream_empty");
	}
	const output = buildResponsesOutput(text, toolCalls, mid);

	const usage = openAIResponsesUsage(promptTokens, text);

	const payload: Record<string, unknown> = {
		id: rid,
		object: "response",
		created_at: nowSec(),
		status: "completed",
		model: rm.name,
		output,
		usage,
	};
	return jsonResponse(payload);
}

async function handleImageGenerationResponses(
	req: Record<string, unknown>,
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
		"responses",
		forced,
	);
	if ("error" in prepared) {
		await provider.dispose?.();
		if (logRequests)
			logStage(cfg, "openai_responses_image_prepare", {
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
		logStage(cfg, "openai_responses_image_prepare", {
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
			logStage(cfg, "openai_responses_image_generate", {
				ms: elapsedMs(generationStart),
				status: "error",
				model: rm.name,
			});
		log(
			cfg,
			`openai responses image generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
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
		logStage(cfg, "openai_responses_image_generate", {
			ms: elapsedMs(generationStart),
			status: "ok",
			model: rm.name,
			completionChars: rich.text.length,
			images: rich.images.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});
	}

	const rid = `resp_${randHex(16)}`;
	const mid = `msg_${randHex(12)}`;
	const output = buildImageResponsesOutput(
		rich.text,
		rich.images,
		mid,
		() => `ig_${randHex(12)}`,
	);
	return jsonResponse({
		id: rid,
		object: "response",
		created_at: nowSec(),
		status: "completed",
		model: rm.name,
		output,
		usage: openAIResponsesUsage(promptTokens, rich.text),
	});
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
