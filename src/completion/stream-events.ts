import { createTokenCounter, emptyTokenCounts } from "../shared/tokens";
import type { TokenCharCounts } from "../shared/tokens";
import { isAbortError } from "../shared/runtime";
import {
	createToolSieveState,
	flushToolSieve,
	processToolSieveChunk,
	toolSieveBufferedText,
} from "../toolstream";
import { validateRequiredToolCalls } from "../toolcall/policy-openai";
import type { CompletionProvider, CompletionTextInput } from "./ports";
import type { OpenAIToolCall } from "../toolcall/openai-format";
import type {
	ToolChoicePolicy,
	ToolPolicyViolation,
} from "../toolcall/policy-openai";
import { completionTextDeltas } from "./stream-coalesce";
import type { StreamConsumeInternalOptions } from "./stream-coalesce";

export type GeminiCompletionInput = CompletionTextInput;

export type PlainStreamSummary = {
	emittedText: boolean;
	streamErr: unknown;
	errMsg: string;
	completionTokens: number;
};

export type ToolSieveStreamSummary = PlainStreamSummary & {
	toolCalls: OpenAIToolCall[] | null;
	violation: ToolPolicyViolation | null;
};

export type BufferedToolTextStreamSummary = PlainStreamSummary & {
	bufferedText: string;
};

export type CompletionStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "buffered_text"; text: string }
	| { type: "tool_calls"; toolCalls: OpenAIToolCall[] }
	| { type: "tool_policy_violation"; violation: ToolPolicyViolation }
	| { type: "warning"; error: unknown; message: string }
	| { type: "stream_error"; error: unknown; message: string }
	| { type: "empty" }
	| {
			type: "done";
			emittedText: boolean;
			completionTokens: number;
			completionCounts: TokenCharCounts & { hasText: boolean };
	  };

export type CompletionStreamLifecycle = {
	emittedText: boolean;
	empty: boolean;
	issue: Extract<
		CompletionStreamEvent,
		{ type: "warning" } | { type: "stream_error" }
	> | null;
	toolCalls: OpenAIToolCall[] | null;
	violation: ToolPolicyViolation | null;
	completionCounts: TokenCharCounts & { hasText: boolean };
};

export function createCompletionStreamLifecycle(): CompletionStreamLifecycle {
	return {
		emittedText: false,
		empty: false,
		issue: null,
		toolCalls: null,
		violation: null,
		completionCounts: emptyTokenCounts(),
	};
}

export function recordCompletionStreamEvent(
	lifecycle: CompletionStreamLifecycle,
	event: CompletionStreamEvent,
): void {
	switch (event.type) {
		case "text_delta":
		case "buffered_text":
			lifecycle.emittedText ||= !!event.text;
			break;
		case "warning":
		case "stream_error":
			lifecycle.issue = event;
			break;
		case "tool_calls":
			lifecycle.toolCalls = event.toolCalls;
			break;
		case "tool_policy_violation":
			lifecycle.violation = event.violation;
			break;
		case "empty":
			lifecycle.empty = true;
			break;
		case "done":
			lifecycle.emittedText ||= event.emittedText;
			lifecycle.completionCounts = event.completionCounts;
	}
}

export async function consumePlainTextDeltas(
	deltas: AsyncIterable<unknown>,
	onText: (text: string) => void,
): Promise<PlainStreamSummary> {
	let emittedText = false;
	let errMsg = "";
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const delta of deltas) {
			if (!delta) continue;
			const text = String(delta);
			if (!text) continue;
			emittedText = true;
			completionTokenCounter.append(text);
			onText(text);
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
		errMsg = errorMessage(e);
	}

	return {
		emittedText,
		streamErr,
		errMsg,
		completionTokens: completionTokenCounter.tokens(),
	};
}

export async function* streamPlainCompletionEvents(
	provider: CompletionProvider,
	input: GeminiCompletionInput,
	options: StreamConsumeInternalOptions = {},
): AsyncIterable<CompletionStreamEvent> {
	let emittedText = false;
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const delta of completionTextDeltas(provider, input, options)) {
			if (!delta) continue;
			const text = String(delta);
			if (!text) continue;
			emittedText = true;
			completionTokenCounter.append(text);
			yield { type: "text_delta", text };
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
	}

	if (streamErr) {
		yield streamErrorEvent(streamErr, emittedText);
	} else if (!emittedText) {
		yield { type: "empty" };
	}
	yield {
		type: "done",
		emittedText,
		completionTokens: completionTokenCounter.tokens(),
		completionCounts: completionTokenCounter.counts(),
	};
}

