import { describe, test } from "vitest";
import {
	jsonValuesEqual,
	validateJsonSchemaSubset,
} from "../../../src/shared/json-schema";
import { assert } from "../assertions.js";

describe("JSON Schema subset", () => {
	test("validates combinators numeric bounds and closed objects", async () => {
		const schema = {
			type: "object",
			required: ["kind", "items", "score"],
			additionalProperties: false,
			properties: {
				kind: { oneOf: [{ const: "alpha" }, { const: "beta" }] },
				tag: {
					anyOf: [
						{ type: "string", pattern: "^ok-" },
						{ type: "integer", minimum: 10 },
					],
				},
				items: {
					type: "array",
					minItems: 2,
					maxItems: 3,
					uniqueItems: true,
					items: { type: "integer" },
				},
				score: {
					type: "number",
					exclusiveMinimum: 0,
					exclusiveMaximum: 10,
					multipleOf: 0.5,
				},
			},
		};
		const validate = (value: unknown) =>
			validateJsonSchemaSubset(value, schema, "$");

		assert.equal(
			validate({ kind: "alpha", tag: "ok-ready", items: [1, 2], score: 1.5 }),
			"",
		);
		assert.match(
			validate({ kind: "gamma", tag: "ok-ready", items: [1, 2], score: 1.5 }),
			/oneOf/,
		);
		assert.match(
			validate({ kind: "alpha", tag: "bad", items: [1, 2], score: 1.5 }),
			/anyOf/,
		);
		assert.match(
			validate({ kind: "alpha", tag: 12, items: [1, 1], score: 1.5 }),
			/unique/,
		);
		assert.match(
			validate({ kind: "alpha", tag: 12, items: [1, 2], score: 1.3 }),
			/multiple/,
		);
		assert.match(
			validate({
				kind: "alpha",
				tag: 12,
				items: [1, 2],
				score: 1.5,
				extra: true,
			}),
			/not allowed/,
		);
	});

	test("validates object array type and string constraints", async () => {
		assert.equal(
			validateJsonSchemaSubset(
				{ a: "x", b: 2 },
				{
					type: "object",
					minProperties: 2,
					maxProperties: 2,
					properties: { a: { type: "string" } },
					additionalProperties: { type: "integer" },
				},
				"$",
			),
			"",
		);
		assert.match(
			validateJsonSchemaSubset(
				{ a: "x" },
				{ type: "object", minProperties: 2 },
				"$",
			),
			/at least 2 properties/,
		);
		assert.match(
			validateJsonSchemaSubset(
				{ a: "x", b: 2, c: 3 },
				{ type: "object", maxProperties: 2 },
				"$",
			),
			/at most 2 properties/,
		);
		assert.match(
			validateJsonSchemaSubset(
				{ a: "x", b: "bad" },
				{
					type: "object",
					properties: { a: { type: "string" } },
					additionalProperties: { type: "integer" },
				},
				"$",
			),
			/\.b must be integer/,
		);
		assert.match(
			validateJsonSchemaSubset(
				[1, "two", true],
				{
					type: "array",
					items: [{ type: "integer" }, { type: "string" }],
					additionalItems: false,
				},
				"$",
			),
			/additional array items/,
		);
		assert.equal(
			validateJsonSchemaSubset(2, { type: ["string", "integer"] }, "$"),
			"",
		);
		assert.equal(
			validateJsonSchemaSubset(
				{ maybe: null },
				{
					type: "object",
					properties: { maybe: { type: "string", nullable: true } },
				},
				"$",
			),
			"",
		);
		assert.match(
			validateJsonSchemaSubset(
				{ maybe: null },
				{
					type: "object",
					properties: { maybe: { type: "string" } },
				},
				"$",
			),
			/\.maybe must be string, got null/,
		);
		assert.match(
			validateJsonSchemaSubset(
				"abcd",
				{ type: "string", minLength: 2, maxLength: 3 },
				"$",
			),
			/at most 3/,
		);
		assert.equal(
			validateJsonSchemaSubset(
				"anything",
				{ type: "string", pattern: "[" },
				"$",
			),
			"",
		);
		assert.match(
			validateJsonSchemaSubset(
				1,
				{ oneOf: [{ type: "number" }, { type: "integer" }] },
				"$",
			),
			/matched 2/,
		);
	});

	test("uses structural equality for const enum and uniqueItems", async () => {
		assert.equal(
			validateJsonSchemaSubset(
				[1, "1", true, false, null],
				{ type: "array", uniqueItems: true },
				"$",
			),
			"",
		);
		assert.equal(
			validateJsonSchemaSubset(
				["x", "x"],
				{ type: "array", uniqueItems: true },
				"$",
			),
			"$ must contain unique items",
		);
		assert.equal(
			validateJsonSchemaSubset({ b: 2, a: 1 }, { const: { a: 1, b: 2 } }, "$"),
			"",
		);
		assert.equal(
			validateJsonSchemaSubset({ b: 2, a: 1 }, { enum: [{ a: 1, b: 2 }] }, "$"),
			"",
		);
		assert.equal(
			validateJsonSchemaSubset(
				[
					{ b: 2, a: 1 },
					{ a: 1, b: 2 },
				],
				{ type: "array", uniqueItems: true },
				"$",
			),
			"$ must contain unique items",
		);
	});

	test("compares nested JSON values independent of object key order", async () => {
		assert.equal(
			jsonValuesEqual(
				{ a: [1, { b: true }], c: null },
				{ c: null, a: [1, { b: true }] },
			),
			true,
		);
		assert.equal(
			jsonValuesEqual({ a: [1, { b: true }] }, { a: [1, { b: false }] }),
			false,
		);
		assert.equal(jsonValuesEqual({ a: 1 }, { a: 1, b: 2 }), false);
		assert.equal(jsonValuesEqual([1, 2], [2, 1]), false);
	});
});
