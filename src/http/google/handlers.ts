import { jsonResponse } from "../core/json";
import { sseResponse } from "../core/sse";
import { EMPTY_UPSTREAM_MSG } from "../../completion";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import { prepareGoogleCompletion } from "../../completion/google-request";
import { finalizeGoogleCompletionResult } from "../../completion/google-turn";
import { elapsedMs, log, logStage, nowMs } from "../../shared/logging";
import {
	errorLogSummary,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../../shared/errors";
import { tokenEst } from "../../shared/tokens";
import type { UnknownRecord } from "../../shared/types";
import {
	googleErrorResponseBody,
	googleGenerateContentResponse,
	writeGoogleStreamError,
} from "./format";
import { streamGooglePlain, streamGoogleTools } from "./stream";

export async function handleGoogleGenerate(
	req: UnknownRecord,
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	path: string,
	stream: boolean,
) {
	const logRequests = !!cfg.log_requests;
	const prepareStart = logRequests ? nowMs() : 0;
	const prepared = await prepareGoogleCompletion(cfg, provider, req, path);
	if ("error" in prepared) {
		await provider.dispose?.();
		if (logRequests)
			logStage(cfg, "google_prepare", {
				ms: elapsedMs(prepareStart),
				status: prepared.error.status,
				code: prepared.error.code,
			});
		return jsonResponse(
			googleErrorResponseBody(
				prepared.error.message,
				prepared.error.code,
				prepared.error.reason,
			),
			prepared.error.status,
		);
	}
	const {
		rm,
		effectiveReq,
		effectiveGoogleTools,
		hasTools,
		prompt,
		fileRefs,
		promptTokens,
		contextFiles,
	} = prepared;

	if (logRequests) {
		logStage(cfg, "google_prepare", {
			ms: elapsedMs(prepareStart),
			status: 200,
			model: rm.name,
			stream,
			tools: hasTools,
			promptChars: prompt.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
			contextFiles: !!contextFiles,
			contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
		});
	}

	if (stream && !hasTools) {
		return sseResponse(
			async (write, signal) => {
				const generationStart = logRequests ? nowMs() : 0;
				await streamGooglePlain(write, cfg, {
					provider,
					prompt,
					rm,
					fileRefs,
					promptTokens,
					signal,
				});
				if (logRequests)
					logStage(cfg, "google_stream_generate", {
						ms: elapsedMs(generationStart),
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
				const generationStart = logRequests ? nowMs() : 0;
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
				if (logRequests)
					logStage(cfg, "google_stream_generate", {
						ms: elapsedMs(generationStart),
						model: rm.name,
						promptTokens,
						fileRefs: fileRefs ? fileRefs.length : 0,
						tools: effectiveGoogleTools ? effectiveGoogleTools.length : 0,
					});
			},
			{ onError: (write, e) => writeGoogleStreamError(write, rm.name, e) },
		);
	}

	let text: string;
	const generationStart = logRequests ? nowMs() : 0;
	try {
		text = await provider.generateText({ prompt, rm, fileRefs });
	} catch (e) {
		if (logRequests)
			logStage(cfg, "google_generate", {
				ms: elapsedMs(generationStart),
				status: "error",
				model: rm.name,
				code: upstreamErrorCode(e) || "upstream_error",
			});
		log(
			cfg,
			`google generate failed model=${rm.name} code=${upstreamErrorCode(e) || "upstream_error"} error=${errorLogSummary(e)}`,
		);
		return jsonResponse(
			googleErrorResponseBody(
				`upstream error: ${upstreamErrorMessage(e)}`,
				upstreamErrorCode(e) || "upstream_error",
				upstreamErrorReason(e),
			),
			upstreamErrorStatus(e) || 502,
		);
	}
	if (logRequests)
		logStage(cfg, "google_generate", {
			ms: elapsedMs(generationStart),
			status: "ok",
			model: rm.name,
			completionChars: text.length,
			promptTokens,
			fileRefs: fileRefs ? fileRefs.length : 0,
		});
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
