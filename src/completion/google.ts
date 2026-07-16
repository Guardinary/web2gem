import type { CompletionProvider } from "./ports";
import type { ResolvedModel } from "../models";
import { combinedTokenCount, createTokenCounter } from "../shared/tokens";
import { parseGoogleFunctionCalls } from "../toolcall/google";
import { validateGoogleToolPolicyCalls } from "../toolcall/policy-google";
import type {
	ToolChoicePolicy,
	ToolPolicyViolation,
} from "../toolcall/policy-openai";
import type { GoogleFunctionCall } from "../toolcall/google";
import type { ToolBundle } from "../toolcall/tool-bundle";
import { toolSieveBufferedText } from "../toolstream";
import {
	createSieveLoopContext,
	streamSievedTextDeltas,
} from "./stream-events";
import type { FileRef } from "./types";
import type { GoogleResponsePart } from "./turn";
import { EMPTY_UPSTREAM_MSG } from "./turn";

export type GoogleToolCompletionEvent =
	| {
			type: "candidate";
			parts: GoogleResponsePart[] | null;
			finishReason: string | null;
	  }
	| { type: "warning"; error: unknown; message?: string }
	| { type: "error"; error: unknown }
	| { type: "tool_policy_violation"; violation: ToolPolicyViolation }
	| {
			type: "done";
			usageMetadata: {
				promptTokenCount: number;
				candidatesTokenCount: number;
				totalTokenCount: number;
			};
	  };

type GoogleToolCompletionParams = {
	prompt: string;
	rm: Extract<ResolvedModel, { name: string }>;
	fileRefs: FileRef[] | null;
	tools: ToolBundle | null;
	toolPolicy: ToolChoicePolicy | null | undefined;
	promptTokens: number;
	signal: AbortSignal;
};

export async function* streamGoogleToolCompletionEvents(
	provider: CompletionProvider,
	params: GoogleToolCompletionParams,
): AsyncIterable<GoogleToolCompletionEvent> {
	const { prompt, rm, fileRefs, tools, toolPolicy, promptTokens, signal } =
		params;
	const extraTokenCounter = createTokenCounter();
	const ctx = createSieveLoopContext();

	for await (const event of streamSievedTextDeltas(
		provider,
		{ prompt, rm, fileRefs },
		{ signal },
		ctx,
	)) {
		if (event.type === "text_delta") {
			yield {
				type: "candidate",
				parts: [{ text: event.text }],
				finishReason: null,
			};
		}
	}
	const issue = ctx.streamErr ? { error: ctx.streamErr } : null;

	const [clean, functionCalls]: [string, GoogleFunctionCall[]] =
		parseGoogleFunctionCalls(toolSieveBufferedText(ctx.state), tools);
	if (clean) {
		extraTokenCounter.append(clean);
		yield { type: "candidate", parts: [{ text: clean }], finishReason: null };
	}

	const violation = validateGoogleToolPolicyCalls(toolPolicy, functionCalls);
	if (violation) {
		yield { type: "tool_policy_violation", violation };
		return;
	}
	if (functionCalls?.length) {
		if (issue) yield { type: "warning", error: issue.error };
		yield {
			type: "candidate",
			parts: functionCalls.map((fc) => ({
				functionCall: { name: fc.name, args: fc.args || {} },
			})),
			finishReason: null,
		};
	} else if (!ctx.emittedText && !clean) {
		yield {
			type: "error",
			error: issue?.error || {
				message: EMPTY_UPSTREAM_MSG,
				code: "upstream_empty",
			},
		};
		return;
	} else if (issue) {
		yield { type: "warning", error: issue.error };
	}
	const candidateTokens = combinedTokenCount(
		ctx.counter.counts(),
		extraTokenCounter,
	);
	const promptTokenCount = Math.max(0, Number(promptTokens) || 0);
	yield {
		type: "done",
		usageMetadata: {
			promptTokenCount,
			candidatesTokenCount: candidateTokens,
			totalTokenCount: promptTokenCount + candidateTokens,
		},
	};
}
