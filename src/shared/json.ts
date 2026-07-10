import type { UnknownRecord } from "./types";

export type JsonParseResult =
	| { ok: true; value: unknown }
	| { ok: false; value: undefined };

export function tryParseJson(text: string): JsonParseResult {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (_) {
		return { ok: false, value: undefined };
	}
}

export function parseJson<T = unknown>(
	text: string,
	fallback: T | null = null,
): unknown | T | null {
	const parsed = tryParseJson(text);
	return parsed.ok ? parsed.value : fallback;
}

export function parseJsonObject(text: string): UnknownRecord {
	const value = parseJson(text, {});
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as UnknownRecord)
		: {};
}
