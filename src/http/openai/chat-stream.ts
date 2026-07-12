import { parseJsonObject } from "../core/json";
import type { SSEWrite } from "../core/sse";
import {
	streamInterruptedWarningText,
	writeStreamWarningEvent,
} from "../core/stream-errors";
import { createDeltaCoalescer } from "../stream/coalescer";
import {
	EMPTY_UPSTREAM_MSG,
	createCompletionStreamLifecycle,
	recordCompletionStreamEvent,
	streamPlainCompletionEvents,
	streamToolSieveCompletionEvents,
} from "../../completion";
import type {
	CompletionProvider,
	CompletionStreamEvent,
} from "../../completion";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModel } from "../../models";
import type { FileRef } from "../../completion/types";
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import {
	combinedTokenCount,
	createTokenCounter,
	tokenCountFromCounts,
} from "../../shared/tokens";
import { formatOpenAIStreamToolCalls } from "../../toolcall/openai-format";
import type { OpenAIToolCall } from "../../toolcall/openai-format";
import type { ToolChoicePolicy } from "../../toolcall/policy-openai";
import { openAIChatChunk, writeOpenAIChatUsageTokenChunk } from "./format";
import { writeOpenAIChatStreamError } from "./format";

type StreamIssue = Extract<
	CompletionStreamEvent,
	{ type: "warning" } | { type: "stream_error" }
>;
type ResolvedCompletionModel = Extract<ResolvedModel, { name: string }>;
type OpenAIChatChunkWriter = (
	delta: Record<string, unknown>,
	finish: string | null,
) => void | Promise<void>;
type OpenAIChatDeltaCoalescer = ReturnType<typeof createDeltaCoalescer>;
type OpenAIChatPlainStreamParams = {
	provider: CompletionProvider;
	id: string;
	model: string;
	prompt: string;
	rm: ResolvedCompletionModel;
	fileRefs: FileRef[] | null;
	includeUsage: boolean;
	promptTokens: number;
	signal: AbortSignal;
};
type OpenAIChatToolSieveStreamParams = OpenAIChatPlainStreamParams & {
	tools: unknown[];
	toolPolicy: ToolChoicePolicy | null | undefined;
};

export async function streamOpenAIChatPlain(
	write: SSEWrite,
	cfg: RuntimeConfig,
	params: OpenAIChatPlainStreamParams,
) {
	const {
		provider,
		id,
		model,
		prompt,
		rm,
		fileRefs,
		includeUsage,
		promptTokens,
		signal,
	} = params;
	const lifecycle = createCompletionStreamLifecycle();
	const writeChunk = (delta: Record<string, unknown>, finish: string | null) =>
		write(
			`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`,
		);
	const deltaCoalescer = createDeltaCoalescer(
		(delta) => writeChunk(delta, null),
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);
	await writeChunk({ role: "assistant" }, null);

	for await (const event of streamPlainCompletionEvents(
		provider,
		{ prompt, rm, fileRefs },
		{ signal, coalesceTextDeltas: true },
	)) {
		recordCompletionStreamEvent(lifecycle, event);
		if (event.type === "text_delta") {
			const appended = deltaCoalescer.append("content", event.text);
			if (appended) await appended;
		}
	}
	await flushOpenAIChatDeltas(deltaCoalescer);

	if (
		(lifecycle.issue && lifecycle.issue.type === "stream_error") ||
		lifecycle.empty
	) {
		const error = lifecycle.issue?.error || {
			message: EMPTY_UPSTREAM_MSG,
			code: "upstream_empty",
		};
		log(
			cfg,
			lifecycle.issue
				? `openai chat stream failed before output model=${rm.name} code=${upstreamErrorCode(error) || "upstream_error"} error=${errorLogSummary(error)}`
				: `openai chat stream produced no content model=${rm.name}`,
		);
		await writeOpenAIChatStreamError(write, id, model, error);
		return;
	} else if (lifecycle.issue) {
		await writeOpenAIChatInterrupted(write, cfg, rm, lifecycle.issue);
	}
	await finishOpenAIChatStream(
		write,
		writeChunk,
		id,
		model,
		includeUsage,
		promptTokens,
		lifecycle.completionCounts,
	);
}

