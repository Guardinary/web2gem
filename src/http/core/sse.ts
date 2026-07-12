import { TEXT_ENCODER } from "../../shared/encoding";
import { isAbortError, sleep } from "../../shared/abort";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";

export type SSEWrite = (chunk: string) => void | Promise<void>;
export type SSEProducer = (
	write: SSEWrite,
	signal: AbortSignal,
) => unknown | Promise<unknown>;
export type SSEOptions = {
	onError?: (write: SSEWrite, error: unknown) => unknown | Promise<unknown>;
};

const SSE_DONE_FRAME = "data: [DONE]\n\n";
const SSE_KEEP_ALIVE_FRAME = ": keep-alive\n\n";
const SSE_DONE_CHUNK = TEXT_ENCODER.encode(SSE_DONE_FRAME);
const SSE_KEEP_ALIVE_CHUNK = TEXT_ENCODER.encode(SSE_KEEP_ALIVE_FRAME);

export function sseResponse(
	producer: SSEProducer,
	options: SSEOptions = {},
): Response {
	const ac = new AbortController();
	const { readable, writable } = createSSETransform();
	const writer = writable.getWriter();
	let closed = false;
	let keepAliveWrite: Promise<void> | null = null;

	const abort = (reason: unknown) => {
		try {
			if (!ac.signal.aborted) ac.abort(reason);
		} catch (_) {}
	};

	const write: SSEWrite = (chunk) => {
		if (closed || ac.signal.aborted) return;
		const bytes = sseFrameBytes(chunk);
		try {
			return writer.write(bytes).catch(() => {
				closed = true;
				abort("stream closed");
			});
		} catch (_) {
			closed = true;
			abort("stream closed");
			return;
		}
	};

	writer.closed.catch(() => abort("client disconnected"));

	const runKeepAlive = async () => {
		while (!closed && !ac.signal.aborted) {
			try {
				await sleep(15000, ac.signal);
			} catch (_) {
				return;
			}
			if (closed || ac.signal.aborted || keepAliveWrite) return;
			keepAliveWrite = Promise.resolve(write(SSE_KEEP_ALIVE_FRAME)).then(
				() => undefined,
				() => undefined,
			);
			await keepAliveWrite;
			keepAliveWrite = null;
		}
	};

	const run = async () => {
		void runKeepAlive();
		try {
			await producer(write, ac.signal);
		} catch (e) {
			if (isAbortError(e) || ac.signal.aborted) return;
			if (typeof options.onError === "function") {
				try {
					await options.onError(write, e);
				} catch (_) {}
			} else {
				await write(
					`event: error\ndata: ${JSON.stringify({ error: { message: upstreamErrorMessage(e), code: upstreamErrorCode(e) || "stream_error", ...(upstreamErrorReason(e) ? { reason: upstreamErrorReason(e) } : {}) } })}\n\n`,
				);
			}
		} finally {
			closed = true;
			abort("stream finished");
			try {
				await writer.close();
			} catch (_) {}
			try {
				writer.releaseLock();
			} catch (_) {}
		}
	};
	void run();

	return new Response(readable, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

function sseFrameBytes(chunk: string): Uint8Array {
	if (chunk === SSE_DONE_FRAME) return SSE_DONE_CHUNK;
	if (chunk === SSE_KEEP_ALIVE_FRAME) return SSE_KEEP_ALIVE_CHUNK;
	return TEXT_ENCODER.encode(chunk);
}

function createSSETransform(): TransformStream<Uint8Array, Uint8Array> {
	const Ctor =
		(
			globalThis as typeof globalThis & {
				IdentityTransformStream?: new () => TransformStream<
					Uint8Array,
					Uint8Array
				>;
			}
		).IdentityTransformStream || TransformStream;
	return new Ctor();
}
