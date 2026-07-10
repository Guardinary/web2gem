import { upstreamErrorCode, upstreamErrorMessage } from "../../shared/runtime";
import type { SSEWrite } from "./sse";

export function streamErrorText(e: unknown, prefix = "upstream error"): string {
	const code = upstreamErrorCode(e);
	return `⚠️ ${prefix}: ${upstreamErrorMessage(e)}${code ? ` [${code}]` : ""}`;
}

export function streamInterruptedWarningText(e: unknown): string {
	return streamErrorText(e, "stream interrupted after partial output");
}

export function streamWarningObject(
	e: unknown,
	message: unknown = undefined,
): { code: string; message: unknown } {
	return {
		code: upstreamErrorCode(e) || "stream_interrupted",
		message: message || streamInterruptedWarningText(e),
	};
}

export async function writeStreamWarningEvent(
	write: SSEWrite,
	e: unknown,
	message: unknown = undefined,
): Promise<void> {
	const result = write(
		`event: warning\ndata: ${JSON.stringify({ warning: streamWarningObject(e, message) })}\n\n`,
	);
	if (result && typeof (result as Promise<void>).then === "function")
		await result;
}
