import { isAbortError } from "../shared/abort";
import type { TokenCharCounts, TokenCounter } from "../shared/tokens";
import { createTokenCounter, emptyTokenCounts } from "../shared/tokens";
import type { ParsedToolCall } from "../toolcall/dsml";
import type {
	ToolChoicePolicy,
	ToolPolicyViolation,
} from "../toolcall/policy-openai";
import { validateRequiredToolCalls } from "../toolcall/policy-openai";
import type { ToolSieveState } from "../toolcall/sieve";
import {
	createToolSieveState,
	flushToolSieve,
	processToolSieveChunk,
} from "../toolcall/sieve";
import type {
	CompletionProvider,
	CompletionProviderOptions,
	CompletionTextInput,
} from "./ports";

export type GeminiCompletionInput = CompletionTextInput;

function completionTextDeltas(
	provider: CompletionProvider,
	input: CompletionTextInput,
	options: CompletionProviderOptions,
): AsyncIterable<string> {
	const providerOptions: CompletionProviderOptions = {};
	if (options.signal) providerOptions.signal = options.signal;
	return provider.streamText(input, providerOptions);
}

export type CompletionStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_calls"; toolCalls: ParsedToolCall[] }
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
	toolCalls: ParsedToolCall[] | null;
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

export async function* streamPlainCompletionEvents(
	provider: CompletionProvider,
	input: GeminiCompletionInput,
	options: CompletionProviderOptions = {},
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

export type SieveLoopContext = {
	state: ToolSieveState;
	counter: TokenCounter;
	emittedText: boolean;
	streamErr: unknown;
};

export function createSieveLoopContext(): SieveLoopContext {
	return {
		state: createToolSieveState(),
		counter: createTokenCounter(),
		emittedText: false,
		streamErr: null,
	};
}

/**
 * Shared sieve delta loop for both dialects: pipes provider deltas through the
 * tool sieve and yields released text as text_delta events only. Held tail
 * text, error state, and token counts are exposed on the caller's ctx; the
 * caller owns the per-dialect flush tail.
 */
export async function* streamSievedTextDeltas(
	provider: CompletionProvider,
	input: GeminiCompletionInput,
	options: CompletionProviderOptions,
	ctx: SieveLoopContext,
): AsyncIterable<CompletionStreamEvent> {
	try {
		for await (const deltaText of completionTextDeltas(
			provider,
			input,
			options,
		)) {
			for (const text of processToolSieveChunk(ctx.state, deltaText)) {
				if (!text) continue;
				ctx.emittedText = true;
				ctx.counter.append(text);
				yield { type: "text_delta", text };
			}
		}
	} catch (e) {
		if (isAbortError(e)) throw e;
		ctx.streamErr = e;
	}
}

export async function* streamToolSieveCompletionEvents(
	provider: CompletionProvider,
	input: GeminiCompletionInput & {
		toolPolicy?: ToolChoicePolicy | null | undefined;
	},
	options: CompletionProviderOptions = {},
): AsyncIterable<CompletionStreamEvent> {
	const ctx = createSieveLoopContext();
	yield* streamSievedTextDeltas(provider, input, options, ctx);

	const flushed = flushToolSieve(ctx.state);
	if (flushed.text) {
		ctx.emittedText = true;
		ctx.counter.append(flushed.text);
		yield { type: "text_delta", text: flushed.text };
	}
	const toolCalls = flushed.toolCalls;
	const violation = validateRequiredToolCalls(input.toolPolicy, toolCalls);

	if (ctx.streamErr)
		yield streamErrorEvent(
			ctx.streamErr,
			ctx.emittedText || !!toolCalls?.length,
		);
	if (violation) yield { type: "tool_policy_violation", violation };
	if (toolCalls?.length) yield { type: "tool_calls", toolCalls };
	if (!ctx.streamErr && !ctx.emittedText && !toolCalls?.length)
		yield { type: "empty" };
	yield {
		type: "done",
		emittedText: ctx.emittedText,
		completionTokens: ctx.counter.tokens(),
		completionCounts: ctx.counter.counts(),
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
