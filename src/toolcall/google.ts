import {
	normalizeParsedToolCallsForSchemas,
	parseDSMLToolCallsDetailed,
} from "./parse";

type GoogleParsedToolCall = { name?: unknown; input?: unknown };
export type GoogleFunctionCall = { name: unknown; args: unknown };

function normalizeGoogleParsedCalls(
	calls: GoogleParsedToolCall[],
	toolsRaw: unknown,
): GoogleParsedToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
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
	toolsRaw: unknown,
): [string, GoogleFunctionCall[]] {
	const parsed = parseDSMLToolCallsDetailed(text);
	if (parsed.calls.length) {
		const normalized = normalizeGoogleParsedCalls(parsed.calls, toolsRaw);
		return [parsed.cleanText, toGoogleFunctionCalls(normalized)];
	}
	return [String(text || ""), []];
}
