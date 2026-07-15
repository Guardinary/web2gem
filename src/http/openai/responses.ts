import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG } from "../../completion";
import type { CompletionProvider } from "../../completion";
import { prepareOpenAICompletion } from "../../completion/openai";
import { normalizeResponsesInputAsMessagesStrict } from "../../promptcompat/responses-input";
import { log, nowSec } from "../../shared/logging";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";
import { randHex } from "../../shared/crypto";
import {
	generateTextLogged,
	type PreparedOk,
	runPreparedCompletion,
	type StageLog,
} from "../generation";
import { OPENAI_GENERATION_PROTOCOL, openAIErrorResponse } from "./errors";
import {
	buildImageResponsesOutput,
	buildResponsesOutput,
	finalizeOpenAICompletionResult,
	openAIResponsesUsage,
} from "./format";
import {
	imageGenerationMode,
	runImageGenerationCompletion,
} from "./image-generation";
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

	return runPreparedCompletion({
		cfg,
		provider,
		stage: "openai_responses",
		protocol: OPENAI_GENERATION_PROTOCOL,
		prepare: () =>
			prepareOpenAICompletion(cfg, provider, req, messages, req.tools, {
				emptyPromptMessage: "empty input",
			}),
		prepareLogFields: (prepared) => ({
			model: prepared.rm.name,
			promptChars: prepared.prompt.length,
			promptTokens: prepared.promptTokens,
			fileRefs: prepared.fileRefs ? prepared.fileRefs.length : 0,
			contextFiles: !!prepared.contextFiles,
			contextRefs: prepared.contextFiles
				? prepared.contextFiles.fileRefs.length
				: 0,
			rawTools: prepared.allTools.length,
			filteredTools: Array.isArray(prepared.tools) ? prepared.tools.length : 0,
		}),
		run: (prepared, stageLog) =>
			runResponsesGeneration(req, cfg, provider, prepared, stageLog),
	});
}

async function runResponsesGeneration(
	req: Record<string, unknown>,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	prepared: PreparedOk<Awaited<ReturnType<typeof prepareOpenAICompletion>>>,
	stageLog: StageLog,
): Promise<Response> {
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
	} = prepared;
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
				const generationStart = stageLog.now();
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
				stageLog.log("openai_responses_stream_generate", generationStart, {
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

	const generated = await generateTextLogged({
		cfg,
		provider,
		stage: "openai_responses",
		logLabel: "openai responses",
		protocol: OPENAI_GENERATION_PROTOCOL,
		stageLog,
		input: { prompt, rm, fileRefs },
		okLogFields: (out) => ({
			completionChars: out.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		}),
	});
	if (generated.response) return generated.response;
	let text = generated.text;

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
	return runImageGenerationCompletion({
		req,
		cfg,
		provider,
		route: "responses",
		forced,
		stage: "openai_responses_image",
		logLabel: "openai responses image",
		format: (rich, promptTokens, rm) => {
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
		},
	});
}

// POST /v1beta/models/{model}:generateContent | :streamGenerateContent
