import { afterEach, describe, test, vi } from "vitest";
import {
	abortError,
	isAbortError,
	sleep,
	throwIfAborted,
	timeoutSignal,
} from "../../../src/shared/abort";
import { assert } from "../assertions.js";

describe.sequential("shared abort primitives", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	test("creates timeout signals and resolves zero-delay sleep", async () => {
		await sleep(0);
		assert.equal(timeoutSignal("not-a-number"), undefined);
		assert.equal(timeoutSignal(0), undefined);
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		assert.equal(timeoutSignal(1), controller.signal);
		assert.deepEqual(timeout.mock.calls, [[1]]);
	});

	test("propagates abort reasons through throwIfAborted and sleep", async () => {
		const already = new AbortController();
		already.abort("already done");
		try {
			throwIfAborted(already.signal);
			throw new Error("expected throwIfAborted to throw");
		} catch (err) {
			assert.equal(err.name, "AbortError");
			assert.equal(err.code, "request_aborted");
			assert.match(err.message, /already done/);
		}
		await assert.rejects(() => sleep(0, already.signal), /already done/);

		const during = new AbortController();
		const pending = sleep(1000, during.signal);
		during.abort("later done");
		await assert.rejects(pending, /later done/);
	});

	test("classifies abort-shaped errors", () => {
		assert.equal(isAbortError({ code: "request_aborted" }), true);
		assert.equal(isAbortError({ name: "AbortError" }), true);
		assert.equal(isAbortError(new Error("plain")), false);
	});

	test("normalizes signal reasons and default abort errors", () => {
		const reason = new Error("custom reason");
		const ac = new AbortController();
		ac.abort(reason);
		assert.equal(abortError(ac.signal), reason);
		const plainAbort = abortError();
		assert.equal(plainAbort.name, "AbortError");
		assert.equal(plainAbort.code, "request_aborted");
		assert.match(plainAbort.message, /request aborted/);
	});
});
