import { parseToolCalls } from "../toolcall/dsml";
import type { GoogleFunctionCall } from "../toolcall/google";
import { parseGoogleFunctionCalls } from "../toolcall/google";
import type { OpenAIToolCall } from "../toolcall/openai-format";
import { validateGoogleToolPolicyCalls } from "../toolcall/policy-google";
import type {
	ToolChoicePolicy,
	ToolPolicyViolation,
} from "../toolcall/policy-openai";
import { validateRequiredToolCalls } from "../toolcall/policy-openai";
import { finalizeStructuredOutputText } from "./structured-output";
import type { ToolBundle } from "../toolcall/tool-bundle";

export const EMPTY_UPSTREAM_MSG =
	"⚠️ Upstream Gemini returned an empty response. " +
	"The Worker could not extract any final text from the upstream response. " +
	"Check `wrangler tail` for upstream status, retry/fallback logs, and whether the request is being blocked or returned in an unsupported shape.";

export type OpenAICompletionTurnOptions = {
	tools?: unknown;
	noneModeTools?: unknown;
	promptToolChoice?: string;
	structured?: unknown;
	toolPolicy?: ToolChoicePolicy | null | undefined;
};

export type OpenAICompletionTurn =
	| {
			text: string;
			toolCalls: OpenAIToolCall[] | null;
			error?: undefined;
	  }
	| {
			error: {
				message: string;
				status: number;
				code: string;
			};
			text?: undefined;
			toolCalls?: undefined;
	  };

export function finalizeOpenAICompletionResult(
	text: unknown,
	options: OpenAICompletionTurnOptions,
): OpenAICompletionTurn {
	const { tools, noneModeTools, promptToolChoice, structured, toolPolicy } =
		options || {};
	let outText = String(text || "");
	let toolCalls: OpenAIToolCall[] | null = null;

	if (tools && outText && promptToolChoice !== "none") {
		const [clean, tc] = parseToolCalls(outText, tools);
		outText = String(clean || "");
		toolCalls = tc.length ? tc : null;
	} else if (noneModeTools && outText && promptToolChoice === "none") {
		const [, tc] = parseToolCalls(outText, noneModeTools);
		toolCalls = tc.length ? tc : null;
	}
	if (!toolCalls && structured) {
		const finalized = finalizeStructuredOutputText(outText, structured);
		if (finalized.error) {
			return {
				error: {
					message: finalized.error,
					status: 502,
					code: "structured_output_validation_failed",
				},
			};
		}
		outText = finalized.text;
	}
	const violation = validateRequiredToolCalls(toolPolicy, toolCalls);
	if (violation) {
		return { error: violationError(violation) };
	}
	if (!outText && !toolCalls) {
		return {
			error: {
				message: EMPTY_UPSTREAM_MSG,
				status: 502,
				code: "upstream_empty",
			},
		};
	}
	return {
		text: outText,
		toolCalls,
	};
}

export type GoogleResponsePart =
	| { text: string }
	| { functionCall: GoogleFunctionCall };

export type GoogleCompletionTurnOptions = {
	tools: ToolBundle | null;
	toolPolicy: ToolChoicePolicy | null | undefined;
	hasTools: boolean;
};

export type GoogleCompletionTurn =
	| {
			responseParts: GoogleResponsePart[];
			error?: undefined;
	  }
	| {
			error: {
				message: string;
				status: number;
				code?: string;
			};
			responseParts?: undefined;
	  };

export function finalizeGoogleCompletionResult(
	text: unknown,
	options: GoogleCompletionTurnOptions,
): GoogleCompletionTurn {
	const source = String(text || "");
	const responseParts: GoogleResponsePart[] = [];
	if (!source) {
		return {
			error: {
				message: EMPTY_UPSTREAM_MSG,
				status: 502,
				code: "upstream_empty",
			},
		};
	}
	const inspectTools =
		options.hasTools ||
		(options.toolPolicy?.mode === "none" && options.tools !== null);
	if (inspectTools && source) {
		const [clean, fcs] = parseGoogleFunctionCalls(source, options.tools);
		const violation = validateGoogleToolPolicyCalls(options.toolPolicy, fcs);
		if (violation) return { error: violationError(violation) };
		if (fcs.length) {
			if (clean) responseParts.push({ text: clean });
			for (const fc of fcs)
				responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
		} else {
			responseParts.push({ text: source });
		}
	} else {
		const violation = validateGoogleToolPolicyCalls(options.toolPolicy, []);
		if (violation) return { error: violationError(violation) };
		responseParts.push({ text: source });
	}
	return { responseParts };
}

function violationError(violation: ToolPolicyViolation): {
	message: string;
	status: number;
	code: "tool_choice_violation";
} {
	return { message: violation.message, status: 422, code: violation.code };
}
