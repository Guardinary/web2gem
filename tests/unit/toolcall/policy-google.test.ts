// @ts-nocheck
import { describe, test } from "vitest";
import {
	filterGoogleToolsByConfig,
	googleToolChoiceInstructionFromPolicy,
	parseGoogleToolChoicePolicy,
	validateGoogleToolChoiceConfig,
	validateGoogleToolPolicyCalls,
} from "../../../src/toolcall/policy-google";
import { createToolBundle } from "../../../src/toolcall/tool-bundle";
import { assert } from "../assertions.js";

function googlePolicyTools() {
	return [
		{
			functionDeclarations: [
				{ name: "Read", parameters: { type: "object" } },
				{ name: "Search", parameters: { type: "object" } },
			],
		},
	];
}

describe("Google tool policy", () => {
	test("parses allowed-name aliases and filters Google tools", async () => {
		const tools = googlePolicyTools();
		const bundle = createToolBundle(tools);
		const request = {
			tools,
			tool_config: {
				function_calling_config: {
					mode: "ANY",
					allowed_function_names: "Read",
				},
			},
		};
		assert.equal(validateGoogleToolChoiceConfig(request, bundle), null);
		const policy = parseGoogleToolChoicePolicy(request, bundle);
		assert.equal(policy.mode, "required");
		assert.equal(policy.hasAllowed, true);
		assert.deepEqual(Object.keys(policy.allowed), ["Read"]);
		const instruction = googleToolChoiceInstructionFromPolicy(policy);
		assert.match(instruction, /MUST call one of these tools: "Read"/);
		assert.doesNotMatch(instruction, /"Search"/);
		const filtered = filterGoogleToolsByConfig(tools, request);
		assert.deepEqual(
			filtered.map((tool) => tool.function.name),
			["Read"],
		);
	});

	test("renders general required policy and rejects missing Google calls", async () => {
		const tools = googlePolicyTools();
		const bundle = createToolBundle(tools);
		const policy = parseGoogleToolChoicePolicy(
			{ toolConfig: { functionCallingConfig: { mode: "ANY" } } },
			bundle,
		);
		assert.equal(policy.mode, "required");
		assert.equal(policy.allowed, null);
		assert.match(
			googleToolChoiceInstructionFromPolicy(policy),
			/MUST call at least one tool/,
		);
		assert.match(
			validateGoogleToolPolicyCalls(policy, []).message,
			/requires at least one valid function call/,
		);
		assert.match(
			validateGoogleToolChoiceConfig(
				{ toolConfig: { functionCallingConfig: { mode: "ANY" } } },
				createToolBundle([]),
			).message,
			/requires at least one tool/,
		);
	});

	test("reports unsupported modes and unknown Google tool names", async () => {
		const tools = googlePolicyTools();
		const bundle = createToolBundle(tools);
		assert.match(
			validateGoogleToolChoiceConfig(
				{
					tools,
					toolConfig: { functionCallingConfig: { mode: "NEVER" } },
				},
				bundle,
			).message,
			/unsupported functionCallingConfig\.mode/,
		);
		assert.match(
			validateGoogleToolChoiceConfig(
				{
					tools,
					toolConfig: {
						functionCallingConfig: {
							mode: "AUTO",
							allowedFunctionNames: ["Missing"],
						},
					},
				},
				bundle,
			).message,
			/allowed unknown function: Missing/,
		);
	});

	test("omits Google tools and rejects calls when mode is NONE", async () => {
		const tools = googlePolicyTools();
		const filtered = filterGoogleToolsByConfig(tools, {
			toolConfig: { functionCallingConfig: { mode: "NONE" } },
		});
		assert.equal(filtered, null);
		assert.match(
			validateGoogleToolPolicyCalls(
				parseGoogleToolChoicePolicy(
					{ toolConfig: { functionCallingConfig: { mode: "NONE" } } },
					createToolBundle(tools),
				),
				[{ name: "Read", args: {} }],
			).message,
			/does not allow function\(s\): Read/,
		);
	});
});
