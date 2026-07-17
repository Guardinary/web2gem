import { codePointLength } from "./tokens";
import { isRecord, type UnknownRecord } from "./types";

const SCHEMA_PATTERN_CACHE = new WeakMap<UnknownRecord, RegExp | null>();

export function validateJsonSchemaSubset(
	value: unknown,
	schema: unknown,
	path: string,
): string {
	if (!isRecord(schema)) return "";

	const allOfError = validateSchemaAllOf(value, schema, path);
	if (allOfError) return allOfError;
	const anyOfError = validateSchemaAnyOf(value, schema, path);
	if (anyOfError) return anyOfError;
	const oneOfError = validateSchemaOneOf(value, schema, path);
	if (oneOfError) return oneOfError;

	if (Object.hasOwn(schema, "const") && !jsonValuesEqual(schema.const, value)) {
		return `${path} must equal the schema const value`;
	}

	if (Array.isArray(schema.enum) && schema.enum.length) {
		const ok = schema.enum.some((item) => jsonValuesEqual(item, value));
		if (!ok) return `${path} must be one of the schema enum values`;
	}

	if (value === null && schema.nullable === true) return "";

	const typeError = validateJsonSchemaType(value, schema.type, path);
	if (typeError) return typeError;

	const typ = inferJsonType(value);
	if (typ === "object" && isRecord(value)) {
		const props: UnknownRecord = isRecord(schema.properties)
			? schema.properties
			: {};
		const required = Array.isArray(schema.required) ? schema.required : [];
		for (const rawKey of required) {
			const key = String(rawKey);
			if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(props, key)) return `${path}.${key} is not allowed`;
			}
		} else if (isRecord(schema.additionalProperties)) {
			for (const key of Object.keys(value)) {
				if (Object.hasOwn(props, key)) continue;
				const childError = validateJsonSchemaSubset(
					value[key],
					schema.additionalProperties,
					`${path}.${key}`,
				);
				if (childError) return childError;
			}
		}
		for (const [key, childSchema] of Object.entries(props)) {
			if (Object.hasOwn(value, key)) {
				const childError = validateJsonSchemaSubset(
					value[key],
					childSchema,
					`${path}.${key}`,
				);
				if (childError) return childError;
			}
		}
		const minProps = schemaNumber(schema.minProperties);
		if (minProps != null && Object.keys(value).length < minProps)
			return `${path} must have at least ${minProps} properties`;
		const maxProps = schemaNumber(schema.maxProperties);
		if (maxProps != null && Object.keys(value).length > maxProps)
			return `${path} must have at most ${maxProps} properties`;
	} else if (typ === "array" && Array.isArray(value) && schema.items) {
		const items = schema.items;
		for (let i = 0; i < value.length; i++) {
			const itemSchema = Array.isArray(items) ? items[i] : items;
			if (!itemSchema) continue;
			const childError = validateJsonSchemaSubset(
				value[i],
				itemSchema,
				`${path}[${i}]`,
			);
			if (childError) return childError;
		}
		if (
			Array.isArray(items) &&
			schema.additionalItems === false &&
			value.length > items.length
		) {
			return `${path} must not contain additional array items`;
		}
	}

	if (typ === "array" && Array.isArray(value)) {
		const minItems = schemaNumber(schema.minItems);
		if (minItems != null && value.length < minItems)
			return `${path} must contain at least ${minItems} items`;
		const maxItems = schemaNumber(schema.maxItems);
		if (maxItems != null && value.length > maxItems)
			return `${path} must contain at most ${maxItems} items`;
		if (schema.uniqueItems === true) {
			if (!jsonArrayItemsUnique(value))
				return `${path} must contain unique items`;
		}
	} else if (typ === "string" && typeof value === "string") {
		const len = codePointLength(value);
		const minLength = schemaNumber(schema.minLength);
		if (minLength != null && len < minLength)
			return `${path} length must be at least ${minLength}`;
		const maxLength = schemaNumber(schema.maxLength);
		if (maxLength != null && len > maxLength)
			return `${path} length must be at most ${maxLength}`;
		if (typeof schema.pattern === "string") {
			const re = schemaPatternRegExp(schema, schema.pattern);
			if (re && !re.test(value))
				return `${path} must match pattern ${schema.pattern}`;
		}
	} else if (typ === "number" && typeof value === "number") {
		const minimum = schemaNumber(schema.minimum);
		if (minimum != null && value < minimum)
			return `${path} must be >= ${minimum}`;
		const maximum = schemaNumber(schema.maximum);
		if (maximum != null && value > maximum)
			return `${path} must be <= ${maximum}`;
		const exclusiveMinimum = schemaNumber(schema.exclusiveMinimum);
		if (exclusiveMinimum != null && value <= exclusiveMinimum)
			return `${path} must be > ${exclusiveMinimum}`;
		const exclusiveMaximum = schemaNumber(schema.exclusiveMaximum);
		if (exclusiveMaximum != null && value >= exclusiveMaximum)
			return `${path} must be < ${exclusiveMaximum}`;
		const multipleOf = schemaNumber(schema.multipleOf);
		if (
			multipleOf != null &&
			multipleOf > 0 &&
			!isJsonNumberMultipleOf(value, multipleOf)
		)
			return `${path} must be a multiple of ${multipleOf}`;
	}

	return "";
}

