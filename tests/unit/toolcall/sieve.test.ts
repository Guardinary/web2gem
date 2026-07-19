// @ts-nocheck
import { describe, test } from "vitest";
import {
	createToolSieveState,
	flushToolSieve,
	flushToolSievePlainPrefix,
	hasToolCallCloseSyntax,
	hasToolSieveSentinel,
	processToolSieveChunk,
	TOOL_SIEVE_PLAIN_TEXT_KEEP,
} from "../../../src/toolcall/sieve";
import { isPartialToolCallSyntaxPrefix } from "../../../src/toolcall/syntax-probe";
import { assert } from "../assertions.js";

const sieveState = (overrides = {}) =>
	Object.assign(createToolSieveState(), overrides);

describe("toolcall", () => {
	test("releases partial DSML sentinel when it becomes plain text", async () => {
		assert.equal(isPartialToolCallSyntaxPrefix("<|DS"), true);
		const state = createToolSieveState();
		const emitted = processToolSieveChunk(state, "hello <|DS");
		assert.deepEqual(emitted, ["hello "]);
		assert.equal(state.buffer, "<|DS");
		assert.equal(state.holdingToolCandidate, true);
		const released = processToolSieveChunk(
			state,
			" but this is not a tool tag",
		);
		assert.deepEqual(released, ["<|DS but this is not a tool tag"]);
		assert.equal(state.buffer, "");
		assert.equal(state.holdingToolCandidate, false);
	});
	test("keeps bounded plain text tail in tool sieve state", async () => {
		const state = createToolSieveState();
		const text = `a < b and parameterless prose ${"x".repeat(300)}`;
		const emitted = processToolSieveChunk(state, text);
		assert.equal(emitted.join("").length > 0, true);
		assert.equal(state.buffer.length <= 64, true);
		const flushed = flushToolSieve(state);
		assert.equal(emitted.join("") + flushed.text, text);
		assert.equal(flushed.toolCalls, null);
	});
	test("detects tool sieve sentinel and closing syntax", async () => {
		assert.equal(hasToolSieveSentinel("plain text"), false);
		assert.equal(hasToolSieveSentinel("before <tool_calls>"), true);
		assert.equal(hasToolCallCloseSyntax("</tool_calls>"), true);
	});

	test("flushes only safe plain-text prefixes", async () => {
		assert.equal(flushToolSievePlainPrefix(null), null);

		const holding = {
			buffer: "x".repeat(100),
			holdingToolCandidate: true,
			sawToolClose: false,
			parsedToolCandidate: false,
		};
		assert.equal(flushToolSievePlainPrefix(holding), null);
		assert.equal(holding.buffer.length, 100);

		const sentinel = {
			buffer: "plain <tool_calls>",
			holdingToolCandidate: false,
			sawToolClose: false,
			parsedToolCandidate: false,
		};
		assert.equal(flushToolSievePlainPrefix(sentinel), null);

		const plain = {
			buffer: "p".repeat(100),
			holdingToolCandidate: false,
			sawToolClose: false,
			parsedToolCandidate: false,
		};
		const flushedPlain = flushToolSievePlainPrefix(plain);
		assert.deepEqual(flushedPlain, [
			"p".repeat(100 - TOOL_SIEVE_PLAIN_TEXT_KEEP),
		]);
		assert.equal(plain.buffer.length, TOOL_SIEVE_PLAIN_TEXT_KEEP);
	});

	test("keeps parsed and malformed tool candidates held across empty chunks", async () => {
		const parsed = sieveState({
			buffer: '<tool_calls><invoke name="Read"></invoke></tool_calls>',
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: true,
		});
		assert.deepEqual(processToolSieveChunk(parsed, ""), []);
		assert.equal(parsed.buffer.includes("<tool_calls>"), true);

		const malformedHeld = sieveState({
			buffer: "<tool_calls><invoke></invoke></tool_calls>",
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: false,
		});
		assert.deepEqual(processToolSieveChunk(malformedHeld, ""), []);
		assert.equal(malformedHeld.buffer.includes("<tool_calls>"), true);

		const malformed = sieveState({
			buffer: "</tool_calls>",
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: false,
		});
		assert.deepEqual(processToolSieveChunk(malformed, ""), []);
		assert.equal(malformed.buffer, "</tool_calls>");
		assert.equal(malformed.holdingToolCandidate, true);
	});

	test("flushes null and plain states without tool calls", async () => {
		assert.deepEqual(flushToolSieve(null), {
			text: "",
			toolCalls: null,
		});
		assert.deepEqual(
			flushToolSieve(
				sieveState({
					buffer: "plain",
					holdingToolCandidate: false,
					sawToolClose: false,
					parsedToolCandidate: false,
				}),
			),
			{
				text: "plain",
				toolCalls: null,
			},
		);
	});
	test("holds complete DSML candidates until flush without leaking text", async () => {
		const chunkedState = createToolSieveState();
		const partialCandidate =
			'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="path">';
		assert.deepEqual(
			processToolSieveChunk(chunkedState, partialCandidate.slice(0, 32)),
			[],
		);
		assert.deepEqual(
			processToolSieveChunk(chunkedState, partialCandidate.slice(32)),
			[],
		);
		assert.equal(chunkedState.heldLength, partialCandidate.length);
		assert.equal(chunkedState.heldLength > chunkedState.buffer.length, true);

		const state = createToolSieveState();
		const candidate =
			'<|DSML|tool_calls><|DSML|invoke name="Read"><|DSML|parameter name="path"><![CDATA[README.md]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>';
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(0, 32)), []);
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(32)), []);
		assert.equal(state.parsedToolCandidateResult.calls[0].name, "Read");
		assert.equal(state.parsedToolCandidateLength, candidate.length);
		const flushed = flushToolSieve(state);
		assert.equal(flushed.toolCalls[0].name, "Read");
		assert.equal(flushed.toolCalls[0].input.path, "README.md");
	});
	test("reparses cached tool candidates when more text arrives before flush", async () => {
		const state = createToolSieveState();
		const candidate =
			'<tool_calls><invoke name="Read"><parameter name="path">README.md</parameter></invoke></tool_calls>';
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(0, 32)), []);
		assert.deepEqual(processToolSieveChunk(state, candidate.slice(32)), []);
		assert.equal(state.parsedToolCandidateResult.calls[0].name, "Read");
		assert.deepEqual(processToolSieveChunk(state, " trailing text"), []);
		const flushed = flushToolSieve(state);
		assert.equal(flushed.text, "trailing text");
		assert.equal(flushed.toolCalls[0].name, "Read");
	});
	test("releases oversized unterminated tool candidates as plain text", async () => {
		const state = createToolSieveState();
		const prefix = "<tool_calls ";
		assert.deepEqual(processToolSieveChunk(state, prefix), []);
		const oversizedTail = "x".repeat(256 * 1024 + 1);
		const emitted = processToolSieveChunk(state, oversizedTail);
		assert.equal(emitted.join(""), prefix + oversizedTail);
		assert.equal(state.buffer, "");
		assert.equal(state.holdingToolCandidate, false);
		assert.equal(state.heldLength, 0);
	});
	test("holds markdown tool-call fences until they are safe to flush", async () => {
		const state = createToolSieveState();
		const emitted = processToolSieveChunk(
			state,
			'before\n```tool_call\n{"name":"Read"',
		);
		assert.equal(emitted.join(""), "before\n");
		assert.match(state.buffer, /```tool_call/);
		const flushed = flushToolSieve(state);
		assert.match(flushed.text, /```tool_call/);
		assert.equal(flushed.toolCalls, null);
	});
	test("holds unterminated markdown tails without leaking partial code", async () => {
		const state = createToolSieveState();
		assert.deepEqual(processToolSieveChunk(state, "```js\nconst x = 1;"), []);
		assert.match(state.buffer, /```js/);

		const withPrefix = createToolSieveState();
		const emitted = processToolSieveChunk(
			withPrefix,
			"plain before\n```js\nconst x = 1;",
		);
		assert.equal(emitted.join(""), "plain before\n");
		assert.match(withPrefix.buffer, /^```js/);
	});
	test("releases markdown-protected tool-looking examples from holding state", async () => {
		const fenced = "```xml\n<tool_calls></tool_calls>\n```";
		const state = sieveState({
			buffer: fenced,
			holdingToolCandidate: true,
			sawToolClose: true,
			parsedToolCandidate: false,
		});
		const emitted = processToolSieveChunk(state, "");
		assert.equal(emitted.join(""), fenced);
		assert.equal(state.buffer, "");
		assert.equal(state.holdingToolCandidate, false);
	});
});
