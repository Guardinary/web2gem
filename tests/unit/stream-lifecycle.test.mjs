import { describe, test } from "vitest";
import {
	createCompletionStreamLifecycle,
	createSieveLoopContext,
	recordCompletionStreamEvent,
	streamPlainCompletionEvents,
	streamSievedTextDeltas,
	streamToolSieveCompletionEvents,
} from "../../src/completion/stream-events";
import { toolSieveBufferedText } from "../../src/toolcall/sieve";
import { assert } from "./assertions.js";
import { chunks } from "./_support/async-stream.js";

async function collectEvents(iterable) {
	const events = [];
	for await (const event of iterable) events.push(event);
	return events;
}
function abortingAsyncIterable(error) {
	return {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					throw error;
				},
			};
		},
	};
}
function streamProvider(deltas) {
	return {
		streamText() {
			return deltas;
		},
	};
}
async function consumeCompletionEvents(events, onText) {
	const lifecycle = createCompletionStreamLifecycle();
	let completionTokens = 0;
	for await (const event of events) {
		recordCompletionStreamEvent(lifecycle, event);
		if (event.type === "text_delta") onText(event.text);
		if (event.type === "done") completionTokens = event.completionTokens;
	}
	return {
		emittedText: lifecycle.emittedText,
		streamErr: lifecycle.issue?.error || null,
		errMsg: lifecycle.issue?.message || "",
		completionTokens,
		toolCalls: lifecycle.toolCalls,
		violation: lifecycle.violation,
	};
}
function consumePlainTextDeltas(deltas, onText) {
	return consumeCompletionEvents(
		streamPlainCompletionEvents(streamProvider(deltas), {
			prompt: "test",
			rm: { name: "gemini-3.5-flash" },
			fileRefs: null,
		}),
		onText,
	);
}
function consumeToolSieveTextDeltas(deltas, input, onText) {
	return consumeCompletionEvents(
		streamToolSieveCompletionEvents(streamProvider(deltas), {
			prompt: "test",
			rm: { name: "gemini-3.5-flash" },
			fileRefs: null,
			...input,
		}),
		onText,
	);
}
async function consumeSievedTextDeltas(deltas, onText) {
	const ctx = createSieveLoopContext();
	for await (const event of streamSievedTextDeltas(
		streamProvider(deltas),
		{
			prompt: "test",
			rm: { name: "gemini-3.5-flash" },
			fileRefs: null,
		},
		{},
		ctx,
	)) {
		if (event.type === "text_delta") onText(event.text);
	}
	return {
		emittedText: ctx.emittedText,
		streamErr: ctx.streamErr,
		errMsg: ctx.streamErr?.message || "",
		bufferedText: toolSieveBufferedText(ctx.state),
	};
}

