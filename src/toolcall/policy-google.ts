import {
	extractToolNames,
	namesToSet,
	policyHasAllowed,
	validateToolPolicyCalls,
} from "./policy-openai";
import type { ToolChoicePolicy, ToolPolicyViolation } from "./policy-openai";
import { firstRecord, isRecord } from "../shared/types";
import type { UnknownRecord } from "../shared/types";
import { toolFunctionDeclarations } from "./tool-meta";
import {
	createToolBundle,
	filterToolBundleByPolicy,
	nullableOpenAIFunctionTools,
} from "./tool-bundle";

type GoogleFunctionDeclaration = UnknownRecord & { name?: unknown };

export function googleFunctionDeclarations(
	group: unknown,
): GoogleFunctionDeclaration[] {
	return toolFunctionDeclarations(group) as GoogleFunctionDeclaration[];
}

export function googleFunctionCallingConfig(req: unknown): UnknownRecord {
	const record = isRecord(req) ? req : {};
	const tc = firstRecord(record.toolConfig, record.tool_config) || {};
	return (
		firstRecord(tc.functionCallingConfig, tc.function_calling_config) || {}
	);
}

export function googleAllowedFunctionNames(fc: unknown): string[] {
	const record = isRecord(fc) ? fc : {};
	const raw =
		record.allowedFunctionNames ||
		record.allowed_function_names ||
		record.allowedFunctions ||
		record.allowed_functions;
	if (Array.isArray(raw))
		return raw.map((n) => String(n || "").trim()).filter(Boolean);
	if (typeof raw === "string")
		return raw
			.split(",")
			.map((n) => n.trim())
			.filter(Boolean);
	return [];
}

export function parseGoogleToolChoicePolicy(
	req: unknown,
	tools: unknown,
): ToolChoicePolicy {
	const fc = googleFunctionCallingConfig(req);
	const mode = String(fc.mode || "AUTO")
		.trim()
		.toUpperCase();
	const declared = extractToolNames(tools);
	const declaredSet = namesToSet(declared);
	const policy: ToolChoicePolicy = {
		mode: "auto",
		forcedName: "",
		allowed: null,
		hasAllowed: false,
		declared,
		error: "",
	};

	if (mode === "NONE") {
		policy.mode = "none";
		policy.allowed = {};
		policy.hasAllowed = true;
		return policy;
	}
	if (mode === "ANY") policy.mode = "required";
	else policy.mode = "auto";

	const allowed = googleAllowedFunctionNames(fc);
	if (allowed.length) {
		const kept: string[] = [];
		for (const name of allowed) {
			if (declaredSet[name]) kept.push(name);
		}
		policy.allowed = namesToSet(kept);
		policy.hasAllowed = true;
	}
	return policy;
}

export function validateGoogleToolChoiceConfig(
	req: unknown,
	tools: unknown,
): ToolPolicyViolation | null {
	const fc = googleFunctionCallingConfig(req);
	const mode = String(fc.mode || "AUTO")
		.trim()
		.toUpperCase();
	if (mode !== "AUTO" && mode !== "ANY" && mode !== "NONE") {
		return {
			message: `unsupported functionCallingConfig.mode: ${mode}`,
			code: "tool_choice_violation",
		};
	}

	const declared = extractToolNames(tools);
	const declaredSet = namesToSet(declared);
	const allowed = googleAllowedFunctionNames(fc);
	for (const name of allowed) {
		if (!declaredSet[name]) {
			return {
				message: `functionCallingConfig allowed unknown function: ${name}`,
				code: "tool_choice_violation",
			};
		}
	}

	if (mode === "ANY" && !declared.length) {
		return {
			message: "functionCallingConfig.mode=ANY requires at least one tool",
			code: "tool_choice_violation",
		};
	}
	if (allowed.length && !allowed.some((name) => declaredSet[name])) {
		return {
			message:
				"functionCallingConfig.allowedFunctionNames did not match any declared functions",
			code: "tool_choice_violation",
		};
	}
	return null;
}

export function filterGoogleToolsByConfig(
	tools: unknown,
	req: unknown,
): UnknownRecord[] | null {
	const bundle = createToolBundle(tools);
	if (!bundle.openAIFunctionTools.length) return null;
	const policy = parseGoogleToolChoicePolicy(req, bundle);
	if (policy.mode === "none") return null;
	if (!policyHasAllowed(policy)) return bundle.openAIFunctionTools;
	return nullableOpenAIFunctionTools(filterToolBundleByPolicy(bundle, policy));
}

export function normalizeGoogleToolsForPrompt(
	tools: unknown,
): UnknownRecord[] | null {
	return nullableOpenAIFunctionTools(createToolBundle(tools));
}

export function validateGoogleFunctionCalls(req: unknown, calls: unknown) {
	const record = isRecord(req) ? req : {};
	const policy = parseGoogleToolChoicePolicy(req, record.tools || []);
	return validateToolPolicyCalls(policy, calls, {
		requiredMessage:
			"functionCallingConfig.mode=ANY requires at least one valid function call.",
		badMessage: (names) =>
			`functionCallingConfig does not allow function(s): ${names}.`,
		forcedMessage: (name) =>
			`functionCallingConfig requires the function ${name}.`,
	});
}
