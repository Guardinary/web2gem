import { streamWarningObject } from "../core/stream-errors";
import type { SSEWrite } from "../core/sse";
import {
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";
import type { GoogleResponsePart } from "../../completion/google-turn";

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
	const result = write(
		`data: ${JSON.stringify({
			error,
			modelVersion: model,
		})}\n\n`,
	);
	if (isPromiseLike(result)) await result;
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
	const result = write(
		`data: ${JSON.stringify({ candidates: [candidate], modelVersion: model })}\n\n`,
	);
	if (isPromiseLike(result)) await result;
}

export async function writeGoogleDone(
	write: SSEWrite,
	model: unknown,
	usageMetadata: unknown,
): Promise<void> {
	const result = write(
		`data: ${JSON.stringify({
			candidates: [{ finishReason: "STOP", index: 0 }],
			usageMetadata,
			modelVersion: model,
		})}\n\n`,
	);
	if (isPromiseLike(result)) await result;
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

function isPromiseLike(value: unknown): value is Promise<void> {
	return !!value && typeof (value as Promise<void>).then === "function";
}
