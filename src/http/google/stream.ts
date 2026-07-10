import { streamPlainCompletionEvents } from "../../completion";
import type {
	CompletionProvider,
	CompletionStreamEvent,
} from "../../completion";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModel } from "../../models";
import type { FileRef, LooseRequest } from "../../completion/types";
import { streamGoogleToolCompletionEvents } from "../../completion/google";
import {
	combinedTokenCount,
	createTokenCounter,
	emptyTokenCounts,
} from "../../shared/tokens";
import { errorLogSummary, log, upstreamErrorCode } from "../../shared/runtime";
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

type StreamIssue = Extract<
	CompletionStreamEvent,
	{ type: "warning" } | { type: "stream_error" }
>;
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
	const extraTokenCounter = createTokenCounter();
	let completionCounts = emptyTokenCounts();
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
	let emittedText = false;
	let issue: StreamIssue | null = null;
	for await (const event of streamPlainCompletionEvents(
		provider,
		{ prompt, rm, fileRefs },
		{ signal, coalesceTextDeltas: true },
	)) {
		if (event.type === "text_delta") {
			emittedText = true;
			const appended = textCoalescer.append("text", event.text);
			if (appended) await appended;
		} else if (event.type === "warning" || event.type === "stream_error") {
			issue = event;
		} else if (event.type === "done") {
			completionCounts = event.completionCounts;
		}
	}
	let flushed = textCoalescer.flush();
	if (flushed) await flushed;
	if (issue) {
		if (!emittedText) {
			log(
				cfg,
				`google stream failed before output model=${rm.name} code=${upstreamErrorCode(issue.error) || "upstream_error"} error=${errorLogSummary(issue.error)}`,
			);
			await writeGoogleStreamError(write, rm.name, issue.error);
			return;
		}
		const warning = `\n\n${streamInterruptedWarningText(issue.error)}`;
		log(
			cfg,
			`google stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`,
		);
		await writeStreamWarningEvent(write, issue.error, warning.trim());
		extraTokenCounter.append(warning);
		const appended = textCoalescer.append("text", warning);
		if (appended) await appended;
		flushed = textCoalescer.flush();
		if (flushed) await flushed;
	}
	const candidateTokens = combinedTokenCount(
		completionCounts,
		extraTokenCounter,
	);
	await write(
		`data: ${JSON.stringify(googleStreamDonePayload(rm.name, promptTokens, candidateTokens, issue ? issue.error : null))}\n\n`,
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