function schemaPatternRegExp(
	schema: UnknownRecord,
	pattern: string,
): RegExp | null {
	if (SCHEMA_PATTERN_CACHE.has(schema))
		return SCHEMA_PATTERN_CACHE.get(schema) || null;
	let re: RegExp | null;
	try {
		re = new RegExp(pattern);
	} catch (_) {
		re = null;
	}
	SCHEMA_PATTERN_CACHE.set(schema, re);
	return re;
}

export function validateSchemaAllOf(
	value: unknown,
	schema: UnknownRecord,
	path: string,
): string {
	if (!Array.isArray(schema.allOf) || !schema.allOf.length) return "";
	for (const sub of schema.allOf) {
		const err = validateJsonSchemaSubset(value, sub, path);
		if (err) return err;
	}
	return "";
}

export function validateSchemaAnyOf(
	value: unknown,
	schema: UnknownRecord,
	path: string,
): string {
	if (!Array.isArray(schema.anyOf) || !schema.anyOf.length) return "";
	const errors: string[] = [];
	for (const sub of schema.anyOf) {
		const err = validateJsonSchemaSubset(value, sub, path);
		if (!err) return "";
		errors.push(err);
	}
	return `${path} must match at least one anyOf schema${errors[0] ? ` (${errors[0]})` : ""}`;
}

export function validateSchemaOneOf(
	value: unknown,
	schema: UnknownRecord,
	path: string,
): string {
	if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) return "";
	let matches = 0;
	const errors: string[] = [];
	for (const sub of schema.oneOf) {
		const err = validateJsonSchemaSubset(value, sub, path);
		if (!err) matches += 1;
		else errors.push(err);
	}
	if (matches === 1) return "";
	if (matches > 1)
		return `${path} must match exactly one oneOf schema, matched ${matches}`;
	return `${path} must match exactly one oneOf schema${errors[0] ? ` (${errors[0]})` : ""}`;
}

export function schemaNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isJsonNumberMultipleOf(
	value: number,
	multipleOf: number,
): boolean {
	const quotient = value / multipleOf;
	return Math.abs(quotient - Math.round(quotient)) < 1e-12;
}

export function validateJsonSchemaType(
	value: unknown,
	typeSpec: unknown,
	path: string,
): string {
	if (typeSpec == null) return "";
	const allowed = Array.isArray(typeSpec) ? typeSpec : [typeSpec];
	const actual = inferJsonType(value);
	for (const raw of allowed) {
		const typ = String(raw || "")
			.trim()
			.toLowerCase();
		if (!typ) continue;
		if (typ === actual) return "";
		if (
			typ === "integer" &&
			actual === "number" &&
			typeof value === "number" &&
			Number.isInteger(value)
		)
			return "";
	}
	return `${path} must be ${allowed.join(" or ")}, got ${actual}`;
}

export function inferJsonType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") return "number";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "string") return "string";
	if (typeof value === "object") return "object";
	return typeof value;
}

export function jsonValuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return a === b;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		for (let i = 0; i < a.length; i++) {
			if (!jsonValuesEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(b, key)) return false;
		if (!jsonValuesEqual(a[key], b[key])) return false;
	}
	return true;
}

function jsonArrayItemsUnique(values: unknown[]): boolean {
	const primitiveSeen = new Set<string>();
	let allPrimitive = true;
	for (const value of values) {
		const key = jsonPrimitiveValueKey(value);
		if (key == null) {
			allPrimitive = false;
			break;
		}
		if (primitiveSeen.has(key)) return false;
		primitiveSeen.add(key);
	}
	if (allPrimitive) return true;

	const seen = new Set<string>();
	const stableKeyPath = new Set<object>();
	const fallbackValues: unknown[] = [];
	for (const value of values) {
		const key = jsonStableValueKey(value, stableKeyPath);
		if (key == null) {
			for (const prev of fallbackValues) {
				if (jsonValuesEqual(value, prev)) return false;
			}
			fallbackValues.push(value);
			continue;
		}
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

function jsonPrimitiveValueKey(value: unknown): string | null {
	if (value === null) return "null";
	if (typeof value === "string") return `string:${JSON.stringify(value)}`;
	if (typeof value === "boolean") return `boolean:${value ? 1 : 0}`;
	if (typeof value === "number")
		return Number.isFinite(value) ? `number:${String(value)}` : null;
	return null;
}

function jsonStableValueKey(
	value: unknown,
	seen: Set<object> = new Set(),
): string | null {
	const primitiveKey = jsonPrimitiveValueKey(value);
	if (primitiveKey != null) return primitiveKey;
	if (typeof value === "number") return null;
	if (Array.isArray(value)) {
		if (seen.has(value)) return null;
		seen.add(value);
		const parts: string[] = [];
		for (const item of value) {
			const key = jsonStableValueKey(item, seen);
			if (key == null) {
				seen.delete(value);
				return null;
			}
			parts.push(key);
		}
		seen.delete(value);
		return `array:[${parts.join(",")}]`;
	}
	if (!isRecord(value)) return null;
	if (seen.has(value)) return null;
	seen.add(value);
	const parts: string[] = [];
	for (const key of Object.keys(value).sort()) {
		const childKey = jsonStableValueKey(value[key], seen);
		if (childKey == null) {
			seen.delete(value);
			return null;
		}
		parts.push(`${JSON.stringify(key)}:${childKey}`);
	}
	seen.delete(value);
	return `object:{${parts.join(",")}}`;
}
