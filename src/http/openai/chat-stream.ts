import { parseJsonObject } from "../core/json";
import type { SSEWrite } from "../core/sse";
import { streamErrorText, streamInterruptedWarningText, writeStreamWarningEvent } from "../core/stream-errors";
import { createDeltaCoalescer } from "../stream/coalescer";
import { EMPTY_UPSTREAM_MSG, streamPlainCompletionEvents, streamToolSieveCompletionEvents } from "../../completion";
import type { CompletionProvider, CompletionStreamEvent } from "../../completion";
import type { RuntimeConfig } from "../../config";
import type { ResolvedModel } from "../../models";
import type { FileRef } from "../../completion/types";
import { errorLogSummary, log, upstreamErrorCode } from "../../shared/runtime";
import { combinedTokenCount, createTokenCounter, emptyTokenCounts } from "../../shared/tokens";
import { formatOpenAIStreamToolCalls } from "../../toolcall/openai-format";
import type { OpenAIToolCall } from "../../toolcall/openai-format";
import type { ToolChoicePolicy } from "../../toolcall/policy-openai";
import { openAIChatChunk, writeOpenAIChatUsageTokenChunk } from "./format";

type StreamIssue = Extract<CompletionStreamEvent, { type: "warning" } | { type: "stream_error" }>;
type ResolvedCompletionModel = Extract<ResolvedModel, { name: string }>;
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

export async function streamOpenAIChatPlain(write: SSEWrite, cfg: RuntimeConfig, params: OpenAIChatPlainStreamParams) {
  const { provider, id, model, prompt, rm, fileRefs, includeUsage, promptTokens, signal } = params;
  const extraTokenCounter = createTokenCounter();
  let completionCounts = emptyTokenCounts();
  const writeChunk = (delta: Record<string, unknown>, finish: string | null) => write(`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`);
  const deltaCoalescer = createDeltaCoalescer((delta) => writeChunk(delta, null), undefined, undefined, { emitFirstImmediately: true });
  let issue: StreamIssue | null = null;
  let empty = false;
  await writeChunk({ role: "assistant" }, null);

  for await (const event of streamPlainCompletionEvents(provider, { prompt, rm, fileRefs }, { signal, coalesceTextDeltas: true })) {
    if (event.type === "text_delta") {
      const appended = deltaCoalescer.append("content", event.text);
      if (appended) await appended;
    } else if (event.type === "warning" || event.type === "stream_error") {
      issue = event;
    } else if (event.type === "empty") {
      empty = true;
    } else if (event.type === "done") {
      completionCounts = event.completionCounts;
    }
  }
  const flushed = deltaCoalescer.flush();
  if (flushed) await flushed;

  if ((issue && issue.type === "stream_error") || empty) {
    const note = issue ? streamErrorText(issue.error) : EMPTY_UPSTREAM_MSG;
    log(cfg, issue
      ? `openai chat stream failed before output model=${rm.name} code=${upstreamErrorCode(issue.error) || "upstream_error"} error=${errorLogSummary(issue.error)}`
      : `openai chat stream produced no content model=${rm.name}`);
    extraTokenCounter.append(note);
    await writeChunk({ content: note }, null);
  } else if (issue) {
    const warning = "\n\n" + streamInterruptedWarningText(issue.error);
    log(cfg, `openai chat stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`);
    await writeStreamWarningEvent(write, issue.error, warning.trim());
    extraTokenCounter.append(warning);
    await writeChunk({ content: warning }, null);
  }
  await writeChunk({}, "stop");
  if (includeUsage) await writeOpenAIChatUsageTokenChunk(write, id, model, promptTokens, combinedTokenCount(completionCounts, extraTokenCounter));
  await write("data: [DONE]\n\n");
}

