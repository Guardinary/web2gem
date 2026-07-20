import type { RuntimeConfig } from "../../config";
import { throwIfAborted } from "../../shared/abort";
import { uuid } from "../../shared/crypto";
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
import { buildHeaders, buildPayload, getUrl } from "./protocol";
import { createSameAccountAttemptState } from "./same-account-attempt";
import { consumeGeminiWrbStream } from "./stream-consumer";

type GeminiFileRef =
	| string
	| {
			ref?: unknown;
			fileRef?: unknown;
			id?: unknown;
			name?: unknown;
			filename?: unknown;
	  };

type GeminiStreamOptions = {
	signal?: AbortSignal;
};

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
	const attemptState = await createSameAccountAttemptState(cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		prompt,
		modelNumber,
		extended,
		fileRefs || null,
		requestId,
	);
	for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
		try {
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
				const dataAnalysisErr = dataAnalysisEmptyResponseError(raw, fileRefs);
				if (dataAnalysisErr) throw dataAnalysisErr;
				const largePromptErr = largePromptEmptyResponseError(
					prompt,
					resp.status,
					raw.length,
					largePromptEmptyResponseThreshold(cfg),
				);
				if (largePromptErr) throw largePromptErr;
				if (await attemptState.tryRefreshBuildLabel("")) continue;
				throw upstreamEmptyResponseError(resp.status, raw.length, "non-stream");
			}
			return text;
		} catch (e) {
			if (await attemptState.recoverFromError(e, { attempt, label: "Retry" }))
				continue;
			throw e;
		}
	}
	throw attemptState.lastError;
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
	const attemptState = await createSameAccountAttemptState(cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		prompt,
		modelNumber,
		extended,
		fileRefs || null,
		requestId,
	);
	for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
		try {
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
				const dataAnalysisErr = dataAnalysisEmptyResponseError(raw, fileRefs);
				if (dataAnalysisErr) throw dataAnalysisErr;
				const largePromptErr = largePromptEmptyResponseError(
					prompt,
					resp.status,
					raw.length,
					largePromptEmptyResponseThreshold(cfg),
				);
				if (largePromptErr) throw largePromptErr;
				if (await attemptState.tryRefreshBuildLabel("")) continue;
				throw upstreamImageGenerationEmptyError(
					resp.status,
					raw.length,
					"non-stream",
				);
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
		} catch (e) {
			if (
				await attemptState.recoverFromError(e, {
					attempt,
					label: "Rich retry",
				})
			)
				continue;
			throw e;
		}
	}
	throw attemptState.lastError;
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
	const attemptState = await createSameAccountAttemptState(cfg);
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		prompt,
		modelNumber,
		extended,
		fileRefs || null,
		requestId,
	);
	const signal = options?.signal;

	for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
		try {
			throwIfAborted(signal);
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				attemptState.activeConfig,
				body,
				signal,
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
					const dataAnalysisErr = dataAnalysisEmptyResponseError(raw, fileRefs);
					if (dataAnalysisErr) throw dataAnalysisErr;
					const largePromptErr = largePromptEmptyResponseError(
						prompt,
						resp.status,
						raw.length,
						largePromptEmptyResponseThreshold(cfg),
					);
					if (largePromptErr) throw largePromptErr;
					if (await attemptState.tryRefreshBuildLabel("stream without body"))
						continue;
					throw upstreamEmptyResponseError(
						resp.status,
						raw.length,
						"stream without body",
					);
				}
				return;
			}
			let rawSnippet = "";
			let rawLength = 0;
			for await (const event of consumeGeminiWrbStream(resp.body, signal)) {
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
				const dataAnalysisErr = dataAnalysisEmptyResponseError(
					rawSnippet,
					fileRefs,
				);
				if (dataAnalysisErr) throw dataAnalysisErr;
				const largePromptErr = largePromptEmptyResponseError(
					prompt,
					resp.status,
					null,
					largePromptEmptyResponseThreshold(cfg),
				);
				if (largePromptErr) throw largePromptErr;
				if (await attemptState.tryRefreshBuildLabel("stream")) continue;
				throw upstreamEmptyResponseError(resp.status, rawLength, "stream");
			}
			return;
		} catch (e) {
			if (
				await attemptState.recoverFromError(e, {
					attempt,
					label: "Stream retry",
					signal,
				})
			)
				continue;
			throw e;
		}
	}
	if (attemptState.lastError) throw attemptState.lastError;
}
