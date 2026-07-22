import { isRecord, type UnknownRecord } from "../../../../src/shared/types";

export function record(value: unknown, label: string): UnknownRecord {
	if (!isRecord(value)) throw new Error(`expected ${label}`);
	return value;
}

export function errorBody(value: unknown): UnknownRecord {
	return record(record(value, "response body").error, "error body");
}
