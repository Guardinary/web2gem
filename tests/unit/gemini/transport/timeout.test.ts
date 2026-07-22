import { afterEach, describe, test, vi } from "vitest";
import {
	closeSocketQuietly,
	createSocketTimeoutScope,
	socketTimeoutError,
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
		const scope = createSocketTimeoutScope(1, socket);
		const pending = scope.wait(new Promise(() => {}), "idle");
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
		const scope = createSocketTimeoutScope(0, socket);
		assert.equal(await scope.wait(Promise.resolve("ok"), "disabled"), "ok");
	});

	test("preserves abort reasons around socket timeout settlement", async () => {
		const socket = { close() {} };
		const aborted = new AbortController();
		aborted.abort("before start");
		const abortedScope = createSocketTimeoutScope(10, socket, aborted.signal);
		await assert.rejects(
			() => abortedScope.wait(Promise.resolve("unused"), "aborted"),
			/before start/,
		);

		const lateAbort = new AbortController();
		const lateScope = createSocketTimeoutScope(10, socket, lateAbort.signal);
		await assert.rejects(
			() =>
				lateScope.wait(
					Promise.resolve().then(() => {
						lateAbort.abort("after settle");
						return "unused";
					}),
					"late",
				),
			/after settle/,
		);

		const rejectAbort = new AbortController();
		const rejectScope = createSocketTimeoutScope(
			10,
			socket,
			rejectAbort.signal,
		);
		await assert.rejects(
			() =>
				rejectScope.wait(
					Promise.resolve().then(() => {
						rejectAbort.abort("reject abort");
						throw new Error("original failure");
					}),
					"reject",
				),
			/reject abort/,
		);
	});
});
