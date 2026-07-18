import type { CompletionProvider } from "../../completion";
import {
	classifyCompletionStreamOutcome,
	createCompletionStreamLifecycle,
	EMPTY_UPSTREAM_MSG,
	recordCompletionStreamEvent,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
} from "../../completion";
import type { FileRef } from "../../completion/types";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModelOk } from "../../models";
import { randHex } from "../../shared/crypto";
import {
	errorLogSummary,
	upstreamErrorCode,
	upstreamErrorMessage,
	upstreamErrorReason,
} from "../../shared/errors";
import { log } from "../../shared/logging";
import { tokenCountFromCounts } from "../../promptcompat/token-accounting";
import { formatOpenAIToolCalls } from "../../toolcall/openai-format";
import type { ToolChoicePolicy } from "../../toolcall/policy-openai";
import type { ToolBundle } from "../../toolcall/tool-bundle";
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
	rm: ResolvedModelOk;
	prompt: string;
	fileRefs: FileRef[] | null;
	tools: ToolBundle | null;
	toolPolicy: ToolChoicePolicy | null | undefined;
	promptTokens: unknown;
	signal: AbortSignal;
};

export async function writeResponsesEvent(
	write: SSEWrite,
	event: string,
	payload: Record<string, unknown> | null | undefined,
): Promise<void> {
	await write(
		`event: ${event}\ndata: ${JSON.stringify({ type: event, ...(payload || {}) })}\n\n`,
	);
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
		await textDeltaCoalescer.append("output_text", textPiece);
	};
	const finishMessage = async () => {
		if (!messageStarted) return;
		await textDeltaCoalescer.flush();
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
			{ prompt, rm, fileRefs, toolPolicy },
			{ signal },
		)) {
			recordCompletionStreamEvent(lifecycle, event);
			if (event.type === "text_delta") {
				await emitText(event.text);
			}
		}
	} else {
		for await (const event of streamPlainCompletionEvents(
			provider,
			{ prompt, rm, fileRefs },
			{ signal },
		)) {
			recordCompletionStreamEvent(lifecycle, event);
			if (event.type === "text_delta") {
				await emitText(event.text);
			}
		}
	}
	await textDeltaCoalescer.flush();
	const outcome = classifyCompletionStreamOutcome(lifecycle);
	if (outcome.type === "failed_before_output") {
		const error = outcome.issue.error;
		log(
			cfg,
			`openai responses stream failed before output model=${rm.name} code=${upstreamErrorCode(error) || "upstream_error"} error=${errorLogSummary(error)}`,
		);
		await fail(
			`upstream error: ${upstreamErrorMessage(error)}`,
			upstreamErrorCode(error) || "upstream_error",
			upstreamErrorReason(error),
		);
		return;
	}
	if (outcome.type === "policy_violation") {
		log(
			cfg,
			`openai responses stream tool policy violation model=${rm.name} code=${outcome.violation.code}`,
		);
		await fail(outcome.violation.message, outcome.violation.code);
		return;
	}
	if (outcome.type === "empty") {
		log(cfg, `openai responses stream produced no content model=${rm.name}`);
		await fail(EMPTY_UPSTREAM_MSG, "upstream_empty");
		return;
	}
	if (outcome.type === "interrupted_after_output") {
		const error = outcome.issue.error;
		const warning = `\n\n${streamInterruptedWarningText(error)}`;
		log(
			cfg,
			`openai responses stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(error) || "stream_interrupted"} error=${errorLogSummary(error)}`,
		);
		await writeResponsesEvent(write, "response.warning", {
			warning: streamWarningObject(error, warning.trim()),
		});
	}
	await finishMessage();

	if (lifecycle.toolCalls?.length) {
		const formattedToolCalls = formatOpenAIToolCalls(
			lifecycle.toolCalls,
			tools,
		);
		for (const tc of formattedToolCalls) {
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
