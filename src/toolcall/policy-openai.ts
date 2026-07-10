import { isRecord } from "../shared/types";
import {
	extractToolMeta,
	toolFunctionDeclarations,
	toolItemsFromTools,
} from "./tool-meta";
import {
	filterToolBundleByPolicy,
	isToolBundle,
	nullableOpenAIFunctionTools,
} from "./tool-bundle";
import type { ToolBundle } from "./tool-bundle";

type NameSet = Record<string, boolean>;
export type ToolChoiceMode = "auto" | "none" | "required" | "forced";
export type ToolChoicePolicy = {
	mode: ToolChoiceMode;
	forcedName: string;
	allowed: NameSet | null;
	hasAllowed: boolean;
	declared: string[];
	error: string;
};
export type ToolPolicyViolation = {
	message: string;
	code: "tool_choice_violation";
};

type AllowedToolNamesResult =
	| { names: string[]; error?: undefined }
	| { error: string; names?: undefined };
type ToolPolicyValidationMessages = {
	requiredMessage: string;
	badMessage: (names: string) => string;
	forcedMessage: (name: string) => string;
};

export function extractToolNames(tools: unknown): string[] {
	if (isToolBundle(tools)) return tools.names;
	const out: string[] = [];
	const seen = new Set<string>();
	const addName = (raw: unknown) => {
		const name = String(raw || "").trim();
		if (!name || seen.has(name)) return;
		seen.add(name);
		out.push(name);
	};
	for (const tool of toolItemsFromTools(tools)) {
		const declarations = toolFunctionDeclarations(tool);
		if (declarations.length) {
			for (const fn of declarations) {
				const meta = extractToolMeta(fn);
				addName(meta?.name);
			}
			continue;
		}
		const meta = extractToolMeta(tool);
		addName(meta?.name);
	}
	return out;
}

export function namesToSet(
	names: readonly unknown[] | null | undefined,
): NameSet {
	const out: NameSet = {};
	for (const raw of names || []) {
		const name = String(raw || "").trim();
		if (name) out[name] = true;
	}
	return out;
}

export function allowedToolNameFromItem(item: unknown): string {
	if (typeof item === "string") return item;
	if (!isRecord(item)) return "";
	const fn = isRecord(item.function) ? item.function : null;
	const tool = isRecord(item.tool) ? item.tool : null;
	return String(item.name || fn?.name || tool?.name || "");
}

export function parseAllowedToolNames(
	raw: unknown,
): AllowedToolNamesResult | null {
	if (raw == null) return null;
	let value: unknown = raw;
	if (isRecord(raw)) {
		value =
			raw.tools ||
			raw.allowed_tools ||
			raw.names ||
			raw.allowed ||
			raw.functions ||
			raw.function_names;
	}
	if (typeof value === "string")
		value = value
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	if (!Array.isArray(value) || !value.length)
		return { error: "allowed_tools must be a non-empty array" };
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		let name = allowedToolNameFromItem(item);
		name = String(name || "").trim();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		out.push(name);
	}
	if (!out.length)
		return { error: "allowed_tools did not contain any valid tool names" };
	return { names: out };
}

export function parseForcedToolName(toolChoice: unknown): string {
	if (!isRecord(toolChoice)) return "";
	const fn = isRecord(toolChoice.function) ? toolChoice.function : null;
	return String(toolChoice.name || fn?.name || "").trim();
}

export function parseOpenAIToolChoicePolicy(
	toolChoiceRaw: unknown,
	toolsRaw: unknown,
): ToolChoicePolicy {
	const declared = extractToolNames(toolsRaw);
	const declaredSet = namesToSet(declared);
	const policy: ToolChoicePolicy = {
		mode: "auto",
		forcedName: "",
		allowed: null,
		hasAllowed: false,
		declared,
		error: "",
	};
	const hasTools = declared.length > 0;

	const setAllowed = (names: readonly string[] | null | undefined) => {
		if (!names) return true;
		for (const name of names) {
			if (!declaredSet[name]) {
				policy.error = `tool_choice allowed unknown tool: ${name}`;
				return false;
			}
		}
		policy.allowed = namesToSet(names);
		policy.hasAllowed = true;
		return true;
	};

	if (toolChoiceRaw == null || toolChoiceRaw === "" || toolChoiceRaw === "auto")
		return policy;
	if (typeof toolChoiceRaw === "string") {
		const mode = toolChoiceRaw.trim().toLowerCase();
		if (mode === "none") {
			policy.mode = "none";
			policy.allowed = {};
			policy.hasAllowed = true;
			return policy;
		}
		if (mode === "required") {
			if (!hasTools)
				policy.error = "tool_choice=required requires at least one tool";
			policy.mode = "required";
			return policy;
		}
		policy.error = `unsupported tool_choice: ${toolChoiceRaw}`;
		return policy;
	}
	if (!isRecord(toolChoiceRaw)) {
		policy.error = "tool_choice must be a string or object";
		return policy;
	}

	const type = String(toolChoiceRaw.type || "auto")
		.trim()
		.toLowerCase();
	const allowedSource =
		toolChoiceRaw.allowed_tools ??
		(type === "allowed_tools" ? toolChoiceRaw : toolChoiceRaw.tools);
	const allowedParsed = parseAllowedToolNames(allowedSource);
	if (allowedParsed?.error) {
		policy.error = allowedParsed.error;
		return policy;
	}
	if (allowedParsed && !setAllowed(allowedParsed.names)) return policy;

	const forced = parseForcedToolName(toolChoiceRaw);
	if ((type === "auto" || type === "") && forced) {
		policy.mode = "forced";
		policy.forcedName = forced;
	} else if (type === "allowed_tools") {
		const mode = String(toolChoiceRaw.mode || "auto")
			.trim()
			.toLowerCase();
		if (mode === "required") policy.mode = "required";
		else if (mode === "auto" || mode === "") policy.mode = "auto";
		else {
			policy.error = `unsupported tool_choice.mode for allowed_tools: ${mode}`;
			return policy;
		}
	} else if (type === "auto" || type === "") {
		policy.mode = "auto";
	} else if (type === "none") {
		policy.mode = "none";
		policy.allowed = {};
		policy.hasAllowed = true;
	} else if (type === "required") {
		policy.mode = "required";
	} else if (type === "function") {
		policy.mode = "forced";
		policy.forcedName = forced;
	} else {
		policy.error = `unsupported tool_choice.type: ${type}`;
		return policy;
	}

	if ((policy.mode === "required" || policy.mode === "forced") && !hasTools)
		policy.error = `tool_choice=${policy.mode} requires at least one tool`;
	if (policy.mode === "forced") {
		if (!policy.forcedName)
			policy.error = "forced tool_choice requires function.name";
		else if (!declaredSet[policy.forcedName])
			policy.error = `forced tool is not declared: ${policy.forcedName}`;
		else {
			policy.allowed = namesToSet([policy.forcedName]);
			policy.hasAllowed = true;
		}
	}
	return policy;
}

