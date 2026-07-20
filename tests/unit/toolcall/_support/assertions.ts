import { isRecord, type UnknownRecord } from "../../../../src/shared/types";

export function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a value");
	return value;
}

export function record(value: unknown): UnknownRecord {
	if (!isRecord(value)) throw new Error("expected an object");
	return value;
}
