import { createByteQueue } from "./byte-queue";
import type { ByteChunk, SocketTimeoutScope } from "./socket-types";

type SocketBodyStreamOptions = {
	reader: ReadableStreamDefaultReader<ByteChunk>;
	timeout: SocketTimeoutScope;
	pending: ByteChunk;
	noBody: boolean;
	chunked: boolean;
	contentLength: number | null;
	keepAliveEligible: boolean;
	cleanupBody: (reuse: boolean) => void;
};

export function createSocketBodyStream({
	reader,
	timeout,
	pending,
	noBody,
	chunked,
	contentLength,
	keepAliveEligible,
	cleanupBody,
}: SocketBodyStreamOptions): ReadableStream<ByteChunk> {
	const queue = createByteQueue(pending);
	let fixedRemaining = contentLength == null ? null : contentLength;
	let chunkRemaining = 0;
	let bodyDone = false;

	const pullToQueue = async () => {
		const { done, value } = await timeout.wait(
			reader.read(),
			"response body idle",
		);
		if (done) return false;
		queue.push(value);
		return true;
	};

	const readAvailableLine = async () => {
		let line = queue.readLineIfAvailable();
		while (line === null) {
			if (!(await pullToQueue())) return null;
			line = queue.readLineIfAvailable();
		}
		return line;
	};
	const readAvailableChunkSize = async () => {
		let parsed = queue.readHttpChunkSizeLineIfAvailable();
		while (parsed === null) {
			if (!(await pullToQueue())) return null;
			parsed = queue.readHttpChunkSizeLineIfAvailable();
		}
		return parsed;
	};

	const closeController = (
		controller: ReadableStreamDefaultController<ByteChunk>,
	) => {
		if (bodyDone) return;
		bodyDone = true;
		cleanupBody(keepAliveEligible && queue.length === 0);
		controller.close();
	};

	return new ReadableStream<ByteChunk>({
		start(controller) {
			if (noBody) closeController(controller);
		},
		async pull(controller) {
			if (bodyDone) return;
			try {
				if (chunked) {
					for (;;) {
						if (chunkRemaining > 0) {
							while (queue.length <= 0) {
								if (!(await pullToQueue()))
									throw new Error("socket: incomplete chunked body");
							}
							const take = Math.min(chunkRemaining, queue.length);
							const out = queue.read(take);
							chunkRemaining -= out.length;
							controller.enqueue(out);
							if (chunkRemaining === 0) {
								while (queue.length < 2) {
									if (!(await pullToQueue()))
										throw new Error("socket: incomplete chunked body");
								}
								if (!queue.skipCRLF())
									throw new Error("socket: invalid chunk terminator");
							}
							return;
						}
						const parsedSize = await readAvailableChunkSize();
						if (parsedSize === null)
							throw new Error("socket: incomplete chunked body");
						chunkRemaining = parsedSize.size;
						if (chunkRemaining < 0)
							throw new Error(
								`socket: invalid chunk size: ${parsedSize.errorLine}`,
							);
						if (chunkRemaining === 0) {
							for (;;) {
								const trailer = await readAvailableLine();
								if (trailer === null || trailer.length === 0) {
									closeController(controller);
									return;
								}
							}
						}
					}
				} else if (fixedRemaining != null) {
					if (fixedRemaining <= 0) {
						closeController(controller);
						return;
					}
					while (queue.length <= 0) {
						if (!(await pullToQueue()))
							throw new Error("socket: incomplete fixed-length body");
					}
					const out = queue.read(Math.min(fixedRemaining, queue.length));
					fixedRemaining -= out.length;
					controller.enqueue(out);
					if (fixedRemaining <= 0) closeController(controller);
				} else {
					if (queue.length) {
						queue.drain(controller);
						return;
					}
					const { done, value } = await timeout.wait(
						reader.read(),
						"response body idle",
					);
					if (done) {
						closeController(controller);
						return;
					}
					if (value?.length) controller.enqueue(value);
				}
			} catch (e) {
				bodyDone = true;
				cleanupBody(false);
				controller.error(e);
			}
		},
		cancel() {
			cleanupBody(false);
		},
	});
}
