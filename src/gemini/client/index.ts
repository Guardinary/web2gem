import { getPageTokens } from "../uploads/index";
import { httpFetch } from "../transport";
import { abortError, isAbortError, throwIfAborted } from "../../shared/abort";
import { log } from "../../shared/logging";
import { uuid } from "../../shared/crypto";
import {
	dataAnalysisEmptyResponseError,
	invalidGeminiCookieError,
	isDataAnalysisEmptyResponseError,
	isInvalidGeminiCookieError,
	isLargePromptEmptyResponseError,
	largePromptEmptyResponseError,
	largePromptEmptyResponseThreshold,
	upstreamImageGenerationEmptyError,
	upstreamImageProviderError,
	upstreamEmptyResponseError,
	unverifiedGeminiCookieError,
} from "./errors";
import { buildHeaders, buildPayload, getUrl } from "./protocol";
import {
	createStreamTextExtractor,
	extractResponseParts,
	extractResponseText,
	richResponseShapeSummary,
	wrbResponseShapeSummary,
} from "./parser";
import { hydrateGeneratedImages } from "./generated-images";
import type { GeminiRichImage } from "./generated-images";
import {
	configWithCachedGeminiBuildLabel,
	refreshGeminiBuildLabelForRetry,
	waitBeforeRetry,
} from "./retry";
import {
	configWithFreshGeminiCookie,
	rotateGeminiCookieForRetryWithReason,
} from "../cookies";
import type { RuntimeConfig } from "../../config";
import type { ErrorWithMetadata } from "../../shared/types";

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

export {
	cleanText,
	extractResponseParts,
	extractResponseText,
	extractTextsFromLine,
	richResponseShapeSummary,
	wrbResponseShapeSummary,
} from "./parser";
export { buildHeaders, buildPayload, getUrl } from "./protocol";
export { getFreshGeminiBuildLabel } from "./retry";

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
	return httpFetch(url, {
		method: "POST",
		headers,
		body: requestBody,
		timeoutMs: cfg.request_timeout_sec * 1000,
		socket: cfg.upstream_socket,
		socketFallback: "never",
		signal,
		cfg,
	});
}

export async function generate(
	cfg: RuntimeConfig,
	prompt: string,
	modelId: number,
	thinkMode: number,
	extra: Record<number, unknown> | null,
	fileRefs: GeminiFileRef[] | null | undefined,
	modelHeaders: Record<string, string> | null = null,
): Promise<string> {
	let lastErr: unknown;
	let activeCfg = await configWithCachedGeminiBuildLabel(
		await configWithFreshGeminiCookie(cfg),
	);
	let refreshedBL = false;
	let refreshedCookie = false;
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		prompt,
		modelId,
		thinkMode,
		fileRefs || null,
		extra,
		requestId,
	);
	for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
		try {
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				activeCfg,
				body,
				undefined,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) throw cookieErr;
			const raw = await resp.text();
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
				const refreshedCfg = await refreshGeminiBuildLabelForRetry(
					cfg,
					activeCfg,
					refreshedBL,
					"",
				);
				if (refreshedCfg) {
					refreshedBL = true;
					activeCfg = refreshedCfg;
					continue;
				}
				throw upstreamEmptyResponseError(resp.status, raw.length, "non-stream");
			}
			return text;
		} catch (e) {
			if (isInvalidGeminiCookieError(e) && !refreshedCookie) {
				const rotated = await rotateGeminiCookieForRetryWithReason(activeCfg);
				if (rotated.config) {
					refreshedCookie = true;
					activeCfg = await configWithCachedGeminiBuildLabel(rotated.config);
					continue;
				}
				throw invalidCookieErrorWithRotationReason(cfg, e, rotated.reason);
			}
			if (isInvalidGeminiCookieError(e) && refreshedCookie)
				throw invalidCookieErrorWithRotationReason(cfg, e, "rotation_updated");
			if (
				isLargePromptEmptyResponseError(e) ||
				isDataAnalysisEmptyResponseError(e) ||
				isInvalidGeminiCookieError(e)
			)
				throw e;
			lastErr = e;
			await waitBeforeRetry(cfg, attempt, e, "Retry");
		}
	}
	throw lastErr;
}

