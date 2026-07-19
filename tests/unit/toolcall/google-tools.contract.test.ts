// @ts-nocheck
import { describe, test } from "vitest";
import { filterGoogleToolsByConfig } from "../../../src/toolcall/policy-google";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

describe("Google tool metadata contract", () => {
	test("normalizes supported tool shapes before policy filtering", async () => {
		const cases = [
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
			const bundle = createToolBundle(filtered);
			assert.equal(filtered.length, 1, item.name);
			assert.equal(filtered[0].function.name, item.expectedName, item.name);
			assert.equal(bundle.promptArtifact.defs[0].name, item.expectedName);
			assert.equal(
				item.expectedField in
					bundle.promptArtifact.defs[0].parameters.properties,
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
