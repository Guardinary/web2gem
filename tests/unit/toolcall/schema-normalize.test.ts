import { describe, test } from "vitest";
import { parseDSMLToolCallsDetailed } from "../../../src/toolcall/dsml";
import { normalizeParsedToolCallsForSchemas } from "../../../src/toolcall/schema-normalize";
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
	});
	test("keeps schema normalization conservative when no conversion is required", async () => {
		assert.deepEqual(normalizeParsedToolCallsForSchemas(null, null), null);
		assert.deepEqual(normalizeParsedToolCallsForSchemas([], null), []);
		const tools = createToolBundle([
			{
				type: "function",
				function: {
					name: "Lookup",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
					},
				},
			},
		]);
		const unchanged = [{ name: "Lookup", input: { query: "docs" } }];
		assert.deepEqual(
			normalizeParsedToolCallsForSchemas(unchanged, tools),
			unchanged,
		);
	});

	test("coerces const enum and array item values through public schema normalize", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				function: {
					name: "Configure",
					parameters: {
						type: "object",
						properties: {
							mode: { const: "strict" },
							kind: { enum: ["alpha", "beta"] },
							maybe: { type: ["string", "null"] },
							// mixed string+integer is not string-coerce
							count: { type: ["string", "integer"] },
							tags: { type: "array", items: { type: "string" } },
							// tuple items: only defined indexes normalize
							pair: {
								type: "array",
								items: [{ type: "string" }, null],
							},
							// non-string enum must not force stringify of siblings only
							flag: { enum: [true, false] },
						},
					},
				},
			},
		]);
		const calls = [
			{
				name: "Configure",
				input: {
					mode: 1,
					kind: true,
					maybe: 5,
					count: 9,
					tags: [7, { nested: true }, "ok"],
					pair: [11, 22],
					flag: true,
				},
			},
			{
				name: "Configure",
				input: {
					// empty array stays unchanged under array schema
					tags: [],
					// already-string values stay unchanged
					maybe: "ready",
				},
			},
		];
		const normalized = normalizeParsedToolCallsForSchemas(calls, tools);
		if (!Array.isArray(normalized))
			throw new Error("expected normalized calls");
		const first = record(required(record(required(normalized[0])).input));
		assert.equal(first.mode, "1");
		assert.equal(first.kind, "true");
		assert.equal(first.maybe, "5");
		assert.equal(first.count, 9);
		assert.deepEqual(first.tags, ["7", '{"nested":true}', "ok"]);
		assert.deepEqual(first.pair, ["11", 22]);
		// non-string enum does not enter string-coerce path
		assert.equal(first.flag, true);

		const second = record(required(record(required(normalized[1])).input));
		assert.deepEqual(second.tags, []);
		assert.equal(second.maybe, "ready");
	});
});
