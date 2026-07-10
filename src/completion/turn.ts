import { finalizeStructuredOutputText } from "../toolcall/structured";
import { parseToolCalls } from "../toolcall/dsml";
import { validateRequiredToolCalls } from "../toolcall/policy-openai";
import type { OpenAIToolCall } from "../toolcall/openai-format";
import type { ToolChoicePolicy } from "../toolcall/policy-openai";

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
			upstreamEmpty: boolean;
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
			upstreamEmpty?: undefined;
	  };

export function upstreamEmptyWarning(
	cfg: { gemini_bl?: unknown } | null | undefined,
) {
	return {
		code: "upstream_empty",
		message: EMPTY_UPSTREAM_MSG,
		hint: "Current GEMINI_BL is included for diagnostics; empty responses are not always caused by an outdated build label.",
		gemini_bl: cfg?.gemini_bl,
	};
}

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
		return {
			error: { message: violation.message, status: 422, code: violation.code },
		};
	}
	return {
		text: outText,
		toolCalls,
		upstreamEmpty: !outText && !toolCalls,
	};
}
