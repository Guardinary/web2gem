// @ts-nocheck
import { describe, test } from "vitest";
import { sseResponse } from "../../../../src/http/core/sse";
import { assert } from "../../assertions.js";
import { withPatchedGlobal } from "../../_support/globals.js";

describe.sequential("sseResponse", () => {
	test("aborts SSE producer when client cancels", async () => {
		let sawAbort = false;
		let resolveDone;
		const done = new Promise((resolve) => {
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
		const reader = resp.body.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		await reader.cancel();
		await done;
		assert.equal(sawAbort, true);
	});
	test("handles SSE writes that race after client cancellation", async () => {
		let resolveAfterCancel;
		const afterCancel = new Promise((resolve) => {
			resolveAfterCancel = resolve;
		});
		const resp = sseResponse(async (write, signal) => {
			write("data: one\n\n");
			await new Promise((resolve) => {
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
		const reader = resp.body.getReader();
		const first = await reader.read();
		assert.equal(first.done, false);
		await reader.cancel();
		assert.equal(await afterCancel, "client disconnected");
	});
	test("emits SSE error frames and custom onError output", async () => {
		const errored = sseResponse(() => {
			const err = new Error("stream failed");
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
					write(`event: custom\ndata: ${String(err.message)}\n\n`);
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
				constructor() {
					this.readable = new NativeTransformStream().readable;
					this.writable = {
						getWriter() {
							return {
								closed: new Promise(() => {}),
								write() {
									return Promise.reject(new Error("write rejected"));
								},
								close() {
									return Promise.resolve();
								},
								releaseLock() {},
							};
						},
					};
				}
			},
			async () => {
				let sawAbort = false;
				const done = new Promise((resolve) => {
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
				constructor() {
					this.readable = new NativeTransformStream().readable;
					this.writable = {
						getWriter() {
							return {
								closed: new Promise(() => {}),
								write() {
									throw new Error("write threw");
								},
								close() {
									return Promise.resolve();
								},
								releaseLock() {},
							};
						},
					};
				}
			},
			async () => {
				let sawAbort = false;
				const done = new Promise((resolve) => {
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
