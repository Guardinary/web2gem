import { streamWarningObject } from "../core/stream-errors";
import type { SSEWrite } from "../core/sse";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
	upstreamErrorStatus,
} from "../../shared/errors";
import { jsonResponse } from "../core/json";
import type { GenerationProtocol } from "../generation";
import type { GoogleResponsePart } from "../../completion/turn";

export function googleErrorResponseBody(
	message: unknown,
	code: unknown = undefined,
	reason: unknown = undefined,
) {
	const error: Record<string, unknown> = { message };
	if (code) error.code = code;
	if (reason) error.reason = reason;
	return { error };
}

export async function writeGoogleStreamError(
	write: SSEWrite,
	model: unknown,
	e: unknown,
): Promise<void> {
	const error: Record<string, unknown> = {
		message: upstreamErrorMessage(e),
		code: upstreamErrorCode(e) || "upstream_error",
	};
	const reason = upstreamErrorReason(e);
	if (reason) error.reason = reason;
	await write(
		`data: ${JSON.stringify({
			error,
			modelVersion: model,
		})}\n\n`,
	);
}

export async function writeGoogleCandidate(
	write: SSEWrite,
	model: unknown,
	parts: GoogleResponsePart[] | null,
	finishReason: string | null,
): Promise<void> {
	const candidate: Record<string, unknown> = { index: 0 };
	if (Array.isArray(parts) && parts.length)
		candidate.content = { parts, role: "model" };
	if (finishReason) candidate.finishReason = finishReason;
	await write(
		`data: ${JSON.stringify({ candidates: [candidate], modelVersion: model })}\n\n`,
	);
}

export async function writeGoogleDone(
	write: SSEWrite,
	model: unknown,
	usageMetadata: unknown,
): Promise<void> {
	await write(
		`data: ${JSON.stringify({
			candidates: [{ finishReason: "STOP", index: 0 }],
			usageMetadata,
			modelVersion: model,
		})}\n\n`,
	);
}

export function googleGenerateContentResponse(params: {
	model: string;
	responseParts: GoogleResponsePart[];
	promptTokens: number;
	candidateTokens: number;
	upstreamEmpty: boolean;
	warning?: unknown;
}) {
	const responseObj: Record<string, unknown> = {
		candidates: [
			{
				content: { parts: params.responseParts, role: "model" },
				finishReason: "STOP",
				index: 0,
			},
		],
		usageMetadata: {
			promptTokenCount: params.promptTokens,
			candidatesTokenCount: params.candidateTokens,
			totalTokenCount: params.promptTokens + params.candidateTokens,
		},
		modelVersion: params.model,
	};
	if (params.upstreamEmpty)
		responseObj.promptFeedback = {
			blockReason: "OTHER",
			warning: params.warning,
		};
	return responseObj;
}

export function googleStreamDonePayload(
	model: string,
	promptTokens: number,
	candidateTokens: number,
	streamErr: unknown = null,
) {
	const donePayload: Record<string, unknown> = {
		candidates: [{ finishReason: "STOP", index: 0 }],
		usageMetadata: {
			promptTokenCount: promptTokens,
			candidatesTokenCount: candidateTokens,
			totalTokenCount: promptTokens + candidateTokens,
		},
		modelVersion: model,
	};
	if (streamErr)
		donePayload.promptFeedback = { warning: streamWarningObject(streamErr) };
	return donePayload;
}

export const GOOGLE_GENERATION_PROTOCOL: GenerationProtocol = {
	errorResponse: (error) =>
		jsonResponse(
			googleErrorResponseBody(error.message, error.code, error.reason),
			error.status,
		),
	upstreamErrorResponse: (e) =>
		jsonResponse(
			googleErrorResponseBody(
				`upstream error: ${upstreamErrorMessage(e)}`,
				upstreamErrorCode(e) || "upstream_error",
				upstreamErrorReason(e),
			),
			upstreamErrorStatus(e) || 502,
		),
};
