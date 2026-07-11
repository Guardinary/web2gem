import { streamBufferedToolTextCompletionEvents } from "./runtime";
import type { CompletionProvider } from "./ports";
import type { ResolvedModel } from "../models";
import {
	combinedTokenCount,
	createTokenCounter,
	emptyTokenCounts,
} from "../shared/tokens";
import { parseGoogleFunctionCalls } from "../toolcall/google";
import { validateGoogleFunctionCalls } from "../toolcall/policy-google";
import type { ToolPolicyViolation } from "../toolcall/policy-openai";
import type { GoogleFunctionCall } from "../toolcall/google";
import type { GoogleResponsePart } from "./google-turn";
import type { FileRef, LooseRequest } from "./types";
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
	tools: LooseRequest[] | null;
	effectiveReq: LooseRequest;
	promptTokens: number;
	signal: AbortSignal;
};

export async function* streamGoogleToolCompletionEvents(
	provider: CompletionProvider,
	params: GoogleToolCompletionParams,
): AsyncIterable<GoogleToolCompletionEvent> {
	const { prompt, rm, fileRefs, tools, effectiveReq, promptTokens, signal } =
		params;
	const extraTokenCounter = createTokenCounter();
	let completionCounts = emptyTokenCounts();
	let buffered = "";
	let emittedText = false;
	let issue: { error: unknown } | null = null;

	for await (const event of streamBufferedToolTextCompletionEvents(
		provider,
		{ prompt, rm, fileRefs },
		{ signal },
	)) {
		if (event.type === "text_delta") {
			emittedText = true;
			yield {
				type: "candidate",
				parts: [{ text: event.text }],
				finishReason: null,
			};
		} else if (event.type === "buffered_text") {
			buffered += event.text;
		} else if (event.type === "warning" || event.type === "stream_error") {
			issue = event;
		} else if (event.type === "done") {
			completionCounts = event.completionCounts;
		}
	}

	const [clean, functionCalls]: [string, GoogleFunctionCall[]] =
		parseGoogleFunctionCalls(buffered, tools);
	if (clean) {
		extraTokenCounter.append(clean);
		yield { type: "candidate", parts: [{ text: clean }], finishReason: null };
	}

	const violation = validateGoogleFunctionCalls(effectiveReq, functionCalls);
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
	} else if (!emittedText && !clean) {
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
		completionCounts,
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