export async function consumeToolSieveTextDeltas(
	deltas: AsyncIterable<unknown>,
	input: {
		tools: unknown;
		toolPolicy?: ToolChoicePolicy | null | undefined;
	},
	onText: (text: string) => void,
): Promise<ToolSieveStreamSummary> {
	const state = createToolSieveState();
	let emittedText = false;
	let errMsg = "";
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const deltaText of deltas) {
			for (const text of processToolSieveChunk(state, deltaText)) {
				if (!text) continue;
				emittedText = true;
				completionTokenCounter.append(text);
				onText(text);
			}
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
		errMsg = errorMessage(e);
	}

	const flushed = flushToolSieve(state, input.tools);
	if (flushed.text) {
		emittedText = true;
		completionTokenCounter.append(flushed.text);
		onText(flushed.text);
	}
	const toolCalls = flushed.toolCalls;
	const violation = validateRequiredToolCalls(input.toolPolicy, toolCalls);
	return {
		emittedText,
		streamErr,
		errMsg,
		completionTokens: completionTokenCounter.tokens(),
		toolCalls,
		violation,
	};
}

export async function* streamToolSieveCompletionEvents(
	provider: CompletionProvider,
	input: GeminiCompletionInput & {
		tools: unknown;
		toolPolicy?: ToolChoicePolicy | null | undefined;
	},
	options: StreamConsumeInternalOptions = {},
): AsyncIterable<CompletionStreamEvent> {
	const state = createToolSieveState();
	let emittedText = false;
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const deltaText of completionTextDeltas(
			provider,
			input,
			options,
		)) {
			for (const text of processToolSieveChunk(state, deltaText)) {
				if (!text) continue;
				emittedText = true;
				completionTokenCounter.append(text);
				yield { type: "text_delta", text };
			}
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
	}

	const flushed = flushToolSieve(state, input.tools);
	if (flushed.text) {
		emittedText = true;
		completionTokenCounter.append(flushed.text);
		yield { type: "text_delta", text: flushed.text };
	}
	const toolCalls = flushed.toolCalls;
	const violation = validateRequiredToolCalls(input.toolPolicy, toolCalls);

	if (streamErr)
		yield streamErrorEvent(streamErr, emittedText || !!toolCalls?.length);
	if (violation) yield { type: "tool_policy_violation", violation };
	if (toolCalls?.length) yield { type: "tool_calls", toolCalls };
	if (!streamErr && !emittedText && !toolCalls?.length) yield { type: "empty" };
	yield {
		type: "done",
		emittedText,
		completionTokens: completionTokenCounter.tokens(),
		completionCounts: completionTokenCounter.counts(),
	};
}

export async function consumeBufferedToolTextDeltas(
	deltas: AsyncIterable<unknown>,
	onText: (text: string) => void,
): Promise<BufferedToolTextStreamSummary> {
	const state = createToolSieveState();
	let emittedText = false;
	let errMsg = "";
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const deltaText of deltas) {
			for (const text of processToolSieveChunk(state, deltaText)) {
				if (!text) continue;
				emittedText = true;
				completionTokenCounter.append(text);
				onText(text);
			}
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
		errMsg = errorMessage(e);
	}

	const bufferedText = toolSieveBufferedText(state);
	return {
		emittedText,
		streamErr,
		errMsg,
		completionTokens: completionTokenCounter.tokens(),
		bufferedText,
	};
}

export async function* streamBufferedToolTextCompletionEvents(
	provider: CompletionProvider,
	input: GeminiCompletionInput,
	options: StreamConsumeInternalOptions = {},
): AsyncIterable<CompletionStreamEvent> {
	const state = createToolSieveState();
	let emittedText = false;
	let streamErr: unknown = null;
	const completionTokenCounter = createTokenCounter();

	try {
		for await (const deltaText of completionTextDeltas(
			provider,
			input,
			options,
		)) {
			for (const text of processToolSieveChunk(state, deltaText)) {
				if (!text) continue;
				emittedText = true;
				completionTokenCounter.append(text);
				yield { type: "text_delta", text };
			}
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		streamErr = e;
	}

	const bufferedText = toolSieveBufferedText(state);
	if (bufferedText) yield { type: "buffered_text", text: bufferedText };
	if (streamErr) {
		yield streamErrorEvent(streamErr, emittedText);
	} else if (!emittedText && !bufferedText) {
		yield { type: "empty" };
	}
	yield {
		type: "done",
		emittedText,
		completionTokens: completionTokenCounter.tokens(),
		completionCounts: completionTokenCounter.counts(),
	};
}

function streamErrorEvent(
	error: unknown,
	afterPartialOutput: boolean,
): CompletionStreamEvent {
	return {
		type: afterPartialOutput ? "warning" : "stream_error",
		error,
		message: errorMessage(error),
	};
}

function errorMessage(error: unknown): string {
	return String(
		error && typeof error === "object" && "message" in error
			? (error as { message?: unknown }).message
			: error,
	);
}
