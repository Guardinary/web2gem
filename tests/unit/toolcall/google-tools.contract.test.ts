import { describe, test } from "vitest";
import { isRecord, type UnknownRecord } from "../../../src/shared/types";
import { filterGoogleToolsByConfig } from "../../../src/toolcall/policy-google";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a value");
	return value;
}

function record(value: unknown): UnknownRecord {
	if (!isRecord(value)) throw new Error("expected an object");
	return value;
}

describe("Google tool metadata contract", () => {
	test("normalizes supported tool shapes before policy filtering", async () => {
		const cases: Array<{
			name: string;
			tool: unknown;
			expectedName: string;
			expectedField: string;
		}> = [
			{
				name: "OpenAI function",
				tool: {
					type: "function",
					function: {
						name: "Read",
						description: "Read a file",
						parameters: {
							type: "object",
							properties: { path: { type: "string" } },
						},
					},
				},
				expectedName: "Read",
				expectedField: "path",
			},
			{
				name: "schema shorthand",
				tool: {
					name: "Lookup",
					description: "Lookup by id",
					schema: {
						type: "object",
						properties: { id: { type: "string" } },
					},
				},
				expectedName: "Lookup",
				expectedField: "id",
			},
			{
				name: "functionDeclarations",
				tool: {
					functionDeclarations: [
						{
							name: "Fetch",
							description: "Fetch by URL",
							parameters: {
								type: "object",
								properties: { url: { type: "string" } },
							},
						},
					],
				},
				expectedName: "Fetch",
				expectedField: "url",
			},
			{
				name: "functions parametersJsonSchema",
				tool: {
					functions: [
						{
							name: "Translate",
							description: "Translate text",
							parametersJsonSchema: {
								type: "object",
								properties: { text: { type: "string" } },
							},
						},
					],
				},
				expectedName: "Translate",
				expectedField: "text",
			},
		];

		for (const item of cases) {
			const request = {
				tools: [item.tool],
				toolConfig: { functionCallingConfig: { mode: "ANY" } },
			};
			const filtered = filterGoogleToolsByConfig(request.tools, request);
			const filteredTools = required(filtered);
			const bundle = createToolBundle(filteredTools);
			assert.equal(filteredTools.length, 1, item.name);
			assert.equal(
				record(required(filteredTools[0]).function).name,
				item.expectedName,
				item.name,
			);
			const definition = required(bundle.promptArtifact.defs[0]);
			assert.equal(definition.name, item.expectedName);
			assert.equal(
				item.expectedField in record(record(definition.parameters).properties),
				true,
				item.name,
			);
			assert.match(
				bundle.promptArtifact.inlinePromptBlock(""),
				new RegExp(`"name": "${item.expectedName}"`),
			);
		}
	});
});
