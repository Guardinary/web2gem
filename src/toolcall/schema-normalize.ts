import { isRecord } from "../shared/types";
import type { UnknownRecord } from "../shared/types";
import type { ToolBundle } from "./tool-bundle";

type ParsedToolCall = UnknownRecord & { name?: unknown; input?: unknown };
type ArraySchemaRecord = UnknownRecord & { items?: unknown };

export function normalizeParsedToolCallsForSchemas(
	calls: ParsedToolCall[],
	tools: ToolBundle | null | undefined,
): ParsedToolCall[];
export function normalizeParsedToolCallsForSchemas(
	calls: unknown,
	tools: ToolBundle | null | undefined,
): unknown;
export function normalizeParsedToolCallsForSchemas(
	calls: unknown,
	tools: ToolBundle | null | undefined,
): unknown {
	if (!Array.isArray(calls) || !calls.length) return calls;
	const schemas = tools ? tools.schemaIndex : null;
	if (!schemas) return calls;
	let changedAny = false;
	const out = calls.map((call) => {
		if (!isRecord(call)) return call;
		const name = String(call.name || "")
			.trim()
			.toLowerCase();
		const schema = schemas[name];
		if (!schema || !isRecord(call.input)) return call;
		const [normalized, changed] = normalizeToolValueWithSchema(
			call.input,
			schema,
		);
		if (!changed || !isRecord(normalized)) return call;
		changedAny = true;
		return { ...call, input: normalized };
	});
	return changedAny ? out : calls;
}

function normalizeToolValueWithSchema(
	value: unknown,
	schema: unknown,
): [unknown, boolean] {
	if (value == null || !isRecord(schema)) return [value, false];
	if (shouldCoerceSchemaToString(schema)) return stringifySchemaValue(value);
	if (looksLikeObjectSchema(schema)) {
		if (!isRecord(value)) return [value, false];
		const properties = isRecord(schema.properties) ? schema.properties : null;
		const additional = schema.additionalProperties;
		let changed = false;
		const out: UnknownRecord = {};
		for (const [key, current] of Object.entries(value)) {
			let next = current;
			let fieldChanged = false;
			if (properties && Object.hasOwn(properties, key))
				[next, fieldChanged] = normalizeToolValueWithSchema(
					current,
					properties[key],
				);
			else if (additional != null)
				[next, fieldChanged] = normalizeToolValueWithSchema(
					current,
					additional,
				);
			out[key] = next;
			changed = changed || fieldChanged;
		}
		return changed ? [out, true] : [value, false];
	}
	if (looksLikeArraySchema(schema)) {
		const itemsSchema = schema.items;
		if (!Array.isArray(value) || !value.length || itemsSchema == null)
			return [value, false];
		let changed = false;
		const out = value.map((item, idx) => {
			const itemSchema = Array.isArray(itemsSchema)
				? itemsSchema[idx]
				: itemsSchema;
			if (itemSchema == null) return item;
			const [next, itemChanged] = normalizeToolValueWithSchema(
				item,
				itemSchema,
			);
			changed = changed || itemChanged;
			return next;
		});
		return changed ? [out, true] : [value, false];
	}
	return [value, false];
}

function shouldCoerceSchemaToString(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (typeof schema.const === "string") return true;
	if (
		Array.isArray(schema.enum) &&
		schema.enum.length &&
		schema.enum.every((item) => typeof item === "string")
	)
		return true;
	if (typeof schema.type === "string")
		return schema.type.trim().toLowerCase() === "string";
	if (Array.isArray(schema.type) && schema.type.length) {
		let hasString = false;
		for (const item of schema.type) {
			if (typeof item !== "string") return false;
			const typ = item.trim().toLowerCase();
			if (typ === "string") hasString = true;
			else if (typ !== "null") return false;
		}
		return hasString;
	}
	return false;
}

function looksLikeObjectSchema(schema: unknown): boolean {
	return (
		isRecord(schema) &&
		((typeof schema.type === "string" &&
			schema.type.trim().toLowerCase() === "object") ||
			isRecord(schema.properties) ||
			schema.additionalProperties != null)
	);
}

function looksLikeArraySchema(schema: unknown): schema is ArraySchemaRecord {
	return (
		isRecord(schema) &&
		((typeof schema.type === "string" &&
			schema.type.trim().toLowerCase() === "array") ||
			schema.items != null)
	);
}

function stringifySchemaValue(value: unknown): [unknown, boolean] {
	if (value == null || typeof value === "string") return [value, false];
	try {
		return [JSON.stringify(value), true];
	} catch (_) {
		return [value, false];
	}
}
