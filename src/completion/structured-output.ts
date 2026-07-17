import { tryParseJson } from "../shared/json";
import { validateJsonSchemaSubset } from "../shared/json-schema";
import { isRecord, type UnknownRecord } from "../shared/types";

type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

type StructuredOutputRequirement =
	| {
			type: "json_object";
			instruction: string;
			error?: undefined;
			schema?: undefined;
			schemaName?: undefined;
	  }
	| {
			type: "json_schema";
			schemaName: string;
			schema: UnknownRecord;
			instruction: string;
			error?: undefined;
	  }
	| {
			error: string;
			type?: undefined;
			instruction?: undefined;
			schema?: undefined;
			schemaName?: undefined;
	  };

export function getStructuredResponseFormat(
	req: unknown,
): UnknownRecord | null {
	if (!isRecord(req)) return null;
	if (isRecord(req.response_format)) return req.response_format;
	const text = req.text;
	if (isRecord(text) && isRecord(text.format)) return text.format;
	return null;
}

export function buildStructuredOutputRequirement(
	responseFormat: unknown,
): StructuredOutputRequirement | null {
	if (!isRecord(responseFormat)) return null;
	const type = String(responseFormat.type || "").trim();
	if (!type) return null;

	if (type === "json_object") {
		return {
			type,
			instruction: [
				"STRUCTURED OUTPUT REQUIREMENT:",
				"Respond with a single valid JSON object.",
				"Do not include markdown fences, explanations, comments, or any text before or after the JSON object.",
			].join("\n"),
		};
	}

	if (type !== "json_schema") return null;

	const jsonSchema = isRecord(responseFormat.json_schema)
		? responseFormat.json_schema
		: responseFormat;
	const schema = jsonSchema.schema;
	if (!isRecord(schema)) {
		return { error: "response_format json_schema requires a schema object" };
	}

	let schemaText = "";
	try {
		schemaText = JSON.stringify(schema);
	} catch (_) {
		return {
			error: "response_format json_schema schema must be JSON serializable",
		};
	}

	const schemaName = String(jsonSchema.name || "response").trim() || "response";
	const strict = jsonSchema.strict !== false;
	const parts = [
		"STRUCTURED OUTPUT REQUIREMENT:",
		"Respond with a single valid JSON document that conforms to the JSON Schema below.",
		"Do not include markdown fences, explanations, comments, or any text before or after the JSON document.",
		`Schema name: ${schemaName}`,
		`Strict mode: ${strict ? "true" : "false"}`,
		"JSON Schema:",
		schemaText,
	];
	return { type, schemaName, schema, instruction: parts.join("\n") };
}

export function canonicalizeStructuredOutputText(
	text: unknown,
	requirement: unknown,
): string {
	const raw = String(text || "");
	if (!requirement || !raw.trim()) return raw;
	const parsed = parseStructuredJsonCandidate(text);
	if (parsed === STRUCTURED_JSON_NOT_FOUND) return String(text || "").trim();
	try {
		return JSON.stringify(parsed);
	} catch (_) {
		return String(text || "").trim();
	}
}

export function finalizeStructuredOutputText(
	text: unknown,
	requirement: unknown,
): { text: string; error?: string } {
	const raw = String(text || "");
	if (!requirement) return { text: raw };
	const parsed = parseStructuredJsonCandidate(text);
	if (parsed === STRUCTURED_JSON_NOT_FOUND) {
		return {
			text: String(text || "").trim(),
			error: "structured output was not valid JSON",
		};
	}
	const validation = validateStructuredOutputValue(parsed, requirement);
	if (validation) {
		return {
			text: canonicalizeStructuredOutputText(text, requirement),
			error: validation,
		};
	}
	try {
		return { text: JSON.stringify(parsed) };
	} catch (_) {
		return {
			text: String(text || "").trim(),
			error: "structured output JSON could not be serialized",
		};
	}
}

export function validateStructuredOutputValue(
	value: unknown,
	requirement: unknown,
): string {
	if (!isRecord(requirement)) return "";
	if (requirement.type === "json_object") {
		if (!isRecord(value)) return "structured output must be a JSON object";
		return "";
	}
	if (requirement.type !== "json_schema" || !isRecord(requirement.schema))
		return "";
	return validateJsonSchemaSubset(value, requirement.schema, "$");
}

export const STRUCTURED_JSON_NOT_FOUND = Symbol("structured_json_not_found");

export function parseStructuredJsonCandidate(
	text: unknown,
): JsonValue | typeof STRUCTURED_JSON_NOT_FOUND {
	const raw = String(text || "").trim();
	if (!raw) return STRUCTURED_JSON_NOT_FOUND;
	const direct = tryParseJson(raw);
	if (direct.ok) return direct.value as JsonValue;

	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw);
	if (fence) {
		const fenced = tryParseJson((fence[1] || "").trim());
		if (fenced.ok) return fenced.value as JsonValue;
	}

	const candidate = extractFirstJsonDocument(raw);
	if (!candidate) return STRUCTURED_JSON_NOT_FOUND;
	const parsed = tryParseJson(candidate);
	return parsed.ok ? (parsed.value as JsonValue) : STRUCTURED_JSON_NOT_FOUND;
}

export function extractFirstJsonDocument(text: unknown): string {
	const source = String(text || "");
	const stack: Array<{ close: string; start: number }> = [];
	let start = -1;
	let inString = false;
	let escaped = false;
	let fallbackStart = -1;
	let fallbackEnd = -1;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i];
		if (start < 0) {
			if (ch !== "{" && ch !== "[") continue;
			start = i;
			stack.push({ close: ch === "{" ? "}" : "]", start: i });
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			stack.push({ close: ch === "{" ? "}" : "]", start: i });
			continue;
		}
		if (ch !== "}" && ch !== "]") continue;

		const top = stack[stack.length - 1];
		if (!top || ch !== top.close) {
			if (fallbackStart >= 0) return source.slice(fallbackStart, fallbackEnd);
			start = -1;
			stack.length = 0;
			inString = false;
			escaped = false;
			fallbackStart = -1;
			fallbackEnd = -1;
			continue;
		}

		const frame = stack.pop() as { close: string; start: number };
		if (!stack.length) return source.slice(start, i + 1);
		if (fallbackStart < 0 || frame.start < fallbackStart) {
			fallbackStart = frame.start;
			fallbackEnd = i + 1;
		}
	}
	if (fallbackStart >= 0) return source.slice(fallbackStart, fallbackEnd);
	return "";
}
