import { describe, test } from "vitest";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import {
	extractToolMeta,
	firstNonNil,
	toolDefsFromTools,
	toolFunctionDeclarations,
	toolItemsFromTools,
	toolMetasFromTools,
} from "../../../src/toolcall/tool-meta";
import { assert } from "../assertions.js";
import { required } from "./_support/assertions.js";

describe("toolcall", () => {
	test("normalizes tool metadata across OpenAI Google and Responses aliases", async () => {
		const schema = {
			type: "object",
			properties: { query: { type: "string" } },
		};
		assert.equal(extractToolMeta(null), null);
		assert.deepEqual(
			extractToolMeta({
				type: "function",
				function: {
					name: "Search",
					description: "Search docs",
					parameters: schema,
				},
			}),
			{
				name: "Search",
				description: "Search docs",
				parameters: schema,
			},
		);
		assert.deepEqual(
			extractToolMeta({
				tool: {
					name: "Wrapped",
					description: "Search wrapped docs",
					input_schema: schema,
				},
			}),
			{
				name: "Wrapped",
				description: "Search wrapped docs",
				parameters: schema,
			},
		);
		assert.deepEqual(
			createToolBundle([
				{
					type: "function",
					tool: {
						name: "Wrapped",
						description: "Search wrapped docs",
						input_schema: schema,
					},
				},
			]).promptArtifact.defs[0],
			{
				name: "Wrapped",
				description: "Search wrapped docs",
				parameters: schema,
			},
		);

		const grouped = {
			function_declarations: [
				{
					name: "GoogleSearch",
					description: "Google style",
					inputSchema: schema,
				},
				{ name: "", parameters: schema },
				"skip",
			],
		};
		assert.deepEqual(
			toolFunctionDeclarations(grouped).map((item) => item.name),
			["GoogleSearch", ""],
		);
		assert.deepEqual(
			toolFunctionDeclarations({ functionDeclarations: {} }),
			[],
		);
		assert.deepEqual(
			toolItemsFromTools({ tools: [{ name: "List", schema }, "skip"] }).map(
				(item) => item.name,
			),
			["List"],
		);
		assert.equal(toolItemsFromTools({ nope: true }).length, 0);
		assert.deepEqual(toolMetasFromTools(grouped), [
			{
				name: "GoogleSearch",
				description: "Google style",
				parameters: schema,
			},
		]);
		assert.deepEqual(toolDefsFromTools([{ name: "NoSchema" }]), [
			{
				name: "NoSchema",
				description: "",
				parameters: {},
			},
		]);
		assert.equal(firstNonNil(null, undefined, false, "fallback"), false);
	});
	test("accepts OpenAI tool schema aliases", async () => {
		for (const key of ["input_schema", "inputSchema", "schema"]) {
			const schema = {
				type: "object",
				properties: { value: { type: "string" } },
			};
			const defs = createToolBundle([
				{ type: "function", name: `Alias_${key}`, [key]: schema },
			]).promptArtifact.defs;
			assert.equal(required(defs[0]).name, `Alias_${key}`);
			assert.deepEqual(required(defs[0]).parameters, schema);
		}
	});
});
