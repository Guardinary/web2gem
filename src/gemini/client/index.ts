import type { RuntimeConfig } from "../../config";
import { throwIfAborted } from "../../shared/abort";
import { log } from "../../shared/logging";
import { observeGeminiAccountResponseCookies } from "../cookies";
import { cancelResponseBody, httpFetch } from "../transport";
import { getPageTokens } from "../uploads/index";
import {
	dataAnalysisEmptyResponseError,
	geminiSemanticError,
	invalidGeminiCookieError,
	largePromptEmptyResponseError,
	largePromptEmptyResponseThreshold,
	unverifiedGeminiCookieError,
	upstreamEmptyResponseError,
	upstreamImageGenerationEmptyError,
	upstreamImageProviderError,
} from "./errors";
import type { GeminiRichImage } from "./generated-images";
import { hydrateGeneratedImages } from "./generated-images";
import {
	extractResponseFatalCode,
	extractResponseParts,
	extractResponseText,
	richResponseShapeSummary,
} from "./parse-parts";
import { wrbResponseShapeSummary } from "./parse-envelope";
import { buildHeaders, getUrl } from "./protocol";
import {
	CONTINUE_SAME_ACCOUNT_ATTEMPT,
	type GeminiFileRef,
	runSameAccountGenerateAttempts,
	runSameAccountStreamAttempts,
} from "./same-account-generate";
import { consumeGeminiWrbStream } from "./stream-consumer";

type GeminiStreamOptions = {
	signal?: AbortSignal;
};

type EmptyUpstreamDecision =
	| { kind: "throw"; error: Error }
	| { kind: "continue" };

/**
 * Shared empty-upstream resolution for generate / generateRich / generateStream.
 * Order is fixed: data-analysis → large-prompt → build-label continue → final error.
 */
async function resolveEmptyUpstream(args: {
	cfg: RuntimeConfig;
	prompt: string;
	raw: string;
	status: number;
	fileRefs: GeminiFileRef[] | null | undefined;
	rawLength: number | null;
	tryRefreshBuildLabel: (label: string) => Promise<boolean>;
	refreshLabel: string;
	finalError: (status: number, rawLen: number | null) => Error;
}): Promise<EmptyUpstreamDecision> {
	const dataAnalysisErr = dataAnalysisEmptyResponseError(
		args.raw,
		args.fileRefs,
	);
	if (dataAnalysisErr) return { kind: "throw", error: dataAnalysisErr };
	const largePromptErr = largePromptEmptyResponseError(
		args.prompt,
		args.status,
		args.rawLength,
		largePromptEmptyResponseThreshold(args.cfg),
	);
	if (largePromptErr) return { kind: "throw", error: largePromptErr };
	if (await args.tryRefreshBuildLabel(args.refreshLabel))
		return { kind: "continue" };
	return {
		kind: "throw",
		error: args.finalError(args.status, args.rawLength),
	};
}

type GeminiRichOptions = {
	hydrateGeneratedImageBytes?: boolean;
};

export type { GeminiRichImage } from "./generated-images";

export type GeminiRichOutput = {
	text: string;
	images: GeminiRichImage[];
};

async function appendGeminiPageToken(
	cfg: RuntimeConfig,
	body: string,
): Promise<string> {
	if (!cfg.cookie) return body;
	const tokens = await getPageTokens(cfg);
	if (!tokens.at) {
		log(cfg, "gemini cookie verification failed reason=missing_page_at_token");
		throw unverifiedGeminiCookieError("missing_page_at_token");
	}
	return `${body}&at=${encodeURIComponent(tokens.at)}`;
}

async function fetchGeminiStreamGenerate(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	body: string,
	signal: AbortSignal | null | undefined = undefined,
	modelHeaders: Record<string, string> | null = null,
	requestId: string | null = null,
) {
	const url = getUrl(activeCfg);
	const headers = await buildHeaders(activeCfg, modelHeaders, requestId);
	const requestBody = await appendGeminiPageToken(activeCfg, body);
	const response = await httpFetch(url, {
		method: "POST",
		headers,
		body: requestBody,
		timeoutMs: cfg.request_timeout_sec * 1000,
		socket: cfg.upstream_socket,
		socketFallback: "never",
		signal,
		cfg,
	});
	observeGeminiAccountResponseCookies(activeCfg, response);
	return response;
}

export async function generate(
	cfg: RuntimeConfig,
	prompt: string,
	modelNumber: number,
	extended: boolean,
	fileRefs: GeminiFileRef[] | null | undefined,
	modelHeaders: Record<string, string> | null = null,
): Promise<string> {
	return runSameAccountGenerateAttempts({
		cfg,
		prompt,
		modelNumber,
		extended,
		fileRefs,
		label: "Retry",
		async execute({ attemptState, body, requestId }) {
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				attemptState.activeConfig,
				body,
				undefined,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) {
				await cancelResponseBody(resp);
				throw cookieErr;
			}
			const raw = await resp.text();
			const fatalCode = extractResponseFatalCode(raw);
			if (fatalCode) throw geminiSemanticError("stream_generate", fatalCode);
			const text = extractResponseText(raw);
			if (!resp.ok || !text) {
				const shape =
					cfg.log_requests && !text ? ` ${wrbResponseShapeSummary(raw)}` : "";
				log(
					cfg,
					`upstream status=${resp.status} rawLen=${raw.length} parsedLen=${text.length}${shape}`,
				);
			}
			if (!text) {
				const decision = await resolveEmptyUpstream({
					cfg,
					prompt,
					raw,
					status: resp.status,
					fileRefs,
					rawLength: raw.length,
					tryRefreshBuildLabel: (label) =>
						attemptState.tryRefreshBuildLabel(label),
					refreshLabel: "",
					finalError: (status, rawLen) =>
						upstreamEmptyResponseError(status, rawLen, "non-stream"),
				});
				if (decision.kind === "continue") return CONTINUE_SAME_ACCOUNT_ATTEMPT;
				throw decision.error;
			}
			return text;
		},
	});
}

