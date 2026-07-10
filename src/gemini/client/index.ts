import { getPageTokens } from "../uploads/index";
import { httpFetch } from "../transport";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import {
	abortError,
	errorLogSummary,
	isAbortError,
	log,
	throwIfAborted,
	uuid,
} from "../../shared/runtime";
import {
	dataAnalysisEmptyResponseError,
	invalidGeminiCookieError,
	isDataAnalysisEmptyResponseError,
	isInvalidGeminiCookieError,
	isLargePromptEmptyResponseError,
	largePromptEmptyResponseError,
	largePromptEmptyResponseThreshold,
	upstreamImageFetchFailedError,
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
import type { GeminiParsedImage } from "./parser";
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

export type GeminiRichImage = GeminiParsedImage & {
	base64?: string;
	outputFormat?: "png" | "jpeg" | "gif" | "webp";
};

export type GeminiRichOutput = {
	text: string;
	images: GeminiRichImage[];
};

type FetchedImageBytes = {
	base64: string;
	outputFormat: "png" | "jpeg" | "gif" | "webp";
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

async function hydrateGeneratedImages(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	images: GeminiParsedImage[],
): Promise<GeminiRichImage[]> {
	const out: GeminiRichImage[] = [];
	for (const image of images) {
		if (image.source !== "generated") {
			out.push(image);
			continue;
		}
		try {
			const fetched = await fetchGeneratedImageBytes(cfg, activeCfg, image);
			out.push({ ...image, ...fetched });
		} catch (e) {
			log(
				cfg,
				`generated image fetch failed; returning source url only ${errorLogSummary(e)}`,
			);
			out.push(image);
		}
	}
	return out;
}

async function fetchGeneratedImageBytes(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	image: GeminiParsedImage,
): Promise<FetchedImageBytes> {
	const headers = generatedImageFetchHeaders(activeCfg);
	let lastErr: unknown = null;
	for (const target of generatedImagePreviewFetchUrls(image.url)) {
		try {
			return await fetchGeneratedImageBytesFromUrl(cfg, target, headers);
		} catch (e) {
			lastErr = e;
		}
	}
	if (lastErr) throw lastErr;
	throw upstreamImageFetchFailedError("no generated image URL candidates");
}

async function fetchGeneratedImageBytesFromUrl(
	cfg: RuntimeConfig,
	target: string,
	headers: Record<string, string>,
): Promise<FetchedImageBytes> {
	try {
		const resp = await httpFetch(target, {
			method: "GET",
			headers,
			timeoutMs: cfg.request_timeout_sec * 1000,
			socket: false,
			cfg,
		});
		const bytes = await responseBytes(resp);
		if (!resp.ok)
			throw upstreamImageFetchFailedError(
				`upstream HTTP ${resp.status}`,
				resp.status,
			);
		const format = imageFormatFromBytes(bytes);
		if (!format)
			throw upstreamImageFetchFailedError(
				"response body is not a supported image",
				resp.status,
			);
		return {
			base64: bytesToBase64(bytes),
			outputFormat: format,
		};
	} catch (e) {
		throw upstreamImageFetchFailedError(e);
	}
}

function generatedImagePreviewFetchUrls(url: string): string[] {
	const upgraded = generatedImageFetchUpsizedUrl(url);
	if (!upgraded || upgraded === url) return [url];
	if (url.includes("=s1024-rj")) return [upgraded, url];
	return [url, upgraded];
}

function generatedImageFetchUpsizedUrl(url: string): string {
	if (url.includes("=s1024-rj")) return url.replace("=s1024-rj", "=s2048-rj");
	if (/=s\d+-rj(?:$|[&#])/.test(url)) return url;
	return `${url}${url.includes("=") ? "" : "=s2048-rj"}`;
}

function generatedImageFetchHeaders(
	cfg: RuntimeConfig,
): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.9",
		Origin: "https://gemini.google.com",
		Referer: "https://gemini.google.com/app",
		"User-Agent": GEMINI_WEB_USER_AGENT,
	};
	if (cfg.cookie) headers.Cookie = cfg.cookie;
	return headers;
}

async function responseBytes(
	resp:
		| Response
		| { body: ReadableStream<Uint8Array>; arrayBuffer?: undefined },
): Promise<Uint8Array> {
	if ("bytes" in resp && typeof resp.bytes === "function") {
		return resp.bytes();
	}
	if (!resp.body) return new Uint8Array(0);
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		chunks.push(value);
		total += value.byteLength;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

function imageFormatFromBytes(
	bytes: Uint8Array,
): "png" | "jpeg" | "gif" | "webp" | "" {
	if (
		bytes.byteLength >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return "png";
	if (
		bytes.byteLength >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	)
		return "jpeg";
	if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "gif";
	if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "webp";
	return "";
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
	if (offset + text.length > bytes.byteLength) return false;
	for (let i = 0; i < text.length; i++) {
		if (bytes[offset + i] !== text.charCodeAt(i)) return false;
	}
	return true;
}

function bytesToBase64(bytes: Uint8Array): string {
	const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
	if (typeof native === "function") return native.call(bytes);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
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
