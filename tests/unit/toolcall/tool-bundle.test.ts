// @ts-nocheck
import { describe, test } from "vitest";
import { parseOpenAIMessages } from "../../../src/promptcompat/message-model";
import { messagesToPrompt } from "../../../src/promptcompat/messages";
import {
	createToolBundle,
	filterToolBundleByPolicy,
	nullableOpenAIFunctionTools,
	toolCallInstructionsFor,
	toolNamesForPromptSource,
	toolPromptBlockFor,
	toolsContextTranscriptFor,
} from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

describe("toolcall", () => {
	test("renders bundle artifacts through prompt and context consumers", async () => {
		const tools = [
			{
				type: "function",
				function: {
					name: "Search",
					description: "Search docs",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
					},
				},
			},
		];
		const messages = parseOpenAIMessages([
			{ role: "user", content: "find docs" },
		]);
		const direct = messagesToPrompt(
			messages,
			{ bundle: createToolBundle(tools), choiceInstruction: "", include: true },
			1000000,
		);
		const bundle = createToolBundle(tools);
		const bundled = messagesToPrompt(
			messages,
			{
				bundle: createToolBundle(bundle),
				choiceInstruction: "",
				include: true,
			},
			1000000,
		);
		assert.equal(bundled.text, direct.text);
		assert.equal(bundled.metadata.hasToolPrompt, true);
		assert.equal(bundled.metadata.hasToolInstructions, true);
		assert.match(toolPromptBlockFor(bundle, ""), /"name": "Search"/);
		assert.doesNotMatch(
			toolPromptBlockFor(bundle, ""),
			/Gemini native hidden tool calls/,
		);
		const transcript = toolsContextTranscriptFor(bundle, "", "tools.txt");
		assert.match(transcript, /Available tool descriptions/);
		assert.match(transcript, /Tool call format instructions/);
		assert.match(transcript, /Gemini native hidden tool calls/);
		assert.match(transcript, /All of the above is system prompt content/);

		const flattened = messagesToPrompt(
			messages,
			{
				bundle: createToolBundle([
					{
						name: "Lookup",
						description: "Lookup docs",
						parameters: {
							type: "object",
							properties: { id: { type: "string" } },
						},
					},
				]),
				choiceInstruction: "",
				include: true,
			},
			1000000,
		);
		assert.match(flattened.text, /"name": "Lookup"/);
		assert.match(flattened.text, /"id"/);
		assert.doesNotMatch(flattened.text, /Gemini native hidden tool calls/);
	});
	test("builds stable filtered bundles without losing schemas", async () => {
		const source = {
			functionDeclarations: [
				{
					name: "Search",
					description: "Search docs",
					parameters: {
						type: "object",
						properties: { query: { type: "string" } },
					},
				},
				{
					name: "Read",
					description: "Read a file",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
					},
				},
			],
		};
		const bundle = createToolBundle(source);
		assert.equal(createToolBundle(bundle), bundle);
		assert.deepEqual(bundle.names, ["Search", "Read"]);
		assert.equal(bundle.schemaIndex.search.properties.query.type, "string");
		const instructions = bundle.promptArtifact.toolCallInstructions();
		assert.match(instructions, /tool_calls/);
		const block = bundle.promptArtifact.inlinePromptBlock("must call Read");
		assert.match(block, /must call Read/);
		const transcript = bundle.promptArtifact.contextTranscript(
			"must call Read",
			"bundle-tools.txt",
		);
		assert.match(transcript, /# bundle-tools\.txt/);
		source.functionDeclarations[0].name = "Mutated";
		source.functionDeclarations[0].description = "Changed after bundling";
		assert.equal(bundle.promptArtifact.toolCallInstructions(), instructions);
		assert.equal(
			bundle.promptArtifact.inlinePromptBlock("must call Read"),
			block,
		);
		assert.equal(
			bundle.promptArtifact.contextTranscript(
				"must call Read",
				"bundle-tools.txt",
			),
			transcript,
		);
		assert.doesNotMatch(`${instructions}\n${block}\n${transcript}`, /Mutated/);

		const filtered = filterToolBundleByPolicy(bundle, {
			mode: "forced",
			allowed: { Read: true },
			hasAllowed: true,
		});
		assert.deepEqual(filtered.names, ["Read"]);
		assert.equal(filtered.schemaIndex.read.properties.path.type, "string");
		assert.equal(nullableOpenAIFunctionTools(filtered).length, 1);
		assert.equal(
			nullableOpenAIFunctionTools(
				filterToolBundleByPolicy(bundle, { mode: "none" }),
			),
			null,
		);
		assert.equal(
			nullableOpenAIFunctionTools(
				filterToolBundleByPolicy(bundle, {
					allowed: { Missing: true },
					hasAllowed: true,
				}),
			),
			null,
		);
		assert.equal(filterToolBundleByPolicy(bundle, null), bundle);

		assert.deepEqual(
			toolNamesForPromptSource(
				createToolBundle([
					{ name: "Search" },
					{ name: "Search" },
					{ name: "" },
				]),
			),
			["Search"],
		);
		assert.match(
			toolCallInstructionsFor(createToolBundle([{ name: "Search" }])),
			/<\|DSML\|tool_calls>/,
		);
		const empty = createToolBundle([{ type: "function", function: {} }]);
		assert.deepEqual(empty.names, []);
		assert.equal(empty.items.length, 1);
	});
});
