import { jsonResponse } from "../core/json";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorStatus,
} from "../../shared/runtime";

export function openAIErrorType(status: number): string {
	switch (status) {
		case 400:
			return "invalid_request_error";
		case 401:
			return "authentication_error";
		case 403:
			return "permission_error";
		case 429:
			return "rate_limit_error";
		case 503:
			return "service_unavailable_error";
		default:
			return status >= 500 ? "api_error" : "invalid_request_error";
	}
}

export function openAIErrorResponse(
	message: unknown,
	status = 400,
	code: unknown = null,
): Response {
	return jsonResponse(
		{
			error: {
				message,
				type: openAIErrorType(status),
				code: code || null,
				param: null,
			},
		},
		status,
	);
}

export function openAIUpstreamErrorResponse(e: unknown): Response {
	return openAIErrorResponse(
		`upstream error: ${upstreamErrorMessage(e)}`,
		upstreamErrorStatus(e) || 502,
		upstreamErrorCode(e),
	);
}
