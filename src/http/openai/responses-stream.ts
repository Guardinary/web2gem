import {
	EMPTY_UPSTREAM_MSG,
	createCompletionStreamLifecycle,
	recordCompletionStreamEvent,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
} from "../../completion";
import type { CompletionProvider } from "../../completion";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModel } from "../../models";
import type { FileRef } from "../../completion/types";
import {
	errorLogSummary,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";
import { log } from "../../shared/logging";
import { randHex } from "../../shared/crypto";
import { tokenCountFromCounts } from "../../shared/tokens";
import type { ToolChoicePolicy } from "../../toolcall/policy-openai";
import type { SSEWrite } from "../core/sse";
import {
	streamInterruptedWarningText,
	streamWarningObject,
} from "../core/stream-errors";
import { createDeltaCoalescer } from "../stream/coalescer";

type ResponseOutputItem = Record<string, unknown> & {
	id?: string;
	status?: string;
	content?: unknown;
	arguments?: string;
	call_id?: string;
	name?: string;
};
type StreamResponsesParams = {
	provider: CompletionProvider;
	rid: string;
	rm: Extract<ResolvedModel, { name: string }>;
	prompt: string;
	fileRefs: FileRef[] | null;
	tools: unknown;
	toolPolicy: ToolChoicePolicy | null | undefined;
	promptTokens: unknown;
	signal: AbortSignal;
};

export async function writeResponsesEvent(
	write: SSEWrite,
	event: string,
	payload: Record<string, unknown> | null | undefined,
): Promise<void> {
	const result = write(
		`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(payload || {}) })}\n\n`,
	);
	if (isPromiseLike(result)) await result;
}

export async function streamResponsesWithToolSieve(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: StreamResponsesParams,
) {
	const {
		provider,
		rid,
		rm,
		prompt,
		fileRefs,
		tools,
		toolPolicy,
		promptTokens,
		signal,
	} = params;
	const output: ResponseOutputItem[] = [];
	const mid = `msg_${randHex(12)}`;
	const textParts: string[] = [];
	let messageStarted = false;
	let contentStarted = false;
	let outputIndex = 0;
	const textDeltaCoalescer = createDeltaCoalescer(
		(delta) => {
			const piece = delta.output_text || "";
			return writeResponsesEvent(write, "response.output_text.delta", {
				item_id: mid,
				output_index: outputIndex,
				content_index: 0,
				delta: piece,
			});
		},
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);

	const fail = async (
		message: unknown,
		code: unknown,
		reason: unknown = undefined,
	) => {
		const error: Record<string, unknown> = {
			message,
			code: code || "upstream_error",
		};
		if (reason) error.reason = reason;
		await writeResponsesEvent(write, "response.failed", {
			response: {
				id: rid,
				object: "response",
				status: "failed",
				model: rm.name,
				output,
				error,
			},
		});
	};
	const startMessage = async () => {
		if (!messageStarted) {
			messageStarted = true;
			const item: ResponseOutputItem = {
				type: "message",
				id: mid,
				role: "assistant",
				status: "in_progress",
				content: [],
			};
			output.push(item);
			await writeResponsesEvent(write, "response.output_item.added", {
				output_index: outputIndex,
				item,
			});
		}
		if (!contentStarted) {
			contentStarted = true;
			await writeResponsesEvent(write, "response.content_part.added", {
				item_id: mid,
				output_index: outputIndex,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			});
		}
	};
	const emitText = async (piece: unknown) => {
		if (!piece) return;
		const textPiece = String(piece);
		await startMessage();
		textParts.push(textPiece);
		const appended = textDeltaCoalescer.append("output_text", textPiece);
		if (appended) await appended;
	};
	const finishMessage = async () => {
		if (!messageStarted) return;
		const flushed = textDeltaCoalescer.flush();
		if (flushed) await flushed;
		const item = output.find((it) => it.id === mid);
		const text =
			textParts.length === 1 ? textParts[0] || "" : textParts.join("");
		const part = { type: "output_text", text, annotations: [] };
		if (item) {
			item.status = "completed";
			item.content = [part];
		}
		if (contentStarted) {
			await writeResponsesEvent(write, "response.output_text.done", {
				item_id: mid,
				content_index: 0,
				text,
			});
			await writeResponsesEvent(write, "response.content_part.done", {
				item_id: mid,
				output_index: outputIndex,
				content_index: 0,
				part,
			});
		}
		await writeResponsesEvent(write, "response.output_item.done", {
			output_index: outputIndex,
			item,
		});
		outputIndex += 1;
	};

	await writeResponsesEvent(write, "response.created", {
		response: {
			id: rid,
			object: "response",
			status: "in_progress",
			model: rm.name,
			output: [],
		},
	});
	await writeResponsesEvent(write, "response.in_progress", {
		response: {
			id: rid,
			object: "response",
			status: "in_progress",
			model: rm.name,
			output: [],
		},
	});
	const lifecycle = createCompletionStreamLifecycle();
	if (tools) {
		for await (const event of streamToolSieveCompletionEvents(
			provider,
			{ prompt, rm, fileRefs, tools, toolPolicy },
			{ signal, coalesceTextDeltas: true },
		)) {
			recordCompletionStreamEvent(lifecycle, event);
			if (event.type === "text_delta") {
				await emitText(event.text);
			}
		}
		if (lifecycle.issue) {
			if (!lifecycle.emittedText && !lifecycle.toolCalls) {
				log(
					cfg,
					`openai responses stream failed before output model=${rm.name} code=${upstreamErrorCode(lifecycle.issue.error) || "upstream_error"} error=${errorLogSummary(lifecycle.issue.error)}`,
				);
				await fail(
					`upstream error: ${upstreamErrorMessage(lifecycle.issue.error)}`,
					upstreamErrorCode(lifecycle.issue.error) || "upstream_error",
					upstreamErrorReason(lifecycle.issue.error),
				);
				return;
			}
			const warning = `\n\n${streamInterruptedWarningText(lifecycle.issue.error)}`;
			log(
				cfg,
				`openai responses stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(lifecycle.issue.error) || "stream_interrupted"} error=${errorLogSummary(lifecycle.issue.error)}`,
			);
			await writeResponsesEvent(write, "response.warning", {
				warning: streamWarningObject(lifecycle.issue.error, warning.trim()),
			});
		}
		if (lifecycle.violation) {
			log(
				cfg,
				`openai responses stream tool policy violation model=${rm.name} code=${lifecycle.violation.code}`,
			);
			await fail(lifecycle.violation.message, lifecycle.violation.code);
			return;
		}
	} else {
		for await (const event of streamPlainCompletionEvents(
			provider,
			{ prompt, rm, fileRefs },
			{ signal, coalesceTextDeltas: true },
		)) {
			recordCompletionStreamEvent(lifecycle, event);
			if (event.type === "text_delta") {
				await emitText(event.text);
			}
		}
		if (lifecycle.issue) {
			if (!lifecycle.emittedText) {
				log(
					cfg,
					`openai responses stream failed before output model=${rm.name} code=${upstreamErrorCode(lifecycle.issue.error) || "upstream_error"} error=${errorLogSummary(lifecycle.issue.error)}`,
				);
				await fail(
					`upstream error: ${upstreamErrorMessage(lifecycle.issue.error)}`,
					upstreamErrorCode(lifecycle.issue.error) || "upstream_error",
					upstreamErrorReason(lifecycle.issue.error),
				);
				return;
			}
			const warning = `\n\n${streamInterruptedWarningText(lifecycle.issue.error)}`;
			log(
				cfg,
				`openai responses stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(lifecycle.issue.error) || "stream_interrupted"} error=${errorLogSummary(lifecycle.issue.error)}`,
			);
			await writeResponsesEvent(write, "response.warning", {
				warning: streamWarningObject(lifecycle.issue.error, warning.trim()),
			});
		}
	}
	if (!lifecycle.emittedText && !lifecycle.toolCalls) {
		log(cfg, `openai responses stream produced no content model=${rm.name}`);
		await fail(EMPTY_UPSTREAM_MSG, "upstream_empty");
		return;
	}
	await finishMessage();

	if (lifecycle.toolCalls?.length) {
		for (const tc of lifecycle.toolCalls) {
			const args = tc.function.arguments || "";
			const id = tc.id || "";
			const item: ResponseOutputItem = {
				type: "function_call",
				id,
				call_id: id,
				name: String(tc.function.name || ""),
				arguments: "",
				status: "in_progress",
			};
			output.push(item);
			await writeResponsesEvent(write, "response.output_item.added", {
				output_index: outputIndex,
				item,
			});
			if (args)
				await writeResponsesEvent(
					write,
					"response.function_call_arguments.delta",
					{
						item_id: item.id,
						output_index: outputIndex,
						call_id: item.call_id,
						delta: args,
					},
				);
			item.arguments = args;
			item.status = "completed";
			await writeResponsesEvent(
				write,
				"response.function_call_arguments.done",
				{
					item_id: item.id,
					call_id: item.call_id,
					name: item.name,
					arguments: item.arguments,
				},
			);
			await writeResponsesEvent(write, "response.output_item.done", {
				output_index: outputIndex,
				item,
			});
			outputIndex += 1;
		}
	}

	const inputTokens = Math.max(0, Number(promptTokens) || 0);
	const outputTokens = tokenCountFromCounts(lifecycle.completionCounts);
	const usage = {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: inputTokens + outputTokens,
	};
	await writeResponsesEvent(write, "response.completed", {
		response: {
			id: rid,
			object: "response",
			status: "completed",
			model: rm.name,
			output,
			usage,
		},
	});
}

function isPromiseLike(value: unknown): value is Promise<void> {
	return !!value && typeof (value as Promise<void>).then === "function";
}
