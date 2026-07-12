import { UTF8_FATAL_DECODER } from "../../shared/encoding";
import { tryParseJson } from "../../shared/json";
import type { UnknownRecord } from "../../shared/types";

export { parseJson, parseJsonObject, tryParseJson } from "../../shared/json";

export type ReadJsonRequestResult =
	| {
			value: UnknownRecord;
			bytes: number;
			error?: undefined;
			status?: undefined;
			code?: undefined;
			reason?: undefined;
	  }
	| {
			error: string;
			status: number;
			code?: string;
			reason?: string;
			value?: undefined;
			text?: undefined;
			bytes?: undefined;
	  };

export type ReadRequestBodyBytesResult =
	| {
			value: Uint8Array;
			bytes: number;
			error?: undefined;
			status?: undefined;
			code?: undefined;
	  }
	| {
			error: string;
			status: number;
			code?: string;
			value?: undefined;
			bytes?: undefined;
	  };

export type ReadJsonRequestOptions = {
	maxBodyBytes?: number | null;
	oversizedError?: {
		message: string;
		status: number;
		code?: string;
		reason?: string;
	};
};

export function jsonResponse(
	data: unknown,
	status = 200,
	extra: HeadersInit = {},
): Response {
	return jsonTextResponse(JSON.stringify(data), status, extra);
}

export function jsonTextResponse(
	body: string,
	status = 200,
	extra: HeadersInit = {},
): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "application/json", ...extra },
	});
}

export async function readJsonRequest(
	request: Request,
	options: ReadJsonRequestOptions = {},
): Promise<ReadJsonRequestResult> {
	const read = await readRequestBodyBytes(request, options);
	if (read.error !== undefined) return read;
	const buf = read.value;
	let bodyText: string;
	try {
		bodyText = UTF8_FATAL_DECODER.decode(buf);
	} catch (_) {
		return { error: "invalid UTF-8 request body", status: 400 };
	}
	const parsed = tryParseJson(bodyText);
	if (!parsed.ok) return { error: "invalid JSON", status: 400 };
	if (
		!parsed.value ||
		typeof parsed.value !== "object" ||
		Array.isArray(parsed.value)
	) {
		return { error: "request body must be a JSON object", status: 400 };
	}
	return { value: parsed.value as UnknownRecord, bytes: buf.byteLength };
}

export async function readRequestBodyBytes(
	request: Request,
	options: ReadJsonRequestOptions = {},
): Promise<ReadRequestBodyBytesResult> {
	try {
		const maxBodyBytes = boundedMaxBodyBytes(options.maxBodyBytes);
		const value = await readRequestBodyBounded(
			request,
			maxBodyBytes,
			options.oversizedError,
		);
		return { value, bytes: value.byteLength };
	} catch (e) {
		if (isReadJsonRequestError(e)) {
			return e.result;
		}
		const err = e as { message?: unknown } | null | undefined;
		return {
			error: `failed to read request body: ${err?.message || e}`,
			status: 400,
		};
	}
}

type ReadJsonRequestError = Error & {
	result: Extract<ReadJsonRequestResult, { error: string }>;
};

function boundedMaxBodyBytes(value: number | null | undefined): number | null {
	if (value == null) return null;
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n >= 0 ? n : null;
}

async function readRequestBodyBounded(
	request: Request,
	maxBodyBytes: number | null,
	oversizedError?: ReadJsonRequestOptions["oversizedError"],
): Promise<Uint8Array> {
	if (maxBodyBytes == null) return request.bytes();
	const contentLength = requestContentLength(request);
	if (contentLength != null && contentLength > maxBodyBytes) {
		throw readJsonRequestError(
			oversizedError || oversizedBodyError(contentLength, maxBodyBytes),
		);
	}
	if (!request.body) return request.bytes();
	const reader = request.body.getReader();
	let out = contentLength != null ? new Uint8Array(contentLength) : null;
	let chunks: Uint8Array[] | null = out ? null : [];
	let total = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (!value?.byteLength) continue;
			const nextTotal = total + value.byteLength;
			if (nextTotal > maxBodyBytes) {
				try {
					await reader.cancel();
				} catch (_) {}
				throw readJsonRequestError(
					oversizedError || {
						message: `request body is too large (${nextTotal} bytes > ${maxBodyBytes})`,
						status: 413,
					},
				);
			}
			if (out && nextTotal <= out.byteLength) {
				out.set(value, total);
			} else {
				if (!chunks) {
					chunks = [];
					if (out && total > 0) chunks.push(out.subarray(0, total));
					out = null;
				}
				chunks.push(value);
			}
			total = nextTotal;
		}
	} finally {
		try {
			reader.releaseLock();
		} catch (_) {}
	}
	if (out) return total === out.byteLength ? out : out.subarray(0, total);
	if (!chunks) return new Uint8Array(0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

export function requestContentLength(request: Request): number | null {
	const raw = request.headers.get("content-length");
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!/^(0|[1-9]\d*)$/.test(trimmed)) return null;
	const n = Number(trimmed);
	return Number.isSafeInteger(n) ? n : null;
}

function oversizedBodyError(
	total: number,
	maxBodyBytes: number,
): NonNullable<ReadJsonRequestOptions["oversizedError"]> {
	return {
		message: `request body is too large (${total} bytes > ${maxBodyBytes})`,
		status: 413,
	};
}

function readJsonRequestError(
	result: ReadJsonRequestOptions["oversizedError"],
): ReadJsonRequestError {
	const err = new Error(
		result?.message || "failed to read request body",
	) as ReadJsonRequestError;
	const responseError: Extract<ReadJsonRequestResult, { error: string }> = {
		error: result?.message || "failed to read request body",
		status: result?.status || 400,
	};
	if (result?.code) responseError.code = result.code;
	if (result?.reason) responseError.reason = result.reason;
	err.result = responseError;
	return err;
}

function isReadJsonRequestError(error: unknown): error is ReadJsonRequestError {
	return !!error && typeof error === "object" && "result" in error;
}
