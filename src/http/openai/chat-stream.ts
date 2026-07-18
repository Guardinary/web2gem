import type {
	CompletionProvider,
	CompletionStreamIssue,
} from "../../completion";
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
import { errorLogSummary, upstreamErrorCode } from "../../shared/errors";
import { log } from "../../shared/logging";
import {
	combinedTokenCount,
	createTokenCounter,
	tokenCountFromCounts,
} from "../../promptcompat/token-accounting";
import { formatOpenAIStreamToolCalls } from "../../toolcall/openai-format";
import type { ToolChoicePolicy } from "../../toolcall/policy-openai";
import type { ToolBundle } from "../../toolcall/tool-bundle";
import type { SSEWrite } from "../core/sse";
import {
	streamInterruptedWarningText,
	writeStreamWarningEvent,
} from "../core/stream-errors";
import { createDeltaCoalescer } from "../stream/coalescer";
import {
	openAIChatChunk,
	writeOpenAIChatStreamError,
	writeOpenAIChatUsageTokenChunk,
} from "./format";

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
	rm: ResolvedModelOk;
	fileRefs: FileRef[] | null;
	includeUsage: boolean;
	promptTokens: number;
	signal: AbortSignal;
};
type OpenAIChatToolSieveStreamParams = OpenAIChatPlainStreamParams & {
	tools: ToolBundle | null;
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
		{ signal },
	)) {
		recordCompletionStreamEvent(lifecycle, event);
		if (event.type === "text_delta") {
			await deltaCoalescer.append("content", event.text);
		}
	}
	await flushOpenAIChatDeltas(deltaCoalescer);
	const outcome = classifyCompletionStreamOutcome(lifecycle);

	if (outcome.type === "failed_before_output" || outcome.type === "empty") {
		const issue =
			outcome.type === "failed_before_output" ? outcome.issue : null;
		const error = issue?.error || {
			message: EMPTY_UPSTREAM_MSG,
			code: "upstream_empty",
		};
		log(
			cfg,
			issue
				? `openai chat stream failed before output model=${rm.name} code=${upstreamErrorCode(error) || "upstream_error"} error=${errorLogSummary(error)}`
				: `openai chat stream produced no content model=${rm.name}`,
		);
		await writeOpenAIChatStreamError(write, id, model, error);
		return;
	}
	if (outcome.type === "interrupted_after_output") {
		await writeOpenAIChatInterrupted(write, cfg, rm, outcome.issue);
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
		{ prompt, rm, fileRefs, toolPolicy },
		{ signal },
	)) {
		recordCompletionStreamEvent(toolLifecycle, event);
		if (event.type === "text_delta") {
			await deltaCoalescer.append("content", event.text);
		}
	}
	await flushOpenAIChatDeltas(deltaCoalescer);
	const outcome = classifyCompletionStreamOutcome(toolLifecycle);

	if (outcome.type === "failed_before_output") {
		const error = outcome.issue.error;
		log(
			_cfg,
			`openai chat stream failed before output model=${rm.name} code=${upstreamErrorCode(error) || "upstream_error"} error=${errorLogSummary(error)}`,
		);
		await writeOpenAIChatStreamError(write, id, model, error);
		return;
	}
	if (outcome.type === "policy_violation") {
		log(
			_cfg,
			`openai chat stream tool policy violation model=${rm.name} code=${outcome.violation.code}`,
		);
		await writeOpenAIChatStreamError(write, id, model, outcome.violation);
		return;
	}
	if (outcome.type === "empty") {
		log(_cfg, `openai chat stream produced no content model=${rm.name}`);
		await writeOpenAIChatStreamError(write, id, model, {
			message: EMPTY_UPSTREAM_MSG,
			code: "upstream_empty",
		});
		return;
	}
	if (outcome.type === "interrupted_after_output") {
		if (toolLifecycle.toolCalls?.length) {
			log(
				_cfg,
				`openai chat stream interrupted after tool calls model=${rm.name} code=${upstreamErrorCode(outcome.issue.error) || "stream_interrupted"} error=${errorLogSummary(outcome.issue.error)}`,
			);
			await writeStreamWarningEvent(write, outcome.issue.error);
		} else {
			await writeOpenAIChatInterrupted(write, _cfg, rm, outcome.issue);
		}
	}
	if (toolLifecycle.toolCalls?.length) {
		const toolCallDeltas = formatOpenAIStreamToolCalls(
			toolLifecycle.toolCalls,
			new Map(),
			tools,
		);
		await writeChunk({ tool_calls: toolCallDeltas }, "tool_calls");
		extraTokenCounter.append(JSON.stringify(toolCallDeltas));
	} else {
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
	await coalescer.flush();
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
	rm: ResolvedModelOk,
	issue: CompletionStreamIssue,
): Promise<void> {
	const warning = `\n\n${streamInterruptedWarningText(issue.error)}`;
	log(
		cfg,
		`openai chat stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`,
	);
	await writeStreamWarningEvent(write, issue.error, warning.trim());
}
