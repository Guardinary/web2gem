import {
	abortError,
	isAbortError,
	throwIfAborted,
	timeoutSignal,
} from "../../shared/abort";
import {
	canFallbackAfterSocketError,
	errorLogSummary,
} from "../../shared/errors";
import { log } from "../../shared/logging";
import { getDefaultSocketPool, resolveConnect, socketHttp } from "./socket";
import type { SocketHttpResponse } from "./socket";

type HttpBodyInit = BodyInit | ArrayBufferView;

type HttpFetchOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: HttpBodyInit | null | undefined;
	bodyLength?: number | null | undefined;
	timeoutMs?: number;
	socket?: boolean;
	socketFallback?: "pre-response" | "never";
	signal?: AbortSignal | null | undefined;
	cfg?: { log_requests?: unknown } | null;
	acceptCompressed?: boolean;
};

// 统一上游入口:socket 优先,失败/不可用则回退 fetch。返回类 Response 对象。
export async function httpFetch(
	url: string,
	{
		method = "GET",
		headers = {},
		body,
		bodyLength = null,
		timeoutMs = 180000,
		socket = true,
		socketFallback = "pre-response",
		signal,
		cfg,
		acceptCompressed,
	}: HttpFetchOptions = {},
): Promise<Response | SocketHttpResponse> {
	throwIfAborted(signal);
	if (socket) {
		const connect = await resolveConnect();
		if (connect) {
			try {
				const resp = await socketHttp(connect, url, {
					method,
					headers,
					body,
					bodyLength,
					timeoutMs,
					signal,
					keepAlive: true,
					pool: getDefaultSocketPool(),
					acceptCompressed: acceptCompressed ?? method.toUpperCase() === "GET",
				});
				return resp;
			} catch (e) {
				if (isAbortError(e) || signal?.aborted) throw abortError(signal);
				if (socketFallback === "never") {
					log(
						cfg,
						`socket upstream failed; fallback disabled for ${method}: ${errorLogSummary(e)}`,
					);
					throw e;
				}
				if (
					body instanceof ReadableStream &&
					socketErrorConsumedRequestBody(e)
				) {
					log(
						cfg,
						`socket upstream failed; not falling back with streaming request body for ${method}: ${errorLogSummary(e)}`,
					);
					throw e;
				}
				if (!canFallbackAfterSocketError(method, e)) {
					log(
						cfg,
						`socket upstream failed; not falling back after upstream response for ${method}: ${errorLogSummary(e)}`,
					);
					throw e;
				}
				log(
					cfg,
					`socket upstream failed; falling back to fetch: ${errorLogSummary(e)}`,
				);
			}
		}
	}
	const linked = linkedFetchSignal(signal, timeoutSignal(timeoutMs));
	try {
		const init: RequestInit = { method, headers };
		if (body !== undefined) init.body = body as BodyInit;
		if (body instanceof ReadableStream)
			(init as RequestInit & { duplex?: "half" }).duplex = "half";
		if (linked.signal) init.signal = linked.signal;
		return await fetch(url, init);
	} finally {
		linked.cleanup();
	}
}

function socketErrorConsumedRequestBody(error: unknown): boolean {
	const err = error as
		| { requestBodyStarted?: unknown; code?: unknown }
		| null
		| undefined;
	return (
		!!err &&
		(err.requestBodyStarted === true ||
			err.code === "socket_stream_body_length_required")
	);
}

function linkedFetchSignal(
	signal: AbortSignal | null | undefined,
	timeout: AbortSignal | undefined,
): { signal: AbortSignal | undefined; cleanup: () => void } {
	if (!signal) return { signal: timeout, cleanup() {} };
	if (!timeout) return { signal, cleanup() {} };
	return { signal: AbortSignal.any([signal, timeout]), cleanup() {} };
}
