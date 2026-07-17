import { parseDSMLToolCallsDetailed, type ParsedToolCall } from "./dsml";
import { normalizeParsedToolCallsForSchemas } from "./schema-normalize";
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

export function formatGoogleFunctionCalls(
	calls: ParsedToolCall[] | null | undefined,
	tools: ToolBundle | null | undefined,
): GoogleFunctionCall[] {
	if (!calls?.length) return [];
	return toGoogleFunctionCalls(normalizeGoogleParsedCalls(calls, tools));
}

/** Extract DSML/XML tool-call blocks -> [cleanText, functionCalls]. */
export function parseGoogleFunctionCalls(
	text: unknown,
	tools: ToolBundle | null | undefined,
): [string, GoogleFunctionCall[]] {
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		return [parsed.cleanText, formatGoogleFunctionCalls(parsed.calls, tools)];
	}
	return [String(text || ""), []];
}
