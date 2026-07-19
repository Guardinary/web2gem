// @ts-nocheck
import { afterEach, describe, test, vi } from "vitest";
import { createDeltaCoalescer } from "../../../../src/http/stream/coalescer";
import { assert } from "../../assertions.js";

describe.sequential("createDeltaCoalescer", () => {
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});
	test("coalesces stream deltas by field and flush threshold", async () => {
		const frames = [];
		const coalescer = createDeltaCoalescer((delta) => frames.push(delta), 5, 0);
		await coalescer.append("content", "hi");
		assert.deepEqual(frames, []);
		await coalescer.append("content", "!");
		await coalescer.append("tool_calls", "x");
		assert.deepEqual(frames, [{ content: "hi!" }]);
		await coalescer.append("tool_calls", "yzabc");
		assert.deepEqual(frames, [{ content: "hi!" }, { tool_calls: "xyzabc" }]);
		await coalescer.flush();
		assert.deepEqual(frames, [{ content: "hi!" }, { tool_calls: "xyzabc" }]);
	});
	test("can emit the first stream delta immediately before throttling", async () => {
		const frames = [];
		const coalescer = createDeltaCoalescer(
			(delta) => frames.push(delta),
			5,
			0,
			{ emitFirstImmediately: true },
		);
		await coalescer.append("content", "hi");
		assert.deepEqual(frames, [{ content: "hi" }]);
		await coalescer.append("content", "!");
		assert.deepEqual(frames, [{ content: "hi" }]);
		await coalescer.flush();
		assert.deepEqual(frames, [{ content: "hi" }, { content: "!" }]);
	});
	test("flushes buffered stream deltas after the coalescing timer", async () => {
		vi.useFakeTimers();
		const frames = [];
		const coalescer = createDeltaCoalescer(
			async (delta) => {
				frames.push(delta);
			},
			64,
			1,
		);
		await coalescer.append("content", "hi");
		assert.deepEqual(frames, []);
		await vi.advanceTimersByTimeAsync(1);
		assert.deepEqual(frames, [{ content: "hi" }]);
		await coalescer.flush();
	});
	test("coalesces stream deltas after unknown input normalization", async () => {
		const frames = [];
		const coalescer = createDeltaCoalescer(
			(delta) => frames.push(delta),
			16,
			0,
		);
		await coalescer.append("content", "");
		await coalescer.append("content", 0);
		await coalescer.append("content", false);
		await coalescer.append("content", null);
		await coalescer.append("content", undefined);
		await coalescer.flush();
		assert.deepEqual(frames, []);

		await coalescer.append("content", { ok: true });
		assert.deepEqual(frames, []);
		await coalescer.append("content", "!");
		assert.deepEqual(frames, [{ content: "[object Object]!" }]);

		await coalescer.append("content", true);
		await coalescer.flush();
		assert.deepEqual(frames, [
			{ content: "[object Object]!" },
			{ content: "true" },
		]);
	});
});
