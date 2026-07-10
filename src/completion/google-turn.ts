import { parseGoogleFunctionCalls } from "../toolcall/google";
import { validateGoogleFunctionCalls } from "../toolcall/policy-google";
import type { GoogleFunctionCall } from "../toolcall/google";
import type { LooseRequest } from "./types";

export type GoogleResponsePart =
	| { text: string }
	| { functionCall: GoogleFunctionCall };

export type GoogleCompletionTurn =
	| {
			responseParts: GoogleResponsePart[];
			upstreamEmpty: boolean;
			error?: undefined;
	  }
	| {
			error: {
				message: string;
				status: number;
				code?: string;
			};
			responseParts?: undefined;
			upstreamEmpty?: undefined;
	  };

export function finalizeGoogleCompletionResult(
	text: unknown,
	options: {
		effectiveReq: LooseRequest;
		effectiveGoogleTools: LooseRequest[] | null;
		hasTools: boolean;
	},
): GoogleCompletionTurn {
	const source = String(text || "");
	const responseParts: GoogleResponsePart[] = [];
	if (options.hasTools && source) {
		const [clean, fcs] = parseGoogleFunctionCalls(
			source,
			options.effectiveGoogleTools,
		);
		const googleToolViolation = validateGoogleFunctionCalls(
			options.effectiveReq,
			fcs,
		);
		if (googleToolViolation) {
			return {
				error: {
					message: googleToolViolation.message,
					status: 422,
					code: googleToolViolation.code,
				},
			};
		}
		if (fcs.length) {
			if (clean) responseParts.push({ text: clean });
			for (const fc of fcs)
				responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
		} else {
			responseParts.push({ text: source });
		}
	} else {
		const googleToolViolation = validateGoogleFunctionCalls(
			options.effectiveReq,
			[],
		);
		if (googleToolViolation) {
			return {
				error: {
					message: googleToolViolation.message,
					status: 422,
					code: googleToolViolation.code,
				},
			};
		}
		responseParts.push({
			text:
				source ||
				"I apologize, but I was unable to generate a response. Please try again.",
		});
	}
	return { responseParts, upstreamEmpty: !source };
}