export async function generateRich(
	cfg: RuntimeConfig,
	prompt: string,
	modelId: number,
	thinkMode: number,
	extra: Record<number, unknown> | null,
	fileRefs: GeminiFileRef[] | null | undefined,
	modelHeaders: Record<string, string> | null = null,
	options: GeminiRichOptions = {},
): Promise<GeminiRichOutput> {
	let lastErr: unknown;
	let activeCfg = await configWithCachedGeminiBuildLabel(
		await configWithFreshGeminiCookie(cfg),
	);
	let refreshedBL = false;
	let refreshedCookie = false;
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		prompt,
		modelId,
		thinkMode,
		fileRefs || null,
		extra,
		requestId,
	);
	for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
		try {
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				activeCfg,
				body,
				undefined,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) throw cookieErr;
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
				const refreshedCfg = await refreshGeminiBuildLabelForRetry(
					cfg,
					activeCfg,
					refreshedBL,
					"",
				);
				if (refreshedCfg) {
					refreshedBL = true;
					activeCfg = refreshedCfg;
					continue;
				}
				throw upstreamImageGenerationEmptyError(
					resp.status,
					raw.length,
					"non-stream",
				);
			}
			const images =
				options.hydrateGeneratedImageBytes === false
					? parts.images
					: await hydrateGeneratedImages(cfg, activeCfg, parts.images);
			return { text: parts.text, images };
		} catch (e) {
			if (isInvalidGeminiCookieError(e) && !refreshedCookie) {
				const rotated = await rotateGeminiCookieForRetryWithReason(activeCfg);
				if (rotated.config) {
					refreshedCookie = true;
					activeCfg = await configWithCachedGeminiBuildLabel(rotated.config);
					continue;
				}
				throw invalidCookieErrorWithRotationReason(cfg, e, rotated.reason);
			}
			if (isInvalidGeminiCookieError(e) && refreshedCookie)
				throw invalidCookieErrorWithRotationReason(cfg, e, "rotation_updated");
			if (
				isLargePromptEmptyResponseError(e) ||
				isDataAnalysisEmptyResponseError(e) ||
				isInvalidGeminiCookieError(e)
			)
				throw e;
			lastErr = e;
			await waitBeforeRetry(cfg, attempt, e, "Rich retry");
		}
	}
	throw lastErr;
}