export function policyHasAllowed(
	policy: ToolChoicePolicy | null | undefined,
): boolean {
	return !!(
		policy?.allowed &&
		(policy.hasAllowed || Object.keys(policy.allowed).length > 0)
	);
}

export function toolPolicyAllows(
	policy: ToolChoicePolicy | null | undefined,
	name: unknown,
): boolean {
	const allowed = policy?.allowed;
	if (!allowed || (!policy.hasAllowed && Object.keys(allowed).length === 0))
		return true;
	return !!allowed[String(name || "").trim()];
}

export function filterToolsByPolicy<T>(
	tools: T[] | ToolBundle | null | undefined,
	policy: ToolChoicePolicy | null | undefined,
): T[] | null {
	if (isToolBundle(tools))
		return nullableOpenAIFunctionTools(
			filterToolBundleByPolicy(tools, policy),
		) as T[] | null;
	if (
		!Array.isArray(tools) ||
		!tools.length ||
		(policy && policy.mode === "none")
	)
		return null;
	if (!policyHasAllowed(policy)) return tools;
	return tools.filter((tool) => {
		const meta = extractToolMeta(tool);
		return meta ? toolPolicyAllows(policy, meta.name) : false;
	});
}

export function buildToolChoiceInstructionFromPolicy(
	policy: ToolChoicePolicy | null | undefined,
): string {
	if (!policy || policy.mode === "auto") return "";
	if (policy.mode === "none")
		return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
	if (policy.mode === "forced")
		return `\n\nIMPORTANT: You MUST call the tool "${policy.forcedName}". Do not call other tools.`;
	if (policy.mode === "required") {
		const allowed = policy.allowed ? Object.keys(policy.allowed) : [];
		if (allowed.length)
			return `\n\nIMPORTANT: You MUST call at least one of these tools: ${allowed.map((n) => `"${n}"`).join(", ")}. Do not respond with text only.`;
		return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
	}
	return "";
}

export function validateRequiredToolCalls(
	policy: ToolChoicePolicy | null | undefined,
	toolCalls: unknown,
): ToolPolicyViolation | null {
	return validateToolPolicyCalls(policy, toolCalls, {
		requiredMessage: "tool_choice requires at least one valid tool call.",
		badMessage: (names) => `tool_choice does not allow tool(s): ${names}.`,
		forcedMessage: (name) => `tool_choice requires the tool ${name}.`,
	});
}

export function validateToolPolicyCalls(
	policy: ToolChoicePolicy | null | undefined,
	toolCalls: unknown,
	messages: ToolPolicyValidationMessages,
): ToolPolicyViolation | null {
	if (!policy) return null;
	const calls = Array.isArray(toolCalls) ? toolCalls : [];
	const requiresCall = policy.mode === "required" || policy.mode === "forced";
	const enforcesAllowed = !!policy.allowed || requiresCall;
	if (!enforcesAllowed) return null;
	if (requiresCall && !calls.length)
		return { message: messages.requiredMessage, code: "tool_choice_violation" };
	const badNames: string[] = [];
	for (const tc of calls) {
		const record = isRecord(tc) ? tc : null;
		const fn = record && isRecord(record.function) ? record.function : null;
		const name = String(fn?.name || record?.name || "").trim();
		if (name && !toolPolicyAllows(policy, name)) badNames.push(name);
	}
	if (badNames.length) {
		return {
			message: messages.badMessage([...new Set(badNames)].join(", ")),
			code: "tool_choice_violation",
		};
	}
	if (policy.mode === "forced") {
		const ok = calls.some((tc) => {
			const record = isRecord(tc) ? tc : null;
			const fn = record && isRecord(record.function) ? record.function : null;
			return (
				String(fn?.name || record?.name || "").trim() === policy.forcedName
			);
		});
		if (!ok)
			return {
				message: messages.forcedMessage(policy.forcedName),
				code: "tool_choice_violation",
			};
	}
	return null;
}
