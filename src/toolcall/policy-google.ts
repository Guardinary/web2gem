import type { UnknownRecord } from "../shared/types";
import { firstRecord, isRecord } from "../shared/types";
import type { ToolChoicePolicy, ToolPolicyViolation } from "./policy-openai";
import {
	extractToolNames,
	namesToSet,
	validateToolPolicyCalls,
} from "./policy-openai";
import type { ToolBundle } from "./tool-bundle";

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

/** Google tool-choice instruction derived from a parsed ToolChoicePolicy. */
export function googleToolChoiceInstructionFromPolicy(
	policy: ToolChoicePolicy | null | undefined,
): string {
	if (!policy) return "";
	if (policy.mode === "none")
		return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
	if (policy.mode === "required") {
		const allowed = policy.allowed ? Object.keys(policy.allowed) : [];
		if (allowed.length) {
			const names = allowed.map((name) => `"${name}"`).join(", ");
			return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
		}
		return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
	}
	return "";
}

export function parseGoogleToolChoicePolicy(
	req: unknown,
	tools: ToolBundle | null | undefined,
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
	const allowed = googleAllowedFunctionNames(fc);

	if (mode !== "AUTO" && mode !== "ANY" && mode !== "NONE") {
		policy.error = `unsupported functionCallingConfig.mode: ${mode}`;
		return policy;
	}
	for (const name of allowed) {
		if (!declaredSet[name]) {
			policy.error = `functionCallingConfig allowed unknown function: ${name}`;
			return policy;
		}
	}
	if (mode === "ANY" && !declared.length) {
		policy.error = "functionCallingConfig.mode=ANY requires at least one tool";
		return policy;
	}
	if (allowed.length && !allowed.some((name) => declaredSet[name])) {
		policy.error =
			"functionCallingConfig.allowedFunctionNames did not match any declared functions";
		return policy;
	}

	if (mode === "NONE") {
		policy.mode = "none";
		policy.allowed = {};
		policy.hasAllowed = true;
		return policy;
	}
	if (mode === "ANY") policy.mode = "required";
	else policy.mode = "auto";

	if (allowed.length) {
		policy.allowed = namesToSet(allowed);
		policy.hasAllowed = true;
	}
	return policy;
}

export function validateGoogleToolPolicyCalls(
	policy: ToolChoicePolicy | null | undefined,
	calls: unknown,
): ToolPolicyViolation | null {
	return validateToolPolicyCalls(policy, calls, {
		requiredMessage:
			"functionCallingConfig.mode=ANY requires at least one valid function call.",
		badMessage: (names) =>
			`functionCallingConfig does not allow function(s): ${names}.`,
		forcedMessage: (name) =>
			`functionCallingConfig requires the function ${name}.`,
	});
}