export async function* generateStream(
	cfg: RuntimeConfig,
	prompt: string,
	modelId: number,
	thinkMode: number,
	extra: Record<number, unknown> | null,
	fileRefs: GeminiFileRef[] | null | undefined,
	options: GeminiStreamOptions = {},
	modelHeaders: Record<string, string> | null = null,
): AsyncIterable<string> {
	let lastErr: unknown;
	let yielded = false;
	let activeCfg = await configWithCachedGeminiBuildLabel(
		await configWithFreshGeminiCookie(cfg),
	);
	let refreshedBL = false;
	let refreshedCookie = false;
	const requestId = uuid().toUpperCase();
	const body = buildPayload(
		prompt,
		modelId,
		thinkMode,
		fileRefs || null,
		extra,
		requestId,
	);
	const signal = options?.signal;

	for (let attempt = 0; attempt < cfg.retry_attempts; attempt++) {
		try {
			throwIfAborted(signal);
			const resp = await fetchGeminiStreamGenerate(
				cfg,
				activeCfg,
				body,
				signal,
				modelHeaders,
				requestId,
			);
			const cookieErr = invalidGeminiCookieError(cfg, resp.status);
			if (cookieErr) throw cookieErr;
			if (!resp.body) {
				const raw = await resp.text();
				const text = extractResponseText(raw);
				if (text) {
					yielded = true;
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
					const refreshedCfg = await refreshGeminiBuildLabelForRetry(
						cfg,
						activeCfg,
						refreshedBL,
						"stream without body",
					);
					if (refreshedCfg) {
						refreshedBL = true;
						activeCfg = refreshedCfg;
						continue;
					}
					throw upstreamEmptyResponseError(
						resp.status,
						raw.length,
						"stream without body",
					);
				}
				return;
			}
			const reader = resp.body.getReader();
			const decoder = new TextDecoder();
			const extractor = createStreamTextExtractor();
			const lineChunks: string[] = [];
			let lineLength = 0;
			let rawSnippet = "";
			let rawLength = 0;
			const takeLine = (piece: string): string => {
				if (!lineChunks.length) return piece;
				if (piece) {
					lineChunks.push(piece);
					lineLength += piece.length;
				}
				const line = lineChunks.join("");
				lineChunks.length = 0;
				lineLength = 0;
				return line;
			};
			const appendLineRemainder = (piece: string): void => {
				if (!piece) return;
				lineChunks.push(piece);
				lineLength += piece.length;
			};
			const consumeDecoded = function* (decoded: string): Generator<string> {
				let lineStart = 0;
				let idx = decoded.indexOf("\n", lineStart);
				while (idx >= 0) {
					const line = takeLine(decoded.slice(lineStart, idx));
					for (const delta of extractor.consumeLine(line)) yield delta;
					lineStart = idx + 1;
					idx = decoded.indexOf("\n", lineStart);
				}
				if (lineStart < decoded.length)
					appendLineRemainder(decoded.slice(lineStart));
			};
			while (true) {
				throwIfAborted(signal);
				const { done, value } = await reader.read();
				if (done) break;
				const decoded = decoder.decode(value, { stream: true });
				rawLength += decoded.length;
				if (rawSnippet.length < 500)
					rawSnippet += decoded.slice(0, 500 - rawSnippet.length);
				for (const delta of consumeDecoded(decoded)) {
					yielded = true;
					yield delta;
				}
			}
			const tail = decoder.decode();
			if (tail) {
				rawLength += tail.length;
				if (rawSnippet.length < 500)
					rawSnippet += tail.slice(0, 500 - rawSnippet.length);
				for (const delta of consumeDecoded(tail)) {
					yielded = true;
					yield delta;
				}
			}
			if (lineLength > 0) {
				for (const delta of extractor.consumeLine(takeLine(""))) {
					yielded = true;
					yield delta;
				}
			}
			if (!yielded) {
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
				const refreshedCfg = await refreshGeminiBuildLabelForRetry(
					cfg,
					activeCfg,
					refreshedBL,
					"stream",
				);
				if (refreshedCfg) {
					refreshedBL = true;
					activeCfg = refreshedCfg;
					continue;
				}
				throw upstreamEmptyResponseError(resp.status, rawLength, "stream");
			}
			return;
		} catch (e) {
			if (isAbortError(e) || signal?.aborted) throw abortError(signal);
			if (isInvalidGeminiCookieError(e) && !yielded && !refreshedCookie) {
				const rotated = await rotateGeminiCookieForRetryWithReason(activeCfg);
				if (rotated.config) {
					refreshedCookie = true;
					activeCfg = await configWithCachedGeminiBuildLabel(rotated.config);
					continue;
				}
				throw invalidCookieErrorWithRotationReason(cfg, e, rotated.reason);
			}
			if (isInvalidGeminiCookieError(e) && !yielded && refreshedCookie)
				throw invalidCookieErrorWithRotationReason(cfg, e, "rotation_updated");
			if (
				isLargePromptEmptyResponseError(e) ||
				isDataAnalysisEmptyResponseError(e) ||
				isInvalidGeminiCookieError(e)
			)
				throw e;
			lastErr = e;
			if (
				!yielded &&
				(await waitBeforeRetry(cfg, attempt, e, "Stream retry", signal))
			) {
				continue;
			}
			throw e;
		}
	}
	if (lastErr) throw lastErr;
}

function invalidCookieErrorWithRotationReason(
	cfg: RuntimeConfig,
	err: unknown,
	reason: unknown,
): unknown {
	const meta =
		err && typeof err === "object" ? (err as Partial<ErrorWithMetadata>) : {};
	return (
		invalidGeminiCookieError(
			cfg,
			meta.upstreamStatus || meta.status || 401,
			typeof meta.rawLength === "number" ? meta.rawLength : null,
			reason,
		) || err
	);
}
