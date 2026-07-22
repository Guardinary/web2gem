import { describe, test } from "vitest";
import { isRecord } from "../../../src/shared/types";
import type { ToolChoicePolicy } from "../../../src/toolcall/policy-openai";
import {
	allowedToolNameFromItem,
	buildToolChoiceInstructionFromPolicy,
	extractToolNames,
	namesToSet,
	parseAllowedToolNames,
	parseForcedToolName,
	parseOpenAIToolChoicePolicy,
	toolPolicyAllows,
	validateRequiredToolCalls,
	validateToolPolicyCalls,
} from "../../../src/toolcall/policy-openai";
import {
	createToolBundle,
	filterToolBundleByPolicy,
} from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";
import { required } from "./_support/assertions.js";

function completePolicy(
	overrides: Partial<ToolChoicePolicy>,
): ToolChoicePolicy {
	return {
		mode: "auto",
		forcedName: "",
		allowed: null,
		hasAllowed: false,
		declared: [],
		error: "",
		...overrides,
	};
}

function policyTools() {
	return createToolBundle([
		{
			type: "function",
			function: { name: "Read", parameters: { type: "object" } },
		},
		{
			type: "function",
			function: { name: "Search", parameters: { type: "object" } },
		},
		{
			type: "function",
			function: { name: "Read", parameters: { type: "object" } },
		},
	]);
}

