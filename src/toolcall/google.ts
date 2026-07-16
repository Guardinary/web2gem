import {
	normalizeParsedToolCallsForSchemas,
	parseDSMLToolCallsDetailed,
} from "./parse";
import type { ToolBundle } from "./tool-bundle";

type GoogleParsedToolCall = { name?: unknown; input?: unknown };
export type GoogleFunctionCall = { name: unknown; args: unknown };

function normalizeGoogleParsedCalls(
	calls: GoogleParsedToolCall[],
	tools: ToolBundle | null | undefined,
): GoogleParsedToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, tools);
	return Array.isArray(normalized)
		? (normalized as GoogleParsedToolCall[])
		: calls;
}

function toGoogleFunctionCalls(
	calls: GoogleParsedToolCall[],
): GoogleFunctionCall[] {
	return calls.map((call) => ({ name: call.name, args: call.input || {} }));
}

/** Extract DSML/XML tool-call blocks -> [cleanText, functionCalls]. */
export function parseGoogleFunctionCalls(
	text: unknown,
	tools: ToolBundle | null | undefined,
): [string, GoogleFunctionCall[]] {
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		const normalized = normalizeGoogleParsedCalls(parsed.calls, tools);
		return [parsed.cleanText, toGoogleFunctionCalls(normalized)];
	}
	return [String(text || ""), []];
}
