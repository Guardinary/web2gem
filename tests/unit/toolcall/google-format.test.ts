// @ts-nocheck
import { describe, test } from "vitest";
import { parseGoogleFunctionCalls } from "../../../src/toolcall/google";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

describe("Google tool-call formatting", () => {
	test("keeps Google legacy function-call syntaxes as plain text", async () => {
		const tools = createToolBundle([
			{
				functionDeclarations: [
					{
						name: "Lookup",
						parameters: {
							type: "object",
							properties: {
								id: { type: "integer" },
								query: { type: "string" },
							},
						},
					},
				],
			},
		]);
		const [cleanFence, fenceCalls] = parseGoogleFunctionCalls(
			'before\n```function_call\n{"name":"Lookup","arguments":{"id":"7","query":"alpha"}}\n```\nafter',
			tools,
		);
		assert.match(cleanFence, /```function_call/);
		assert.deepEqual(fenceCalls, []);

		const [cleanBare, bareCalls] = parseGoogleFunctionCalls(
			'{"name":"Lookup","input":{"id":"8","query":"beta"}}',
			tools,
		);
		assert.equal(
			cleanBare,
			'{"name":"Lookup","input":{"id":"8","query":"beta"}}',
		);
		assert.deepEqual(bareCalls, []);

		const [_cleanDsml, dsmlCalls] = parseGoogleFunctionCalls(
			'<tool_calls><invoke name="Lookup"><parameter name="query"><term>docs</term></parameter></invoke></tool_calls>',
			tools,
		);
		assert.equal(dsmlCalls[0].args.query, '{"term":"docs"}');
	});
	test("keeps malformed Google function-call text as plain output", async () => {
		const [clean, calls] = parseGoogleFunctionCalls(
			'before\n```function_call\n{"name":\n```\nafter',
			null,
		);
		assert.match(clean, /before/);
		assert.match(clean, /```function_call/);
		assert.match(clean, /\{"name":/);
		assert.match(clean, /after/);
		assert.deepEqual(calls, []);
	});
});
