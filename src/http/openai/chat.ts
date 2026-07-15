import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG } from "../../completion";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import { prepareOpenAICompletion } from "../../completion/openai";
import { log, nowSec } from "../../shared/logging";
import { randHex } from "../../shared/crypto";
import { tokenEst } from "../../shared/tokens";
import { isRecord, type UnknownRecord } from "../../shared/types";
import { OPENAI_GENERATION_PROTOCOL, openAIErrorResponse } from "./errors";
import {
	generateTextLogged,
	type PreparedOk,
	runPreparedCompletion,
	type StageLog,
} from "../generation";
import {
	finalizeOpenAICompletionResult,
	imageGenerationChatContent,
	openAIChatUsageFromCompletionTokens,
} from "./format";
import { writeOpenAIChatStreamError } from "./format";
import {
	imageGenerationMode,
	runImageGenerationCompletion,
} from "./image-generation";
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
	return runPreparedCompletion({
		cfg,
		provider,
		stage: "openai_chat",
		protocol: OPENAI_GENERATION_PROTOCOL,
		prepare: () =>
			prepareOpenAICompletion(cfg, provider, req, messages, req.tools, {
				emptyPromptMessage: "empty prompt",
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
		}),
		run: (prepared, stageLog) =>
			runChatGeneration(req, cfg, provider, prepared, stageLog),
	});
}

async function runChatGeneration(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	prepared: PreparedOk<Awaited<ReturnType<typeof prepareOpenAICompletion>>>,
	stageLog: StageLog,
): Promise<Response> {
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
	} = prepared;

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
				const generationStart = stageLog.now();
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
				stageLog.log("openai_chat_stream_generate", generationStart, {
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
				const generationStart = stageLog.now();
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
				stageLog.log("openai_chat_stream_generate", generationStart, {
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

	const generated = await generateTextLogged({
		cfg,
		provider,
		stage: "openai_chat",
		logLabel: "openai chat",
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
	return runImageGenerationCompletion({
		req,
		cfg,
		provider,
		route: "chat",
		forced,
		stage: "openai_chat_image",
		logLabel: "openai chat image",
		format: (rich, promptTokens, rm) => {
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
				usage: openAIChatUsageFromCompletionTokens(
					promptTokens,
					completionTokens,
				),
			});
		},
	});
}