export async function generateRich(
	cfg: RuntimeConfig,
	prompt: string,
	modelNumber: number,
	extended: boolean,
	fileRefs: GeminiFileRef[] | null | undefined,
	modelHeaders: Record<string, string> | null = null,
	options: GeminiRichOptions = {},
): Promise<GeminiRichOutput> {
	return runSameAccountGenerateAttempts({
		cfg,
		prompt,
		modelNumber,
		extended,
		fileRefs,
		label: "Rich retry",
		async execute({ attemptState, body, requestId }) {
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				attemptState.activeConfig,
				body,
				undefined,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) {
				await cancelResponseBody(resp);
				throw cookieErr;
			}
			const raw = await resp.text();
			const parts = extractResponseParts(raw);
			if (parts.fatalCode) throw upstreamImageProviderError(parts.fatalCode);
			if (!resp.ok || (!parts.text && !parts.images.length)) {
				const shape = cfg.log_requests
					? ` ${richResponseShapeSummary(raw)}`
					: "";
				log(
					cfg,
					`rich upstream status=${resp.status} rawLen=${raw.length} parsedTextLen=${parts.text.length} images=${parts.images.length}${shape}`,
				);
			}
			if (!parts.text && !parts.images.length) {
				const decision = await resolveEmptyUpstream({
					cfg,
					prompt,
					raw,
					status: resp.status,
					fileRefs,
					rawLength: raw.length,
					tryRefreshBuildLabel: (label) =>
						attemptState.tryRefreshBuildLabel(label),
					refreshLabel: "",
					finalError: (status, rawLen) =>
						upstreamImageGenerationEmptyError(status, rawLen, "non-stream"),
				});
				if (decision.kind === "continue") return CONTINUE_SAME_ACCOUNT_ATTEMPT;
				throw decision.error;
			}
			const images =
				options.hydrateGeneratedImageBytes === false
					? parts.images
					: await hydrateGeneratedImages(
							cfg,
							attemptState.activeConfig,
							parts.images,
						);
			return { text: parts.text, images };
		},
	});
}

export async function* generateStream(
	cfg: RuntimeConfig,
	prompt: string,
	modelNumber: number,
	extended: boolean,
	fileRefs: GeminiFileRef[] | null | undefined,
	options: GeminiStreamOptions = {},
	modelHeaders: Record<string, string> | null = null,
): AsyncIterable<string> {
	const signal = options?.signal;
	yield* runSameAccountStreamAttempts({
		cfg,
		prompt,
		modelNumber,
		extended,
		fileRefs,
		label: "Stream retry",
		signal,
		async *execute({ attemptState, body, requestId, signal: attemptSignal }) {
			throwIfAborted(attemptSignal);
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				attemptState.activeConfig,
				body,
				attemptSignal,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) {
				await cancelResponseBody(resp);
				throw cookieErr;
			}
			if (!resp.body) {
				const raw = await resp.text();
				const fatalCode = extractResponseFatalCode(raw);
				if (fatalCode) throw geminiSemanticError("stream_generate", fatalCode);
				const text = extractResponseText(raw);
				if (text) {
					attemptState.markOutputStarted();
					yield text;
				}
				if (!text) {
					const shape = cfg.log_requests
						? ` ${wrbResponseShapeSummary(raw)}`
						: "";
					log(
						cfg,
						`stream upstream produced no text without body (status=${resp.status}) rawLen=${raw.length}${shape}`,
					);
					const decision = await resolveEmptyUpstream({
						cfg,
						prompt,
						raw,
						status: resp.status,
						fileRefs,
						rawLength: raw.length,
						tryRefreshBuildLabel: (label) =>
							attemptState.tryRefreshBuildLabel(label),
						refreshLabel: "stream without body",
						finalError: (status, rawLen) =>
							upstreamEmptyResponseError(status, rawLen, "stream without body"),
					});
					if (decision.kind === "continue")
						return CONTINUE_SAME_ACCOUNT_ATTEMPT;
					throw decision.error;
				}
				return;
			}
			let rawSnippet = "";
			let rawLength = 0;
			for await (const event of consumeGeminiWrbStream(
				resp.body,
				attemptSignal,
			)) {
				if (event.type === "delta") {
					attemptState.markOutputStarted();
					yield event.text;
				} else {
					rawSnippet = event.rawSnippet;
					rawLength = event.rawLength;
				}
			}
			if (!attemptState.outputStarted) {
				const shape = cfg.log_requests
					? ` ${wrbResponseShapeSummary(rawSnippet)}`
					: "";
				log(
					cfg,
					`stream upstream produced no text (status=${resp.status}) rawLen=${rawLength}${shape}`,
				);
				const decision = await resolveEmptyUpstream({
					cfg,
					prompt,
					raw: rawSnippet,
					status: resp.status,
					fileRefs,
					rawLength: null,
					tryRefreshBuildLabel: (label) =>
						attemptState.tryRefreshBuildLabel(label),
					refreshLabel: "stream",
					finalError: (status, _rawLen) =>
						upstreamEmptyResponseError(status, rawLength, "stream"),
				});
				if (decision.kind === "continue") return CONTINUE_SAME_ACCOUNT_ATTEMPT;
				throw decision.error;
			}
			return undefined;
		},
	});
}
