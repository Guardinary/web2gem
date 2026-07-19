import { _joinByteChunks } from "../../../../../src/gemini/transport/byte-queue";
import type {
	ByteChunk,
	SocketConnect,
} from "../../../../../src/gemini/transport/socket-types";

export type SocketTestState = {
	writes?: ByteChunk[];
	closed?: boolean | number;
	connects?: number;
};

type SocketResponseChunk = string | ByteChunk;

export function fakeSocketConnect(
	responseChunks: readonly SocketResponseChunk[],
	state: SocketTestState = {},
): SocketConnect {
	const encoder = new TextEncoder();
	const writes: ByteChunk[] = [];
	let connected = false;
	state.writes = writes;
	state.closed = false;
	state.connects = 0;
	return function connect() {
		if (connected) throw new Error("unexpected additional socket connection");
		connected = true;
		state.connects = (state.connects ?? 0) + 1;
		return {
			readable: new ReadableStream({
				start(controller) {
					for (const chunk of responseChunks) {
						controller.enqueue(
							typeof chunk === "string" ? encoder.encode(chunk) : chunk,
						);
					}
					controller.close();
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					writes.push(chunk);
				},
			}),
			close() {
				state.closed = true;
			},
		};
	};
}

export function fakePersistentSocketConnect(
	responseChunksByRequest: readonly (readonly SocketResponseChunk[])[],
	state: SocketTestState = {},
): SocketConnect {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const writes: ByteChunk[] = [];
	state.writes = writes;
	state.connects = 0;
	state.closed = 0;
	let responseIndex = 0;
	return function connect() {
		state.connects = (state.connects ?? 0) + 1;
		let controller: ReadableStreamDefaultController<ByteChunk> | undefined;
		let requestText = "";
		return {
			readable: new ReadableStream({
				start(activeController) {
					controller = activeController;
				},
			}),
			writable: new WritableStream({
				write(chunk) {
					writes.push(chunk);
					requestText += decoder.decode(chunk, { stream: true });
					if (!requestText.includes("\r\n\r\n")) return;
					if (responseIndex >= responseChunksByRequest.length) {
						throw new Error("unexpected additional socket request");
					}
					const responseChunks = responseChunksByRequest[responseIndex++];
					if (!responseChunks) {
						throw new Error("missing socket response chunks");
					}
					requestText = "";
					for (const part of responseChunks) {
						controller?.enqueue(
							typeof part === "string" ? encoder.encode(part) : part,
						);
					}
				},
			}),
			close() {
				state.closed = Number(state.closed ?? 0) + 1;
				try {
					controller?.close();
				} catch (_) {}
			},
		};
	};
}

export function joinedWriteText(state: SocketTestState): string {
	const writes = state.writes ?? [];
	const total = writes.reduce((sum, chunk) => sum + chunk.length, 0);
	return new TextDecoder().decode(_joinByteChunks(writes, total));
}
