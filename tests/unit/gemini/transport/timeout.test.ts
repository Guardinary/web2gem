// @ts-nocheck
import { afterEach, describe, test, vi } from "vitest";
import {
	closeSocketQuietly,
	socketTimeoutError,
	withSocketTimeout,
} from "../../../../src/gemini/transport/timeout";
import { assert } from "../../assertions.js";

describe.sequential("socket timeout helpers", () => {
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	test("creates timeout metadata and closes expired sockets", async () => {
		vi.useFakeTimers();
		const timeoutErr = socketTimeoutError("headers", 3);
		assert.equal(timeoutErr.code, "socket_timeout");
		assert.match(timeoutErr.message, /headers timed out after 3ms/);

		let closeCount = 0;
		const socket = {
			close() {
				closeCount += 1;
			},
		};
		const pending = withSocketTimeout(new Promise(() => {}), 1, "idle", socket);
		const rejection = assert.rejects(() => pending, /idle timed out/);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
		assert.equal(closeCount, 1);
	});

	test("closes sockets quietly", () => {
		let closeCount = 0;
		closeSocketQuietly({
			close() {
				closeCount += 1;
				throw new Error("close failed");
			},
		});
		closeSocketQuietly({ close: "not a function" });
		assert.equal(closeCount, 1);
	});

	test("bypasses disabled socket timeouts", async () => {
		const socket = { close() {} };
		assert.equal(
			await withSocketTimeout(Promise.resolve("ok"), 0, "disabled", socket),
			"ok",
		);
	});

	test("preserves abort reasons around socket timeout settlement", async () => {
		const socket = { close() {} };
		const aborted = new AbortController();
		aborted.abort("before start");
		await assert.rejects(
			() =>
				withSocketTimeout(
					Promise.resolve("unused"),
					10,
					"aborted",
					socket,
					aborted.signal,
				),
			/before start/,
		);

		const lateAbort = new AbortController();
		await assert.rejects(
			() =>
				withSocketTimeout(
					Promise.resolve().then(() => {
						lateAbort.abort("after settle");
						return "unused";
					}),
					10,
					"late",
					socket,
					lateAbort.signal,
				),
			/after settle/,
		);

		const rejectAbort = new AbortController();
		await assert.rejects(
			() =>
				withSocketTimeout(
					Promise.resolve().then(() => {
						rejectAbort.abort("reject abort");
						throw new Error("original failure");
					}),
					10,
					"reject",
					socket,
					rejectAbort.signal,
				),
			/reject abort/,
		);
	});
});
