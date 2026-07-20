import { describe, test } from "vitest";
import { parseDSMLToolCallsDetailed } from "../../../src/toolcall/dsml";
import {
	buildToolSchemaIndex,
	looksLikeArraySchema,
	looksLikeObjectSchema,
	normalizeParsedToolCallsForSchemas,
	normalizeToolValueWithSchema,
	shouldCoerceSchemaToString,
	stringifySchemaValue,
} from "../../../src/toolcall/schema-normalize";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";
import { record, required } from "./_support/assertions.js";

describe("toolcall", () => {
	test("normalizes DSML arguments using top-level input_schema", async () => {
		const tools = [
			{
				type: "function",
				name: "Search",
				description: "Search documents",
				input_schema: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
		];
		const parsed = parseDSMLToolCallsDetailed(
			'<tool_calls><invoke name="Search"><parameter name="query"><term>docs</term></parameter></invoke></tool_calls>',
		);
		const normalized = normalizeParsedToolCallsForSchemas(
			parsed.calls,
			createToolBundle(tools),
		);
		assert.deepEqual(normalized, [
			{ name: "Search", input: { query: '{"term":"docs"}' } },
		]);
	});
	test("normalizes parsed tool-call arguments through schema aliases", async () => {
		const tools = [
			{
				type: "function",
				function: {
					name: "Lookup",
					parameters: {
						type: "object",
						properties: {
							query: { type: "string" },
							maybe: { type: ["string", "null"] },
							choices: {
								type: "array",
								items: [
									{ type: "string" },
									{
										type: "object",
										additionalProperties: { type: "string" },
									},
								],
							},
						},
						additionalProperties: { type: "string" },
					},
				},
			},
		];
		const calls = [
			{
				name: "Lookup",
				input: {
					query: { term: "docs" },
					maybe: 5,
					choices: [7, { a: 1 }, false],
					extra: true,
				},
			},
			"not a call",
			{ name: "Missing", input: { query: { term: "unchanged" } } },
			{ name: "Lookup", input: "not an object" },
		];
		const normalized = normalizeParsedToolCallsForSchemas(
			calls,
			createToolBundle(tools),
		);
		if (!Array.isArray(normalized))
			throw new Error("expected normalized calls");
		const first = record(required(normalized[0]));
		const input = record(first.input);
		assert.equal(input.query, '{"term":"docs"}');
		assert.equal(input.maybe, "5");
		assert.deepEqual(input.choices, ["7", { a: "1" }, false]);
		assert.equal(input.extra, "true");
		assert.equal(normalized[1], "not a call");
		assert.deepEqual(normalized[2], calls[2]);
		assert.deepEqual(normalized[3], calls[3]);
		assert.deepEqual(
			required(buildToolSchemaIndex(createToolBundle(tools))).lookup,
			required(tools[0]).function.parameters,
		);
	});
	test("keeps schema normalization conservative when no conversion is required", async () => {
		assert.deepEqual(normalizeParsedToolCallsForSchemas(null, null), null);
		assert.deepEqual(normalizeParsedToolCallsForSchemas([], null), []);
		assert.deepEqual(normalizeToolValueWithSchema(null, { type: "string" }), [
			null,
			false,
		]);
		assert.deepEqual(normalizeToolValueWithSchema({ a: 1 }, null), [
			{ a: 1 },
			false,
		]);
		assert.deepEqual(
			normalizeToolValueWithSchema([], {
				type: "array",
				items: { type: "string" },
			}),
			[[], false],
		);
		assert.deepEqual(
			normalizeToolValueWithSchema(["x"], {
				type: "array",
				items: [null],
			}),
			[["x"], false],
		);
		assert.equal(shouldCoerceSchemaToString({ const: "fixed" }), true);
		assert.equal(shouldCoerceSchemaToString({ enum: ["a", "b"] }), true);
		assert.equal(
			shouldCoerceSchemaToString({ type: ["string", "null"] }),
			true,
		);
		assert.equal(
			shouldCoerceSchemaToString({ type: ["string", "integer"] }),
			false,
		);
		assert.equal(looksLikeObjectSchema({ properties: {} }), true);
		assert.equal(looksLikeArraySchema({ items: {} }), true);
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		assert.deepEqual(stringifySchemaValue(cyclic), [cyclic, false]);
	});
});
