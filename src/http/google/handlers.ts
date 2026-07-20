import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import {
	GOOGLE_COMPLETION_DIALECT,
	prepareCompletion,
} from "../../completion/prepare";
import { finalizeGoogleCompletionResult } from "../../completion/turn";
import { parseGoogleRequest } from "../../promptcompat/google";
import { upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import { tokenEst } from "../../promptcompat/token-accounting";
import type { UnknownRecord } from "../../shared/types";
import {
	generateTextLogged,
	type PreparedOk,
	runPreparedCompletion,
	type StageLog,
} from "../generation";
import {
	GOOGLE_GENERATION_PROTOCOL,
	googleErrorResponseBody,
	googleGenerateContentResponse,
	writeGoogleStreamError,
} from "./format";
import { streamGooglePlain, streamGoogleTools } from "./stream";
import type { GoogleGenerationRoute } from "./model-path";

export async function handleGoogleGenerate(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	route: GoogleGenerationRoute,
) {
	const { modelName, stream } = route;
	const messages = parseGoogleRequest(req);
	return runPreparedCompletion({
		cfg,
		provider,
		stage: "google",
		protocol: GOOGLE_GENERATION_PROTOCOL,
		prepare: () =>
			prepareCompletion(
				cfg,
				provider,
				req,
				messages,
				modelName,
				GOOGLE_COMPLETION_DIALECT,
			),
		prepareLogFields: (prepared) => ({
			model: prepared.rm.name,
			stream,
			tools: !!prepared.tools && prepared.promptToolChoice !== "none",
			promptChars: prepared.prompt.length,
			promptTokens: prepared.promptTokens,
			fileRefs: prepared.fileRefs ? prepared.fileRefs.length : 0,
			contextFiles: !!prepared.contextFiles,
			contextRefs: prepared.contextFiles
				? prepared.contextFiles.fileRefs.length
				: 0,
		}),
		run: (prepared, stageLog) =>
			runGoogleGeneration(cfg, provider, prepared, stream, stageLog),
	});
}

async function runGoogleGeneration(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	prepared: PreparedOk<Awaited<ReturnType<typeof prepareCompletion>>>,
	stream: boolean,
	stageLog: StageLog,
): Promise<Response> {
	const {
		rm,
		tools,
		streamMode,
		toolPolicy,
		promptToolChoice,
		prompt,
		fileRefs,
		promptTokens,
	} = prepared;
	const hasTools = !!tools && promptToolChoice !== "none";

	if (stream && streamMode.type === "plain") {
		return sseResponse(
			async (write, signal) => {
				const generationStart = stageLog.now();
				await streamGooglePlain(write, cfg, {
					provider,
					prompt,
					rm,
					fileRefs,
					promptTokens,
					signal,
				});
				stageLog.log("google_stream_generate", generationStart, {
					model: rm.name,
					promptTokens,
					fileRefs: fileRefs ? fileRefs.length : 0,
				});
			},
			{ onError: (write, e) => writeGoogleStreamError(write, rm.name, e) },
		);
	}

	if (stream && streamMode.type === "tool_sieve") {
		const streamTools = streamMode.tools;
		return sseResponse(
			async (write, signal) => {
				const generationStart = stageLog.now();
				await streamGoogleTools(write, cfg, {
					provider,
					prompt,
					rm,
					fileRefs,
					tools: streamTools,
					toolPolicy,
					promptTokens,
					signal,
				});
				stageLog.log("google_stream_generate", generationStart, {
					model: rm.name,
					promptTokens,
					fileRefs: fileRefs ? fileRefs.length : 0,
					tools: tools ? tools.openAIFunctionTools.length : 0,
				});
			},
			{ onError: (write, e) => writeGoogleStreamError(write, rm.name, e) },
		);
	}

	const generated = await generateTextLogged({
		cfg,
		provider,
		stage: "google",
		logLabel: "google",
		protocol: GOOGLE_GENERATION_PROTOCOL,
		stageLog,
		input: { prompt, rm, fileRefs },
		errorLogFields: (e) => ({
			code: upstreamErrorCode(e) || "upstream_error",
		}),
		okLogFields: (out) => ({
			completionChars: out.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		}),
	});
	if (generated.response) return generated.response;
	const text = generated.text;

	const finalized = finalizeGoogleCompletionResult(text, {
		tools: streamMode.type === "tool_sieve" ? streamMode.tools : tools,
		toolPolicy,
		hasTools,
	});
	if (finalized.error) {
		if (finalized.error.code === "upstream_empty")
			log(cfg, `google generate produced no content model=${rm.name}`);
		return jsonResponse(
			googleErrorResponseBody(finalized.error.message, finalized.error.code),
			finalized.error.status,
		);
	}

	const candidateTokens = tokenEst(text);
	const responseObj = googleGenerateContentResponse({
		model: rm.name,
		responseParts: finalized.responseParts,
		promptTokens,
		candidateTokens,
	});

	return jsonResponse(responseObj);
}
