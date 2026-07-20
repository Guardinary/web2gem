import { describe, test } from "vitest";
import { sseResponse } from "../../../../src/http/core/sse";
import type { ErrorWithMetadata } from "../../../../src/shared/types";
import { withPatchedGlobal } from "../../_support/globals.js";
import { assert } from "../../assertions.js";

function responseBody(response: Response): ReadableStream<Uint8Array> {
	if (!response.body) throw new Error("expected response body");
	return response.body;
}

type TestWriter = {
	closed: Promise<void>;
	write(chunk: Uint8Array): Promise<void>;
	close(): Promise<void>;
	releaseLock(): void;
};

describe.sequential("sseResponse", () => {
	test("aborts SSE producer when client cancels", async () => {
		let sawAbort = false;
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const resp = sseResponse(async (write, signal) => {
			write("data: one\n\n");
			await new Promise((resolve) =>
				signal.addEventListener("abort", resolve, { once: true }),
			);
			sawAbort = signal.aborted;
			resolveDone();
		});
		const reader = responseBody(resp).getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		await reader.cancel();
		await done;
		assert.equal(sawAbort, true);
	});
	test("handles SSE writes that race after client cancellation", async () => {
		let resolveAfterCancel!: (reason: unknown) => void;
		const afterCancel = new Promise<unknown>((resolve) => {
			resolveAfterCancel = resolve;
		});
		const resp = sseResponse(async (write, signal) => {
			write("data: one\n\n");
			await new Promise<void>((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						write("data: after-cancel\n\n");
						resolveAfterCancel(signal.reason);
						resolve();
					},
					{ once: true },
				);
			});
		});
		const reader = responseBody(resp).getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		await reader.cancel();
		assert.equal(await afterCancel, "client disconnected");
	});
	test("emits SSE error frames and custom onError output", async () => {
		const errored = sseResponse(() => {
			const err: ErrorWithMetadata = new Error("stream failed");
			err.code = "upstream_failed";
			throw err;
		});
		const errorText = await errored.text();
		assert.match(errorText, /event: error/);
		assert.match(errorText, /"message":"stream failed"/);
		assert.match(errorText, /"code":"upstream_failed"/);

		const custom = sseResponse(
			() => {
				throw new Error("hidden");
			},
			{
				onError(write, err) {
					const message = err instanceof Error ? err.message : String(err);
					return write(`event: custom\ndata: ${message}\n\n`);
				},
			},
		);
		assert.equal(await custom.text(), "event: custom\ndata: hidden\n\n");
	});
	test("aborts SSE producers when stream writes fail", async () => {
		const NativeTransformStream = globalThis.TransformStream;

		await withPatchedGlobal(
			"TransformStream",
			class {
				readonly readable: ReadableStream<Uint8Array>;
				readonly writable: { getWriter(): TestWriter };

				constructor() {
					this.readable = new NativeTransformStream().readable;
					this.writable = {
						getWriter() {
							return {
								closed: new Promise<void>(() => {}),
								write(_chunk: Uint8Array) {
									return Promise.reject(new Error("write rejected"));
								},
								close(): Promise<void> {
									return Promise.resolve();
								},
								releaseLock(): void {},
							};
						},
					};
				}
			},
			async () => {
				let sawAbort = false;
				const done = new Promise<void>((resolve) => {
					sseResponse(async (write, signal) => {
						write("data: rejected\n\n");
						await new Promise((innerResolve) =>
							signal.addEventListener("abort", innerResolve, { once: true }),
						);
						sawAbort = signal.aborted;
						resolve();
					});
				});
				await done;
				assert.equal(sawAbort, true);
			},
		);

		await withPatchedGlobal(
			"TransformStream",
			class {
				readonly readable: ReadableStream<Uint8Array>;
				readonly writable: { getWriter(): TestWriter };

				constructor() {
					this.readable = new NativeTransformStream().readable;
					this.writable = {
						getWriter() {
							return {
								closed: new Promise<void>(() => {}),
								write(_chunk: Uint8Array): Promise<void> {
									throw new Error("write threw");
								},
								close(): Promise<void> {
									return Promise.resolve();
								},
								releaseLock(): void {},
							};
						},
					};
				}
			},
			async () => {
				let sawAbort = false;
				const done = new Promise<void>((resolve) => {
					sseResponse(async (write, signal) => {
						write("data: thrown\n\n");
						sawAbort = signal.aborted;
						resolve();
					});
				});
				await done;
				assert.equal(sawAbort, true);
			},
		);
	});
});
