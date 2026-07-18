import { _joinByteChunks } from "../../../../../src/gemini/transport/byte-queue";

export function fakeSocketConnect(responseChunks, state = {}) {
	const encoder = new TextEncoder();
	const writes = [];
	let connected = false;
	state.writes = writes;
	state.closed = false;
	state.connects = 0;
	return function connect() {
		if (connected) throw new Error("unexpected additional socket connection");
		connected = true;
		state.connects += 1;
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
	responseChunksByRequest,
	state = {},
) {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const writes = [];
	state.writes = writes;
	state.connects = 0;
	state.closed = 0;
	let responseIndex = 0;
	return function connect() {
		state.connects += 1;
		let controller;
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
					requestText = "";
					for (const part of responseChunks) {
						controller.enqueue(
							typeof part === "string" ? encoder.encode(part) : part,
						);
					}
				},
			}),
			close() {
				state.closed += 1;
				try {
					controller.close();
				} catch (_) {}
			},
		};
	};
}

export function joinedWriteText(state) {
	const total = state.writes.reduce((sum, chunk) => sum + chunk.length, 0);
	return new TextDecoder().decode(_joinByteChunks(state.writes, total));
}
