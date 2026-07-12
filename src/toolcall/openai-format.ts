import { randHex } from "../shared/crypto";
import { normalizeParsedToolCallsForSchemas } from "./schema-normalize";

type NormalizedToolCall = {
	name: unknown;
	input?: unknown;
};
export type OpenAIToolCall = {
	id: string;
	type: "function";
	function: { name: unknown; arguments: string };
};
export type OpenAIStreamToolCall = OpenAIToolCall & { index: number };

export function formatOpenAIToolCalls(
	calls: unknown,
	toolsRaw: unknown,
): OpenAIToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
	if (!Array.isArray(normalized)) return [];
	return normalized
		.map((c: NormalizedToolCall, idx: number) => ({
			id: `call_${randHex(8)}`,
			type: "function" as const,
			function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
			index: idx,
		}))
		.map(({ index: _index, ...tc }) => tc);
}

export function formatOpenAIStreamToolCalls(
	calls: unknown,
	idStore: Map<number, string> | null | undefined,
	toolsRaw: unknown,
): OpenAIStreamToolCall[] {
	const normalized = normalizeParsedToolCallsForSchemas(calls, toolsRaw);
	if (!Array.isArray(normalized) || !normalized.length) return [];
	return normalized.map((c: NormalizedToolCall, idx: number) => ({
		index: idx,
		id: ensureStreamToolCallID(idStore, idx),
		type: "function" as const,
		function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
	}));
}

export function ensureStreamToolCallID(
	idStore: Map<number, string> | null | undefined,
	index: unknown,
): string {
	if (!(idStore instanceof Map)) return `call_${randHex(32)}`;
	const key = Number.isInteger(index) ? Number(index) : 0;
	const existing = idStore.get(key);
	if (existing) return existing;
	const next = `call_${randHex(32)}`;
	idStore.set(key, next);
	return next;
}
