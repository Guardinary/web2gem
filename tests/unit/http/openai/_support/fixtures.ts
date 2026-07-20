import {
	createRuntimeConfig,
	getConfig,
	type RuntimeConfig,
} from "../../../../../src/config";
import type { SSEWrite } from "../../../../../src/http/core/sse";
import { isRecord, type UnknownRecord } from "../../../../../src/shared/types";

export function openAIConfig(
	overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
	return { ...createRuntimeConfig(getConfig()), ...overrides };
}

export function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label} object`);
	return value;
}

export function responseError(value: unknown): UnknownRecord {
	return record(record(value, "response").error, "response error");
}

export function records(value: unknown, label: string): UnknownRecord[] {
	if (!Array.isArray(value)) throw new Error(`expected ${label} array`);
	return value.map((item, index) => record(item, `${label} ${index}`));
}

export function required<T>(
	value: T | null | undefined,
	label: string,
): NonNullable<T> {
	if (value === null || value === undefined)
		throw new Error(`${label} is required`);
	return value;
}

export function frameObjects(frames: readonly unknown[]): UnknownRecord[] {
	return frames.filter(isRecord);
}

export function writeRecorder(): { writes: string[]; write: SSEWrite } {
	const writes: string[] = [];
	return {
		writes,
		async write(chunk) {
			writes.push(chunk);
		},
	};
}
