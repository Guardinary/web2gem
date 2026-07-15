import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG } from "../../completion";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import { prepareGoogleCompletion } from "../../completion/google-request";
import { finalizeGoogleCompletionResult } from "../../completion/google-turn";
import { upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import { tokenEst } from "../../shared/tokens";
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
	return runPreparedCompletion({
		cfg,
		provider,
		stage: "google",
		protocol: GOOGLE_GENERATION_PROTOCOL,
		prepare: () => prepareGoogleCompletion(cfg, provider, req, modelName),
		prepareLogFields: (prepared) => ({
			model: prepared.rm.name,
			stream,
			tools: prepared.hasTools,
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
	prepared: PreparedOk<Awaited<ReturnType<typeof prepareGoogleCompletion>>>,
	stream: boolean,
	stageLog: StageLog,
): Promise<Response> {
	const {
		rm,
		effectiveReq,
		effectiveGoogleTools,
		hasTools,
		prompt,
		fileRefs,
		promptTokens,
	} = prepared;

	if (stream && !hasTools) {
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

	if (stream && hasTools) {
		return sseResponse(
			async (write, signal) => {
				const generationStart = stageLog.now();
				await streamGoogleTools(write, cfg, {
					provider,
					prompt,
					rm,
					fileRefs,
					tools: effectiveGoogleTools,
					effectiveReq,
					promptTokens,
					signal,
				});
				stageLog.log("google_stream_generate", generationStart, {
					model: rm.name,
					promptTokens,
					fileRefs: fileRefs ? fileRefs.length : 0,
					tools: effectiveGoogleTools ? effectiveGoogleTools.length : 0,
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
	const upstreamEmpty = !text;
	if (upstreamEmpty) {
		log(cfg, `google generate produced no content model=${rm.name}`);
		return jsonResponse(
			googleErrorResponseBody(EMPTY_UPSTREAM_MSG, "upstream_empty"),
			502,
		);
	}

	const finalized = finalizeGoogleCompletionResult(text, {
		effectiveReq,
		effectiveGoogleTools,
		hasTools,
	});
	if (finalized.error)
		return jsonResponse(
			googleErrorResponseBody(finalized.error.message, finalized.error.code),
			finalized.error.status,
		);

	const candidateTokens = tokenEst(text);
	const responseObj = googleGenerateContentResponse({
		model: rm.name,
		responseParts: finalized.responseParts,
		promptTokens,
		candidateTokens,
		upstreamEmpty,
	});

	return jsonResponse(responseObj);
}