export async function streamOpenAIChatWithToolSieve(write: SSEWrite, _cfg: RuntimeConfig, params: OpenAIChatToolSieveStreamParams) {
  const { provider, id, model, prompt, rm, fileRefs, tools, toolPolicy, includeUsage, promptTokens, signal } = params;
  const extraTokenCounter = createTokenCounter();
  let completionCounts = emptyTokenCounts();
  const writeChunk = (delta: Record<string, unknown>, finish: string | null) => write(`data: ${JSON.stringify(openAIChatChunk(id, model, delta, finish))}\n\n`);
  const deltaCoalescer = createDeltaCoalescer((delta) => writeChunk(delta, null), undefined, undefined, { emitFirstImmediately: true });
  let emittedText = false;
  let issue: StreamIssue | null = null;
  let violation: Extract<CompletionStreamEvent, { type: "tool_policy_violation" }>["violation"] | null = null;
  let toolCalls: OpenAIToolCall[] | null = null;
  let empty = false;
  await writeChunk({ role: "assistant" }, null);

  for await (const event of streamToolSieveCompletionEvents(provider, { prompt, rm, fileRefs, tools, toolPolicy }, { signal, coalesceTextDeltas: true })) {
    if (event.type === "text_delta") {
      emittedText = true;
      const appended = deltaCoalescer.append("content", event.text);
      if (appended) await appended;
    } else if (event.type === "warning" || event.type === "stream_error") {
      issue = event;
    } else if (event.type === "tool_policy_violation") {
      violation = event.violation;
    } else if (event.type === "tool_calls") {
      toolCalls = event.toolCalls;
    } else if (event.type === "empty") {
      empty = true;
    } else if (event.type === "done") {
      completionCounts = event.completionCounts;
    }
  }
  let flushed = deltaCoalescer.flush();
  if (flushed) await flushed;

  if (violation) {
    flushed = deltaCoalescer.flush();
    if (flushed) await flushed;
    log(_cfg, `openai chat stream tool policy violation model=${rm.name} code=${violation.code}`);
    extraTokenCounter.append(violation.message);
    await writeChunk({ content: violation.message }, null);
    await writeChunk({}, "stop");
    if (includeUsage) await writeOpenAIChatUsageTokenChunk(write, id, model, promptTokens, combinedTokenCount(completionCounts, extraTokenCounter));
    await write("data: [DONE]\n\n");
    return;
  }
  if (toolCalls && toolCalls.length) {
    flushed = deltaCoalescer.flush();
    if (flushed) await flushed;
    if (issue) {
      log(_cfg, `openai chat stream interrupted after tool calls model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`);
      await writeStreamWarningEvent(write, issue.error);
    }
    const toolCallDeltas = formatOpenAIStreamToolCalls(toolCalls.map(openAIStreamToolCallInput), new Map(), tools);
    await writeChunk({ tool_calls: toolCallDeltas }, "tool_calls");
    extraTokenCounter.append(JSON.stringify(toolCalls));
  } else {
    if (!emittedText || empty) {
      const note = issue ? streamErrorText(issue.error) : EMPTY_UPSTREAM_MSG;
      log(_cfg, issue
        ? `openai chat stream failed before output model=${rm.name} code=${upstreamErrorCode(issue.error) || "upstream_error"} error=${errorLogSummary(issue.error)}`
        : `openai chat stream produced no content model=${rm.name}`);
      extraTokenCounter.append(note);
      await writeChunk({ content: note }, null);
    } else if (issue) {
      const warning = "\n\n" + streamInterruptedWarningText(issue.error);
      log(_cfg, `openai chat stream interrupted after partial output model=${rm.name} code=${upstreamErrorCode(issue.error) || "stream_interrupted"} error=${errorLogSummary(issue.error)}`);
      await writeStreamWarningEvent(write, issue.error, warning.trim());
      extraTokenCounter.append(warning);
      await writeChunk({ content: warning }, null);
    }
    await writeChunk({}, "stop");
  }
  if (includeUsage) await writeOpenAIChatUsageTokenChunk(write, id, model, promptTokens, combinedTokenCount(completionCounts, extraTokenCounter));
  await write("data: [DONE]\n\n");
}

function openAIStreamToolCallInput(toolCall: OpenAIToolCall): { name: unknown; input: unknown } {
  return {
    name: toolCall.function.name,
    input: parseJsonObject(toolCall.function.arguments),
  };
}