export async function streamOpenAIChatWithToolSieve(
	write: SSEWrite,
	_cfg: RuntimeConfig,
	params: OpenAIChatToolSieveStreamParams,
) {
	const {
		provider,
		id,
		model,
		prompt,
		rm,
		fileRefs,
		tools,
		toolPolicy,
		includeUsage,
		promptTokens,
		signal,
	} = params;
	const extraTokenCounter = createTokenCounter();
	const writeChunk = (delta: Record<string, unknown>, finish: string | null) =>
		write(
			`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`,
		);
	const deltaCoalescer = createDeltaCoalescer(
		(delta) => writeChunk(delta, null),
		undefined,
		undefined,
		{ emitFirstImmediately: true },
	);
	const toolLifecycle = createCompletionStreamLifecycle();
	await writeChunk({ role: "assistant" }, null);

	for await (const event of streamToolSieveCompletionEvents(
		provider,
		{ prompt, rm, fileRefs, tools, toolPolicy },
		{ signal, coalesceTextDeltas: true },
	)) {
		recordCompletionStreamEvent(toolLifecycle, event);
		if (event.type === "text_delta") {
			const appended = deltaCoalescer.append("content", event.text);
			if (appended) await appended;
		}
	}
	await flushOpenAIChatDeltas(deltaCoalescer);

	if (toolLifecycle.violation) {
		await flushOpenAIChatDeltas(deltaCoalescer);
		log(
			_cfg,
			`openai chat stream tool policy violation model=${rm.name} code=${toolLifecycle.violation.code}`,
		);
		await writeOpenAIChatStreamError(write, id, model, toolLifecycle.violation);
		return;
	}
	if (toolLifecycle.toolCalls?.length) {
		await flushOpenAIChatDeltas(deltaCoalescer);
		if (toolLifecycle.issue) {
			log(
				_cfg,
				`openai chat stream interrupted after tool calls model=${rm.name} code=${upstreamErrorCode(toolLifecycle.issue.error) || "stream_interrupted"} error=${errorLogSummary(toolLifecycle.issue.error)}`,
			);
			await writeStreamWarningEvent(write, toolLifecycle.issue.error);
		}
		const toolCallDeltas = formatOpenAIStreamToolCalls(
			toolLifecycle.toolCalls.map(openAIStreamToolCallInput),
			new Map(),
			tools,
		);
		await writeChunk({ tool_calls: toolCallDeltas }, "tool_calls");
		extraTokenCounter.append(JSON.stringify(toolLifecycle.toolCalls));
	} else {
		if (!toolLifecycle.emittedText || toolLifecycle.empty) {
			const error = toolLifecycle.issue?.error || {
				message: EMPTY_UPSTREAM_MSG,
				code: "upstream_empty",
			};
			log(
				_cfg,
				toolLifecycle.issue
					? `openai chat stream failed before output model=${rm.name} code=${upstreamErrorCode(error) || "upstream_error"} error=${errorLogSummary(error)}`
					: `openai chat stream produced no content model=${rm.name}`,
			);
			await writeOpenAIChatStreamError(write, id, model, error);
			return;
		} else if (toolLifecycle.issue) {
			await writeOpenAIChatInterrupted(write, _cfg, rm, toolLifecycle.issue);
		}
		await writeChunk({}, "stop");
	}
	if (includeUsage)
		await writeOpenAIChatUsageTokenChunk(
			write,
			id,
			model,
			promptTokens,
			combinedTokenCount(toolLifecycle.completionCounts, extraTokenCounter),
		);
	await write("data: [DONE]\n\n");
}

async function flushOpenAIChatDeltas(
	coalescer: OpenAIChatDeltaCoalescer,
): Promise<void> {
	const flushed = coalescer.flush();
	if (flushed) await flushed;
}

async function finishOpenAIChatStream(
	write: SSEWrite,
	writeChunk: OpenAIChatChunkWriter,
	id: string,
	model: string,
	includeUsage: boolean,
	promptTokens: number,
	completionCounts: Parameters<typeof tokenCountFromCounts>[0],
): Promise<void> {
	await writeChunk({}, "stop");
	if (includeUsage)
		await writeOpenAIChatUsageTokenChunk(
			write,
			id,
			model,
			promptTokens,
			tokenCountFromCounts(completionCounts),
		);
	await write("data: [DONE]\n\n");
}

async function writeOpenAIChatInterrupted(
	write: SSEWrite,
	cfg: RuntimeConfig,
	rm: ResolvedCompletionModel,
	issue: StreamIssue,
): Promise<void> {
	const warning = `\n\n${streamInterruptedWarningText(issue.error)}`;
	log(
		cfg,
		`openai chat stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`,
	);
	await writeStreamWarningEvent(write, issue.error, warning.trim());
}

function openAIStreamToolCallInput(toolCall: OpenAIToolCall): {
	name: unknown;
	input: unknown;
} {
	return {
		name: toolCall.function.name,
		input: parseJsonObject(toolCall.function.arguments),
	};
}
