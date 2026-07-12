import { bytesToBase64 } from "../../attachments/base64";
import { detectUploadMimeFromBytes } from "../../attachments/mime";
import type { RuntimeConfig } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { GEMINI_WEB_USER_AGENT } from "../constants";
import { httpFetch } from "../transport";
import { upstreamImageFetchFailedError } from "./errors";
import type { GeminiParsedImage } from "./parser";

export type GeminiImageOutputFormat = "png" | "jpeg" | "gif" | "webp";

export type GeminiRichImage = GeminiParsedImage & {
	base64?: string;
	outputFormat?: GeminiImageOutputFormat;
};

export type GeneratedImageHydrationLimits = {
	maxImageBytes: number;
	maxTotalBytes: number;
};

export const DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS = Object.freeze({
	maxImageBytes: 16 * 1024 * 1024,
	maxTotalBytes: 48 * 1024 * 1024,
});

type FetchedImageBytes = {
	base64: string;
	outputFormat: GeminiImageOutputFormat;
	byteLength: number;
};

class GeneratedImageLimitError extends Error {}

export async function hydrateGeneratedImages(
	cfg: RuntimeConfig,
	activeCfg: RuntimeConfig,
	images: GeminiParsedImage[],
	limits: GeneratedImageHydrationLimits = DEFAULT_GENERATED_IMAGE_HYDRATION_LIMITS,
): Promise<GeminiRichImage[]> {
	const out: GeminiRichImage[] = [];
	let remainingBytes = Math.max(0, Math.floor(limits.maxTotalBytes));
	for (const image of images) {
		if (image.source !== "generated") {
			out.push(image);
			continue;
		}
		try {
			if (remainingBytes <= 0)
				throw new GeneratedImageLimitError(
					"generated image aggregate byte limit reached",
				);
			const fetched = await fetchGeneratedImageBytes(
				cfg,
				activeCfg,
				image,
				Math.min(remainingBytes, Math.max(0, Math.floor(limits.maxImageBytes))),
			);
			remainingBytes -= fetched.byteLength;
			out.push({
				...image,
				base64: fetched.base64,
				outputFormat: fetched.outputFormat,
			});
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
	maxBytes: number,
): Promise<FetchedImageBytes> {
	const headers = generatedImageFetchHeaders(activeCfg);
	let lastErr: unknown = null;
	for (const target of generatedImagePreviewFetchUrls(image.url)) {
		try {
			return await fetchGeneratedImageBytesFromUrl(
				cfg,
				target,
				headers,
				maxBytes,
			);
		} catch (e) {
			if (e instanceof GeneratedImageLimitError) throw e;
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
	maxBytes: number,
): Promise<FetchedImageBytes> {
	try {
		if (maxBytes <= 0)
			throw new GeneratedImageLimitError("generated image byte limit reached");
		const resp = await httpFetch(target, {
			method: "GET",
			headers,
			timeoutMs: cfg.request_timeout_sec * 1000,
			socket: false,
			cfg,
		});
		const bytes = await responseBytes(resp, maxBytes);
		if (!resp.ok)
			throw upstreamImageFetchFailedError(
				`upstream HTTP ${resp.status}`,
				resp.status,
			);
		const outputFormat = outputFormatFromMime(detectUploadMimeFromBytes(bytes));
		if (!outputFormat)
			throw upstreamImageFetchFailedError(
				"response body is not a supported image",
				resp.status,
			);
		return {
			base64: bytesToBase64(bytes),
			outputFormat,
			byteLength: bytes.byteLength,
		};
	} catch (e) {
		if (e instanceof GeneratedImageLimitError) throw e;
		throw upstreamImageFetchFailedError(e);
	}
}

export function generatedImagePreviewFetchUrls(url: string): string[] {
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

export function generatedImageFetchHeaders(
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
	resp: Awaited<ReturnType<typeof httpFetch>>,
	maxBytes: number,
): Promise<Uint8Array> {
	if (!resp.body) return new Uint8Array(0);
	const declaredLength = Number(resp.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await resp.body.cancel().catch(() => undefined);
		throw new GeneratedImageLimitError(
			`generated image exceeds ${maxBytes} byte limit`,
		);
	}
	const reader = resp.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (total + value.byteLength > maxBytes) {
			await reader.cancel().catch(() => undefined);
			throw new GeneratedImageLimitError(
				`generated image exceeds ${maxBytes} byte limit`,
			);
		}
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

function outputFormatFromMime(mime: string): GeminiImageOutputFormat | "" {
	switch (mime) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpeg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "";
	}
}