describe("toolcall", () => {
	test("accepts wrapped forced OpenAI tool choices", async () => {
		const schema = {
			type: "object",
			properties: { query: { type: "string" } },
		};
		const policy = parseOpenAIToolChoicePolicy(
			{ type: "function", name: "WrappedSearch" },
			createToolBundle([
				{
					type: "function",
					tool: { name: "WrappedSearch", input_schema: schema },
				},
			]),
		);
		assert.equal(policy.error, "");
		assert.equal(policy.forcedName, "WrappedSearch");
	});
	test("parses OpenAI allowed_tools policy aliases and filters duplicates", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
			{
				type: "function",
				function: { name: "Search", parameters: { type: "object" } },
			},
		]);
		const policy = parseOpenAIToolChoicePolicy(
			{
				type: "allowed_tools",
				mode: "required",
				tools: [
					"Read",
					{ function: { name: "Search" } },
					{ tool: { name: "Read" } },
				],
			},
			tools,
		);
		assert.equal(policy.error, "");
		assert.equal(policy.mode, "required");
		assert.deepEqual(Object.keys(required(policy.allowed)), ["Read", "Search"]);
	});
	test("reports OpenAI tool choice shape errors without changing policy mode", async () => {
		const tools = createToolBundle([
			{
				type: "function",
				function: { name: "Read", parameters: { type: "object" } },
			},
		]);
		assert.match(
			parseOpenAIToolChoicePolicy(42, tools).error,
			/must be a string or object/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy("sometimes", tools).error,
			/unsupported tool_choice/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy(
				{ type: "allowed_tools", mode: "always", tools: ["Read"] },
				tools,
			).error,
			/unsupported tool_choice\.mode/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy({ type: "allowed_tools", tools: [{}] }, tools)
				.error,
			/did not contain any valid tool names/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy(
				{ type: "function", function: { name: "Missing" } },
				tools,
			).error,
			/forced tool is not declared/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy({ type: "function" }, tools).error,
			/requires function\.name/,
		);
	});
	test("extracts unique declared allowed and forced tool names", async () => {
		const toolsBundle = policyTools();
		const googleGroup = {
			functionDeclarations: [{ name: "Lookup" }, { name: "Read" }],
		};
		assert.deepEqual(extractToolNames(toolsBundle), ["Read", "Search"]);
		assert.deepEqual(extractToolNames(createToolBundle(googleGroup)), [
			"Lookup",
			"Read",
		]);
		assert.deepEqual(namesToSet(["Read", "", null, "Search"]), {
			Read: true,
			Search: true,
		});
		assert.equal(allowedToolNameFromItem(" Read "), " Read ");
		assert.equal(
			allowedToolNameFromItem({ function: { name: "Search" } }),
			"Search",
		);
		assert.equal(
			allowedToolNameFromItem({ tool: { name: "Lookup" } }),
			"Lookup",
		);
		assert.equal(allowedToolNameFromItem(5), "");

		assert.equal(parseAllowedToolNames(null), null);
		assert.deepEqual(parseAllowedToolNames("Read, Search"), {
			names: ["Read", "Search"],
		});
		assert.deepEqual(
			parseAllowedToolNames({
				allowed_tools: [
					{ function: { name: "Read" } },
					{ tool: { name: "Search" } },
					"Read",
				],
			}),
			{ names: ["Read", "Search"] },
		);
		assert.match(required(parseAllowedToolNames([])).error, /non-empty array/);
		assert.match(
			required(parseAllowedToolNames([{}])).error,
			/did not contain any valid tool names/,
		);
		assert.equal(parseForcedToolName({ name: "Read" }), "Read");
		assert.equal(
			parseForcedToolName({ function: { name: "Search" } }),
			"Search",
		);
		assert.equal(parseForcedToolName("Read"), "");
	});

	test("parses none forced required and invalid OpenAI policy modes", async () => {
		const toolsBundle = policyTools();
		const forcedAuto = parseOpenAIToolChoicePolicy(
			{ type: "auto", name: "Read" },
			toolsBundle,
		);
		assert.equal(forcedAuto.mode, "forced");
		assert.deepEqual(forcedAuto.allowed, { Read: true });
		const noneObject = parseOpenAIToolChoicePolicy(
			{ type: "none" },
			toolsBundle,
		);
		assert.equal(noneObject.mode, "none");
		assert.deepEqual(noneObject.allowed, {});
		assert.match(
			parseOpenAIToolChoicePolicy({ type: "required" }, null).error,
			/requires at least one tool/,
		);
		assert.match(
			parseOpenAIToolChoicePolicy({ allowed_tools: ["Missing"] }, toolsBundle)
				.error,
			/allowed unknown tool/,
		);
	});

	test("filters tools according to allowed OpenAI policy", async () => {
		const toolsBundle = policyTools();
		const forced = parseOpenAIToolChoicePolicy(
			{ type: "auto", name: "Read" },
			toolsBundle,
		);
		const none = parseOpenAIToolChoicePolicy({ type: "none" }, toolsBundle);
		assert.equal(toolPolicyAllows(null, "Anything"), true);
		assert.equal(toolPolicyAllows(none, "Read"), false);
		assert.equal(toolPolicyAllows(forced, "Read"), true);
		assert.equal(toolPolicyAllows(forced, "Search"), false);

		assert.equal(
			filterToolBundleByPolicy(toolsBundle, completePolicy({ mode: "none" }))
				.openAIFunctionTools.length,
			0,
		);
		assert.equal(
			filterToolBundleByPolicy(toolsBundle, null).openAIFunctionTools,
			toolsBundle.openAIFunctionTools,
		);
		assert.deepEqual(
			filterToolBundleByPolicy(toolsBundle, forced).openAIFunctionTools.map(
				(tool) => {
					if (!isRecord(tool.function))
						throw new Error("expected function tool");
					return tool.function.name;
				},
			),
			["Read", "Read"],
		);
	});

	test("renders instructions for each OpenAI tool policy mode", async () => {
		const toolsBundle = policyTools();
		const forced = parseOpenAIToolChoicePolicy(
			{ type: "auto", name: "Read" },
			toolsBundle,
		);
		const none = parseOpenAIToolChoicePolicy({ type: "none" }, toolsBundle);
		assert.equal(buildToolChoiceInstructionFromPolicy(null), "");
		assert.equal(
			buildToolChoiceInstructionFromPolicy(completePolicy({ mode: "auto" })),
			"",
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy(none),
			/Do NOT call any tools/,
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy(forced),
			/MUST call the tool "Read"/,
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy(
				completePolicy({
					mode: "required",
					allowed: { Read: true, Search: true },
				}),
			),
			/"Read", "Search"/,
		);
		assert.match(
			buildToolChoiceInstructionFromPolicy(
				completePolicy({
					mode: "required",
					allowed: null,
				}),
			),
			/MUST call at least one tool/,
		);
	});

	test("validates required allowed and forced OpenAI tool calls", async () => {
		const forced = parseOpenAIToolChoicePolicy(
			{ type: "auto", name: "Read" },
			policyTools(),
		);
		const requiredPolicy = completePolicy({
			mode: "required",
			allowed: { Read: true },
			hasAllowed: true,
		});
		assert.equal(validateRequiredToolCalls(null, []), null);
		assert.match(
			required(validateRequiredToolCalls(requiredPolicy, [])).message,
			/requires at least one valid tool call/,
		);
		assert.match(
			required(
				validateRequiredToolCalls(requiredPolicy, [
					{ function: { name: "Search" } },
					{ name: "Search" },
				]),
			).message,
			/Search/,
		);
		const forcedMissing = validateRequiredToolCalls(forced, [
			{ function: { name: "" } },
		]);
		assert.match(required(forcedMissing).message, /requires the tool Read/);
		assert.equal(validateRequiredToolCalls(forced, [{ name: "Read" }]), null);
		assert.deepEqual(
			validateToolPolicyCalls(forced, [], {
				requiredMessage: "need call",
				badMessage: (names) => `bad ${names}`,
				forcedMessage: (name) => `missing ${name}`,
			}),
			{ message: "need call", code: "tool_choice_violation" },
		);
	});
});
