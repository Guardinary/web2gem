import { TEXT_ENCODER } from "../../shared/encoding";
import { throwIfAborted } from "../../shared/abort";
import { bytesFromBody } from "./byte-queue";
import { createSocketBodyStream } from "./body-stream";
import {
	maybeDecompressSocketBody,
	socketAcceptEncoding,
} from "./decompression";
import { parseSocketHeaderBlock, readSocketHeaderBlock } from "./http-parse";
import {
	closeIdleSocketPool,
	putIdleSocket,
	socketPoolKey,
	takeIdleSocket,
} from "./pool";
import { closeSocketQuietly, createSocketTimeoutScope } from "./timeout";
import type {
	ByteChunk,
	SocketConnect,
	SocketHttpOptions,
	SocketHttpResponse,
} from "./socket-types";
import type { ErrorWithMetadata } from "../../shared/types";

export type {
	ByteChunk,
	ByteQueue,
	SocketConnect,
	SocketHttpOptions,
	SocketHttpResponse,
	SocketPool,
} from "./socket-types";
export { _joinByteChunks, bytesFromBody, createByteQueue } from "./byte-queue";
export { MAX_SOCKET_HEADER_BYTES, parseHttpChunkSizeLine } from "./http-parse";
export {
	closeIdleSocketPool,
	createSocketPool,
	getDefaultSocketPool,
	putIdleSocket,
	SOCKET_KEEP_ALIVE_IDLE_MS,
	SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN,
	socketPoolKey,
	takeIdleSocket,
} from "./pool";
export {
	closeSocketQuietly,
	socketTimeoutError,
	withSocketTimeout,
} from "./timeout";

export let _connect: SocketConnect | null | undefined = undefined;

export function _setConnectForTest(
	connect: SocketConnect | null | undefined,
): void {
	closeIdleSocketPool();
	_connect = connect;
}

export async function resolveConnect(): Promise<SocketConnect | null> {
	if (_connect !== undefined) return _connect;
	try {
		const mod = (await import("cloudflare:sockets")) as {
			connect?: SocketConnect;
		};
		_connect = mod.connect || null;
	} catch (_) {
		_connect = null;
	}
	return _connect;
}

