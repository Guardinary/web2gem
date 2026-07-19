// @ts-nocheck
import { describe, test } from "vitest";
import { createAttachmentPlan } from "../../../src/attachments/plan";
import { UploadReplayState } from "../../../src/gemini/upload-replay";
import { assert } from "../assertions.js";
import { deferred } from "../_support/deferred.js";
import { baseGeminiClientConfig } from "./_support/client-fixtures.js";

function attachmentResult(refs) {
	return { fileRefs: refs };
}

function failFastDelegates(overrides = {}) {
	return {
		async resolveAttachments() {
			throw new Error("unexpected resolveAttachments call");
		},
		async uploadTextFile() {
			throw new Error("unexpected uploadTextFile call");
		},
		...overrides,
	};
}

async function captureError(run) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

describe("Gemini upload replay state", () => {
	test("remaps recorded refs without mutating the completion input", () => {
		const state = new UploadReplayState(failFastDelegates());
		const plan = createAttachmentPlan({
			existingFileRefs: [{ ref: "/attachment/a", name: "a.txt" }],
		});
		const initialRef = { ref: "/attachment/a", name: "a.txt" };
		state.recordAttachments(plan, attachmentResult([initialRef]));
		const input = {
			prompt: "prompt",
			rm: { name: "model" },
			fileRefs: [initialRef],
		};
		const remapped = state.remapInput(input);
		assert.equal(remapped === input, false);
		assert.equal(remapped.fileRefs === input.fileRefs, false);
		assert.deepEqual(remapped.fileRefs, [initialRef]);
		assert.deepEqual(input.fileRefs, [initialRef]);
		assert.equal(state.hasOpaqueRefs(input), false);
		assert.equal(
			state.hasOpaqueRefs({
				...input,
				fileRefs: [{ ref: "/external/opaque", name: "opaque.txt" }],
			}),
			true,
		);
	});

	test("replays recipes in order and carries aliases across A to B to C", async () => {
		const calls = [];
		const state = new UploadReplayState(
			failFastDelegates({
				async resolveAttachments(activeCfg, activePlan) {
					const accountId = activeCfg.gemini_account.accountId;
					calls.push(["attachments", accountId, activePlan]);
					return attachmentResult([
						{ ref: `/attachment/${accountId}`, name: "file.txt" },
					]);
				},
				async uploadTextFile(activeCfg, text, filename) {
					const accountId = activeCfg.gemini_account.accountId;
					calls.push(["text", accountId, text, filename]);
					return { ref: `/text/${accountId}`, name: filename };
				},
			}),
		);
		const plan = createAttachmentPlan({
			existingFileRefs: [{ ref: "/attachment/a", name: "file.txt" }],
		});
		state.recordAttachments(
			plan,
			attachmentResult([{ ref: "/attachment/a", name: "file.txt" }]),
		);
		state.recordText("context body", "context.txt", {
			ref: "/text/a",
			name: "context.txt",
		});
		const input = {
			prompt: "prompt",
			rm: { name: "model" },
			fileRefs: [
				{ ref: "/attachment/a", name: "file.txt" },
				{ ref: "/text/a", name: "context.txt" },
			],
		};

		await state.replay(
			baseGeminiClientConfig({ gemini_account: { accountId: "b" } }),
		);
		assert.deepEqual(state.remapInput(input).fileRefs, [
			{ ref: "/attachment/b", name: "file.txt" },
			{ ref: "/text/b", name: "context.txt" },
		]);
		await state.replay(
			baseGeminiClientConfig({ gemini_account: { accountId: "c" } }),
		);
		assert.deepEqual(state.remapInput(input).fileRefs, [
			{ ref: "/attachment/c", name: "file.txt" },
			{ ref: "/text/c", name: "context.txt" },
		]);
		assert.deepEqual(input.fileRefs, [
			{ ref: "/attachment/a", name: "file.txt" },
			{ ref: "/text/a", name: "context.txt" },
		]);
		assert.deepEqual(calls, [
			["attachments", "b", plan],
			["text", "b", "context body", "context.txt"],
			["attachments", "c", plan],
			["text", "c", "context body", "context.txt"],
		]);
	});

	test("rejects replacement ref-count changes before later recipes", async () => {
		const calls = [];
		const state = new UploadReplayState(
			failFastDelegates({
				async resolveAttachments() {
					calls.push("attachments");
					return attachmentResult([]);
				},
				async uploadTextFile() {
					calls.push("text");
					return { ref: "/text/b", name: "context.txt" };
				},
			}),
		);
		const plan = createAttachmentPlan();
		state.recordAttachments(
			plan,
			attachmentResult([{ ref: "/attachment/a", name: "file.txt" }]),
		);
		state.recordText("body", "context.txt", {
			ref: "/text/a",
			name: "context.txt",
		});
		const error = await captureError(() =>
			state.replay(
				baseGeminiClientConfig({ gemini_account: { accountId: "b" } }),
			),
		);
		assert.equal(error.code, "gemini_upload_replay_failed");
		assert.equal(error.status, 502);
		assert.match(error.message, /reference count changed/);
		assert.deepEqual(calls, ["attachments"]);
	});

	test("rejects an invalid replacement ref with the same count", async () => {
		const state = new UploadReplayState(
			failFastDelegates({
				async resolveAttachments() {
					return attachmentResult([{}]);
				},
			}),
		);
		const plan = createAttachmentPlan();
		state.recordAttachments(
			plan,
			attachmentResult([{ ref: "/attachment/a", name: "file.txt" }]),
		);
		const error = await captureError(() =>
			state.replay(
				baseGeminiClientConfig({ gemini_account: { accountId: "b" } }),
			),
		);
		assert.equal(error.code, "gemini_upload_replay_failed");
		assert.match(error.message, /reference is invalid/);
	});

	test("serializes operations and recovers the queue after rejection", async () => {
		const state = new UploadReplayState(failFastDelegates());
		const events = [];
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const first = state.serialize(async () => {
			events.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			events.push("first:reject");
			throw new Error("first failed");
		});
		const second = state.serialize(async () => {
			events.push("second:start");
			return "second result";
		});
		await firstStarted.promise;
		assert.deepEqual(events, ["first:start"]);
		releaseFirst.resolve();
		await assert.rejects(first, /first failed/);
		assert.equal(await second, "second result");
		await state.waitForPending();
		assert.deepEqual(events, ["first:start", "first:reject", "second:start"]);
	});

	test("reset clears recipes and aliases", async () => {
		let replayCalls = 0;
		const state = new UploadReplayState(
			failFastDelegates({
				async resolveAttachments() {
					replayCalls += 1;
					return attachmentResult([]);
				},
			}),
		);
		const plan = createAttachmentPlan();
		const ref = { ref: "/attachment/a", name: "file.txt" };
		state.recordAttachments(plan, attachmentResult([ref]));
		const input = { prompt: "prompt", rm: { name: "model" }, fileRefs: [ref] };
		assert.equal(state.hasOpaqueRefs(input), false);
		state.reset();
		assert.equal(state.hasOpaqueRefs(input), true);
		await state.replay(
			baseGeminiClientConfig({ gemini_account: { accountId: "b" } }),
		);
		assert.equal(replayCalls, 0);
	});
});
