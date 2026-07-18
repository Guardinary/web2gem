import type { GeminiRouteTuple } from "../accounts/route-types";
import { isGeminiRouteTuple } from "../accounts/routes";

export const GEMINI_MODEL_HEADER_KEY = "x-goog-ext-525001261-jspb";

export function buildGeminiModelHeaders(
	route: GeminiRouteTuple,
	extended: boolean,
	sessionId: string,
): Record<string, string> {
	if (!isGeminiRouteTuple(route)) throw new Error("invalid Gemini route tuple");
	const normalizedSessionId = String(sessionId || "")
		.trim()
		.toUpperCase();
	if (!normalizedSessionId)
		throw new Error("missing Gemini provider session id");
	const payload: unknown[] = [
		1,
		null,
		null,
		null,
		route.providerModelId,
		null,
		null,
		0,
		[4, 5, 6, 8],
		null,
		null,
	];
	payload[route.capacityField - 1] = route.capacity;
	payload[route.capacityField] = null;
	payload[route.capacityField + 1] = null;
	payload[route.capacityField + 2] = route.modelNumber;
	payload.push(extended ? 2 : 1, normalizedSessionId);
	return {
		[GEMINI_MODEL_HEADER_KEY]: JSON.stringify(payload),
		"x-goog-ext-73010989-jspb": "[0]",
		"x-goog-ext-73010990-jspb": "[0,0,0]",
	};
}