describe("completion stream lifecycle", () => {
	test("reduces completion stream lifecycle events consistently", () => {
		const lifecycle = createCompletionStreamLifecycle();
		const failure = new Error("late failure");
		const toolCalls = [
			{
				id: "call_1",
				type: "function",
				function: { name: "x", arguments: "{}" },
			},
		];
		for (const event of [
			{ type: "text_delta", text: "partial" },
			{ type: "tool_calls", toolCalls },
			{ type: "warning", error: failure, message: "late failure" },
			{
				type: "done",
				emittedText: true,
				completionTokens: 2,
				completionCounts: { ascii: 7, nonAscii: 0, hasText: true },
			},
		])
			recordCompletionStreamEvent(lifecycle, event);
		assert.equal(lifecycle.emittedText, true);
		assert.equal(lifecycle.empty, false);
		assert.equal(lifecycle.issue.error, failure);
		assert.deepEqual(lifecycle.toolCalls, toolCalls);
		assert.deepEqual(lifecycle.completionCounts, {
			ascii: 7,
			nonAscii: 0,
			hasText: true,
		});

		const emptyLifecycle = createCompletionStreamLifecycle();
		recordCompletionStreamEvent(emptyLifecycle, { type: "empty" });
		assert.equal(emptyLifecycle.empty, true);
		assert.equal(emptyLifecycle.emittedText, false);
	});
	test("emits plain text deltas and token counts", async () => {
		const emitted = [];
		const result = await consumePlainTextDeltas(
			chunks(["hello", "", " world"]),
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["hello", " world"]);
		assert.equal(result.emittedText, true);
		assert.equal(result.streamErr, null);
		assert.equal(result.completionTokens > 0, true);
	});
	test("preserves emitted deltas when stream later errors", async () => {
		const emitted = [];
		const result = await consumePlainTextDeltas(
			chunks(["partial"], 0),
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["partial"]);
		assert.equal(result.emittedText, true);
		assert.equal(result.errMsg, "stream broke");
	});
	test("streams plain completion events while skipping empty deltas", async () => {
		const emptyTextObject = {
			toString() {
				return "";
			},
		};
		const events = await collectEvents(
			streamPlainCompletionEvents(
				streamProvider(chunks([null, emptyTextObject, "ok"])),
				{
					prompt: "plain prompt",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
				},
			),
		);
		assert.deepEqual(
			events.map((event) => event.type),
			["text_delta", "done"],
		);
		assert.equal(events[0].text, "ok");

		const plainAbort = new Error("plain abort");
		plainAbort.name = "AbortError";
		await assert.rejects(
			() =>
				collectEvents(
					streamPlainCompletionEvents(
						streamProvider(abortingAsyncIterable(plainAbort)),
						{
							prompt: "plain prompt",
							rm: { name: "gemini-3.5-flash" },
							fileRefs: null,
						},
					),
				),
			/plain abort/,
		);
	});
	test("preserves provider delta boundaries before reporting stream errors", async () => {
		async function* brokenDeltas() {
			yield "a";
			yield "b";
			throw new Error("coalesced stream broke");
		}
		const events = await collectEvents(
			streamPlainCompletionEvents(streamProvider(brokenDeltas()), {
				prompt: "plain prompt",
				rm: { name: "gemini-3.5-flash" },
				fileRefs: null,
			}),
		);
		assert.deepEqual(
			events
				.filter((event) => event.type === "text_delta")
				.map((event) => event.text),
			["a", "b"],
		);
		assert.equal(
			events.some((event) => event.type === "warning"),
			true,
		);
	});
	test("captures tool-sieve stream errors and preserves buffered visible text", async () => {
		async function* brokenToolDeltas() {
			yield "<tool_calls>";
			throw new Error("tool stream broke");
		}
		const emitted = [];
		const result = await consumeToolSieveTextDeltas(
			brokenToolDeltas(),
			{
				tools: null,
				toolPolicy: null,
			},
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["<tool_calls>"]);
		assert.equal(result.emittedText, true);
		assert.equal(result.streamErr.message, "tool stream broke");
		assert.equal(result.errMsg, "tool stream broke");

		const toolAbort = new Error("tool abort");
		toolAbort.code = "request_aborted";
		await assert.rejects(
			() =>
				consumeToolSieveTextDeltas(
					abortingAsyncIterable(toolAbort),
					{ tools: null, toolPolicy: null },
					() => {},
				),
			/tool abort/,
		);
	});
	test("streams tool-sieve text deltas and buffered text boundaries", async () => {
		const longText = "x".repeat(100);
		const toolEvents = await collectEvents(
			streamToolSieveCompletionEvents(streamProvider(chunks([longText])), {
				prompt: "tool prompt",
				rm: { name: "gemini-3.5-flash" },
				fileRefs: null,
				tools: null,
				toolPolicy: null,
			}),
		);
		assert.equal(
			toolEvents
				.filter((event) => event.type === "text_delta")
				.map((event) => event.text)
				.join(""),
			longText,
		);
		assert.equal(toolEvents.at(-1).type, "done");

		const bufferedCtx = createSieveLoopContext();
		const bufferedEvents = await collectEvents(
			streamSievedTextDeltas(
				streamProvider(chunks([longText])),
				{
					prompt: "buffered prompt",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
				},
				{},
				bufferedCtx,
			),
		);
		assert.deepEqual(
			bufferedEvents.map((event) => event.type),
			["text_delta"],
		);
		assert.equal(
			bufferedEvents[0].text + toolSieveBufferedText(bufferedCtx.state),
			longText,
		);

		const emptyCtx = createSieveLoopContext();
		const emptyBuffered = await collectEvents(
			streamSievedTextDeltas(
				streamProvider(chunks([])),
				{
					prompt: "empty buffered prompt",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
				},
				{},
				emptyCtx,
			),
		);
		assert.deepEqual(emptyBuffered, []);
		assert.equal(emptyCtx.emittedText, false);
		assert.equal(toolSieveBufferedText(emptyCtx.state), "");

		const splitHeldCandidate = [
			'<tool_calls><invoke name="Read"><parameter name="path">',
			"README.md",
		];
		const splitCtx = createSieveLoopContext();
		const splitBufferedEvents = await collectEvents(
			streamSievedTextDeltas(
				streamProvider(chunks(splitHeldCandidate)),
				{
					prompt: "split buffered prompt",
					rm: { name: "gemini-3.5-flash" },
					fileRefs: null,
				},
				{},
				splitCtx,
			),
		);
		assert.deepEqual(splitBufferedEvents, []);
		assert.equal(
			toolSieveBufferedText(splitCtx.state),
			splitHeldCandidate.join(""),
		);
	});
	test("summarizes buffered tool text streams across success error and abort paths", async () => {
		const emitted = [];
		const longText = "y".repeat(100);
		const summary = await consumeSievedTextDeltas(chunks([longText]), (text) =>
			emitted.push(text),
		);
		assert.equal(summary.emittedText, true);
		assert.equal(summary.streamErr, null);
		assert.equal(emitted.join("") + summary.bufferedText, longText);

		const errored = [];
		const errorSummary = await consumeSievedTextDeltas(
			chunks([longText], 0),
			(text) => errored.push(text),
		);
		assert.equal(errorSummary.emittedText, true);
		assert.equal(errorSummary.errMsg, "stream broke");
		assert.equal(errorSummary.streamErr.message, "stream broke");
		assert.equal(errored.join("") + errorSummary.bufferedText, longText);

		const splitHeldCandidate = [
			'<tool_calls><invoke name="Read"><parameter name="path">',
			"README.md",
		];
		const splitSummary = await consumeSievedTextDeltas(
			chunks(splitHeldCandidate),
			() => {},
		);
		assert.equal(splitSummary.bufferedText, splitHeldCandidate.join(""));

		const bufferAbort = new Error("buffer abort");
		bufferAbort.name = "AbortError";
		await assert.rejects(
			() =>
				consumeSievedTextDeltas(abortingAsyncIterable(bufferAbort), () => {}),
			/buffer abort/,
		);
	});
	test("sieves DSML tool calls out of streamed text", async () => {
		const emitted = [];
		const [prefix, suffix] = [
			'before <|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="file_path"><![CDATA[',
			"README.md]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>",
		];
		const result = await consumeToolSieveTextDeltas(
			chunks([prefix, suffix]),
			{
				tools: [
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				toolPolicy: null,
			},
			(text) => emitted.push(text),
		);
		assert.deepEqual(emitted, ["before "]);
		assert.equal(Array.isArray(result.toolCalls), true);
		assert.equal(result.toolCalls[0].name, "Read");
		assert.equal(result.violation, null);
	});
	test("reports required tool choice violation for plain output", async () => {
		const result = await consumeToolSieveTextDeltas(
			chunks(["plain answer"]),
			{
				tools: [
					{
						type: "function",
						function: { name: "Read", parameters: { type: "object" } },
					},
				],
				toolPolicy: {
					mode: "required",
					forcedName: "",
					allowed: null,
					hasAllowed: false,
					declared: ["Read"],
					error: "",
				},
			},
			() => {},
		);
		assert.equal(result.toolCalls, null);
		assert.equal(result.violation.code, "tool_choice_violation");
	});
});