export async function socketHttp(
	connect: SocketConnect,
	url: string | URL,
	{
		method = "GET",
		headers = {},
		body,
		bodyLength = null,
		timeoutMs = 180000,
		signal,
		keepAlive = false,
		pool = null,
		acceptCompressed = false,
	}: SocketHttpOptions = {},
): Promise<SocketHttpResponse> {
	throwIfAborted(signal);
	const u = new URL(url);
	const bodyStream = readableByteStreamFromBody(body);
	const bodyBytes = bodyStream ? null : bytesFromBody(body);
	const declaredBodyLength = safeBodyLength(bodyLength);
	if (bodyStream && declaredBodyLength == null)
		throw socketStreamBodyLengthError();
	const secure = u.protocol !== "http:";
	const port = u.port ? Number(u.port) : defaultSocketPort(secure);
	const poolKey = socketPoolKey(u, secure, port);
	const useKeepAlive = keepAlive && !!pool;
	const socket =
		(useKeepAlive && takeIdleSocket(pool, poolKey)) ||
		connect(
			{ hostname: u.hostname, port },
			{ secureTransport: secure ? "on" : "off", allowHalfOpen: false },
		);

	const onAbort = () => closeSocketQuietly(socket);
	if (signal) signal.addEventListener("abort", onAbort, { once: true });
	const timeout = createSocketTimeoutScope(timeoutMs, socket, signal);

	const reqHeaders: Record<string, string> = {
		Host: u.host,
		"Accept-Encoding": socketAcceptEncoding(acceptCompressed),
		Connection: useKeepAlive ? "keep-alive" : "close",
	};
	for (const [k, v] of Object.entries(headers)) {
		if (/^(host|connection|accept-encoding|content-length)$/i.test(k)) continue;
		reqHeaders[k] = String(v);
	}
	if (bodyBytes) reqHeaders["Content-Length"] = String(bodyBytes.length);
	else if (bodyStream)
		reqHeaders["Content-Length"] = String(declaredBodyLength);
	const headParts = [`${method} ${u.pathname}${u.search} HTTP/1.1`];
	for (const [k, v] of Object.entries(reqHeaders)) headParts.push(`${k}: ${v}`);
	const head = `${headParts.join("\r\n")}\r\n\r\n`;

	const writer = socket.writable.getWriter();
	try {
		await timeout.wait(
			writer.write(TEXT_ENCODER.encode(head)),
			"request headers write",
		);
		if (bodyBytes)
			await timeout.wait(writer.write(bodyBytes), "request body write");
		else if (bodyStream) {
			try {
				await writeRequestBodyStream(writer, bodyStream, timeout);
			} catch (e) {
				throw markRequestBodyStarted(e);
			}
		}
	} catch (e) {
		timeout.clear();
		if (signal) signal.removeEventListener("abort", onAbort);
		closeSocketQuietly(socket);
		throw e;
	}
	try {
		writer.releaseLock();
	} catch (_) {}

	const reader = socket.readable.getReader();
	const failBeforeBody = (message: unknown): never => {
		timeout.clear();
		if (signal) signal.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch (_) {}
		closeSocketQuietly(socket);
		throwIfAborted(signal);
		throw new Error(String(message));
	};
	let pending: ByteChunk = new Uint8Array(0);
	let status = 0;
	let respHttpVersion = "";
	let respHeaders = new Headers();
	for (;;) {
		const headerBlock = await readSocketHeaderBlock({
			initial: pending,
			reader,
			timeout,
			failBeforeBody,
		});
		pending = headerBlock.pending;
		const parsedHeaders = parseSocketHeaderBlock(headerBlock.headerBytes);
		respHttpVersion = parsedHeaders.httpVersion;
		status = parsedHeaders.status;
		respHeaders = parsedHeaders.headers;
		if (status >= 100 && status < 200 && status !== 101) continue;
		break;
	}
	const chunked = /chunked/i.test(respHeaders.get("transfer-encoding") || "");
	let clen: number | null = null;
	if (respHeaders.has("content-length")) {
		const rawContentLength = String(
			respHeaders.get("content-length") || "",
		).trim();
		if (!/^(0|[1-9]\d*)$/.test(rawContentLength))
			failBeforeBody(`socket: invalid Content-Length: ${rawContentLength}`);
		clen = Number(rawContentLength);
		if (!Number.isSafeInteger(clen))
			failBeforeBody(`socket: invalid Content-Length: ${rawContentLength}`);
	}
	const noBody =
		method.toUpperCase() === "HEAD" ||
		status === 204 ||
		status === 304 ||
		(status >= 100 && status < 200);
	const respConnection = respHeaders.get("connection") || "";
	const serverAllowsKeepAlive =
		respHttpVersion === "HTTP/1.1"
			? !/\bclose\b/i.test(respConnection)
			: respHttpVersion === "HTTP/1.0" &&
				/\bkeep-alive\b/i.test(respConnection);
	const keepAliveEligible =
		useKeepAlive &&
		serverAllowsKeepAlive &&
		(noBody || chunked || clen != null);

	let cleanupDone = false;
	const cleanupBody = (reuse: boolean) => {
		if (cleanupDone) return;
		cleanupDone = true;
		timeout.clear();
		if (signal) signal.removeEventListener("abort", onAbort);
		try {
			reader.releaseLock();
		} catch (_) {}
		if (reuse && pool) putIdleSocket(pool, poolKey, socket);
		else closeSocketQuietly(socket);
	};

	const stream = createSocketBodyStream({
		reader,
		timeout,
		pending,
		noBody,
		chunked,
		contentLength: clen,
		keepAliveEligible,
		cleanupBody,
	});

	const responseBody = maybeDecompressSocketBody(
		stream,
		respHeaders,
		noBody,
		clen,
	);
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: respHeaders,
		body: responseBody,
		text: async () => {
			const r = responseBody.getReader();
			const decoder = new TextDecoder();
			const chunks: string[] = [];
			for (;;) {
				const { done, value } = await r.read();
				if (done) break;
				if (!value?.length) continue;
				chunks.push(decoder.decode(value, { stream: true }));
			}
			const tail = decoder.decode();
			if (tail) chunks.push(tail);
			return chunks.join("");
		},
	};
}

function defaultSocketPort(secure: boolean): number {
	return secure ? 443 : 80;
}

function readableByteStreamFromBody(
	body: unknown,
): ReadableStream<Uint8Array> | null {
	if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
	return null;
}

function safeBodyLength(value: unknown): number | null {
	if (value == null) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function socketStreamBodyLengthError(): ErrorWithMetadata {
	const err: ErrorWithMetadata = new Error(
		"socket: streaming request body requires a known content length",
	);
	err.code = "socket_stream_body_length_required";
	return err;
}

function markRequestBodyStarted(error: unknown): unknown {
	if (error && typeof error === "object") {
		(
			error as ErrorWithMetadata & { requestBodyStarted?: true }
		).requestBodyStarted = true;
		return error;
	}
	const err: ErrorWithMetadata & { requestBodyStarted?: true } = new Error(
		String(error),
	);
	err.requestBodyStarted = true;
	return err;
}

async function writeRequestBodyStream(
	writer: WritableStreamDefaultWriter<ByteChunk>,
	stream: ReadableStream<Uint8Array>,
	timeout: ReturnType<typeof createSocketTimeoutScope>,
): Promise<void> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await timeout.wait(
				reader.read(),
				"request body read",
			);
			if (done) break;
			if (!value?.byteLength) continue;
			await timeout.wait(writer.write(value), "request body write");
		}
	} finally {
		try {
			reader.releaseLock();
		} catch (_) {}
	}
}
