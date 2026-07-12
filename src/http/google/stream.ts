import {
	createCompletionStreamLifecycle,
	recordCompletionStreamEvent,
	streamPlainCompletionEvents,
} from "../../completion";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModel } from "../../models";
import type { FileRef, LooseRequest } from "../../completion/types";
import { streamGoogleToolCompletionEvents } from "../../completion/google";
import { tokenCountFromCounts } from "../../shared/tokens";
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import type { SSEWrite } from "../core/sse";
import {
	streamInterruptedWarningText,
	writeStreamWarningEvent,
} from "../core/stream-errors";
import { createDeltaCoalescer } from "../stream/coalescer";
import {
	googleStreamDonePayload,
	writeGoogleCandidate,
	writeGoogleDone,
	writeGoogleStreamError,
} from "./format";

type ResolvedCompletionModel = Extract<ResolvedModel, { name: string }>;
type GooglePlainStreamParams = {
	provider: CompletionProvider;
	prompt: string;
	rm: ResolvedCompletionModel;
	fileRefs: FileRef[] | null;
	promptTokens: number;
	signal: AbortSignal;
};
type GoogleToolStreamParams = GooglePlainStreamParams & {
	tools: LooseRequest[] | null;
	effectiveReq: LooseRequest;
};

export async function streamGooglePlain(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: GooglePlainStreamParams,
) {
	const { provider, prompt, rm, fileRefs, promptTokens, signal } = params;
	const lifecycle = createCompletionStreamLifecycle();
	const textCoalescer = createDeltaCoalescer(
		(delta) => {
			const text = delta.text || "";
			return write(
				`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: "model" }, index: 0 }], modelVersion: rm.name })}\n\n`,
			);
		},
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);
	for await (const event of streamPlainCompletionEvents(
		provider,
		{ prompt, rm, fileRefs },
		{ signal, coalesceTextDeltas: true },
	)) {
		recordCompletionStreamEvent(lifecycle, event);
		if (event.type === "text_delta") {
			const appended = textCoalescer.append("text", event.text);
			if (appended) await appended;
		}
	}
	const flushed = textCoalescer.flush();
	if (flushed) await flushed;
	if (lifecycle.issue) {
		if (!lifecycle.emittedText) {
			log(
				cfg,
				`google stream failed before output model=${rm.name} code=${upstreamErrorCode(lifecycle.issue.error) || "upstream_error"} error=${errorLogSummary(lifecycle.issue.error)}`,
			);
			await writeGoogleStreamError(write, rm.name, lifecycle.issue.error);
			return;
		}
		const warning = `\n\n${streamInterruptedWarningText(lifecycle.issue.error)}`;
		log(
			cfg,
			`google stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(lifecycle.issue.error) || "stream_interrupted"} error=${errorLogSummary(lifecycle.issue.error)}`,
		);
		await writeStreamWarningEvent(write, lifecycle.issue.error, warning.trim());
	}
	const candidateTokens = tokenCountFromCounts(lifecycle.completionCounts);
	await write(
		`data: ${JSON.stringify(googleStreamDonePayload(rm.name, promptTokens, candidateTokens, lifecycle.issue ? lifecycle.issue.error : null))}\n\n`,
	);
}

export async function streamGoogleTools(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: GoogleToolStreamParams,
) {
	const {
		provider,
		prompt,
		rm,
		fileRefs,
		tools,
		effectiveReq,
		promptTokens,
		signal,
	} = params;
	for await (const event of streamGoogleToolCompletionEvents(provider, {
		prompt,
		rm,
		fileRefs,
		tools,
		effectiveReq,
		promptTokens,
		signal,
	})) {
		if (event.type === "candidate") {
			await writeGoogleCandidate(
				write,
				rm.name,
				event.parts,
				event.finishReason,
			);
		} else if (event.type === "error") {
			log(
				cfg,
				`google tool stream failed before output model=${rm.name} code=${upstreamErrorCode(event.error) || "upstream_error"} error=${errorLogSummary(event.error)}`,
			);
			await writeGoogleStreamError(write, rm.name, event.error);
			return;
		} else if (event.type === "warning") {
			log(
				cfg,
				`google tool stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(event.error) || "stream_interrupted"} error=${errorLogSummary(event.error)}`,
			);
			await writeStreamWarningEvent(write, event.error, event.message);
		} else if (event.type === "tool_policy_violation") {
			log(
				cfg,
				`google tool stream policy violation model=${rm.name} code=${event.violation.code}`,
			);
			await writeGoogleStreamError(write, rm.name, {
				message: event.violation.message,
				code: event.violation.code,
			});
			return;
		} else if (event.type === "done") {
			await writeGoogleDone(write, rm.name, event.usageMetadata);
		}
	}
}
