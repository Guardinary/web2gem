import { randHex } from "../shared/runtime";
import { isRecord, type UnknownRecord } from "../shared/types";
import { normalizeHistoryRole, reasoningTextForHistory, responsesContentToText } from "../toolcall/content";

export function normalizeResponsesInputAsMessages(req: unknown): UnknownRecord[] {
  const messages = responsesMessagesFromRequest(req || {});
  return messages || [];
}

export function responsesMessagesFromRequest(req: unknown): UnknownRecord[] | null {
  if (!isRecord(req)) return null;
  let messages: UnknownRecord[] | null = null;
  if (Array.isArray(req.messages) && req.messages.length) {
    messages = req.messages;
  } else if (req.input != null) {
    messages = normalizeResponsesInputValueAsMessages(req.input);
  }
  if (!messages || !messages.length) return null;
  return prependInstructionMessage(messages, req.instructions);
}

export function prependInstructionMessage(messages: readonly UnknownRecord[], instructions: unknown): UnknownRecord[] {
  const sys = typeof instructions === "string" ? instructions.trim() : "";
  if (!sys) return [...messages];
  return [{ role: "system", content: sys }, ...messages];
}

export function normalizeResponsesInputValueAsMessages(input: unknown): UnknownRecord[] | null {
  if (input == null) return null;
  if (typeof input === "string") {
    return input.trim() ? [{ role: "user", content: input }] : null;
  }
  if (Array.isArray(input)) return normalizeResponsesInputArray(input);
  if (isRecord(input)) {
    const msg = normalizeResponsesInputItem(input, null);
    if (msg) return [msg];
  }
  return null;
}

export function normalizeResponsesInputArray(items: readonly unknown[]): UnknownRecord[] | null {
  const out: UnknownRecord[] = [];
  const callNameByID: Record<string, string> = {};
  const fallbackParts: string[] = [];
  let pendingAssistantReasoning = "";

  const flushPendingReasoning = () => {
    if (!pendingAssistantReasoning) return;
    out.push({ role: "assistant", reasoning_content: pendingAssistantReasoning });
    pendingAssistantReasoning = "";
  };
  const flushFallback = () => {
    if (!fallbackParts.length) return;
    flushPendingReasoning();
    out.push({ role: "user", content: fallbackParts.join("\n") });
    fallbackParts.length = 0;
  };

  for (const item of items || []) {
    if (typeof item === "string") {
      flushPendingReasoning();
      fallbackParts.push(item);
      continue;
    }
    if (!isRecord(item)) {
      const s = String(item == null ? "" : item).trim();
      if (s) fallbackParts.push(s);
      continue;
    }

    const msg = normalizeResponsesInputItem(item, callNameByID);
    if (msg) {
      const reasoning = assistantReasoningOnlyContent(msg);
      if (reasoning) {
        pendingAssistantReasoning = pendingAssistantReasoning ? pendingAssistantReasoning + "\n" + reasoning : reasoning;
        continue;
      }
      if (isAssistantToolCallMessage(msg) && pendingAssistantReasoning) {
        if (!reasoningTextForHistory(msg)) msg.reasoning_content = pendingAssistantReasoning;
        pendingAssistantReasoning = "";
      } else {
        flushPendingReasoning();
      }
      flushFallback();
      if (isAssistantToolCallMessage(msg) && out.length && mergeResponsesAssistantToolCalls(out[out.length - 1], msg)) continue;
      out.push(msg);
      continue;
    }

    const fallback = normalizeResponsesFallbackPart(item);
    if (fallback) fallbackParts.push(fallback);
  }
  flushPendingReasoning();
  flushFallback();
  return out.length ? out : null;
}

export function normalizeResponsesInputItem(item: unknown, callNameByID: Record<string, string> | null): UnknownRecord | null {
  if (!isRecord(item)) return null;
  const itemType = String(item.type || "").trim().toLowerCase();
  const role = normalizeHistoryRole(item.role);
  if (item.role != null && role) {
    if (role === "assistant") return normalizeResponsesAssistantMessage(item);
    let content = item.content;
    if (content == null && typeof item.text === "string" && item.text.trim()) content = item.text;
    if (content == null && isFileInputType(itemType)) content = [item];
    if (content == null) return null;
    const out: UnknownRecord = { role: role === "function" ? "tool" : role, content };
    if (role === "tool") {
      if (item.tool_call_id || item.call_id) out.tool_call_id = item.tool_call_id || item.call_id;
      if (item.name) out.name = item.name;
    }
    return out;
  }

  const type = itemType;
  if (type === "message" || type === "input_message") {
    const msgRole = normalizeHistoryRole(item.role || "user");
    if (msgRole === "assistant") return normalizeResponsesAssistantMessage(item);
    let content = item.content;
    if (content == null && typeof item.text === "string" && item.text.trim()) content = item.text;
    if (content == null) return null;
    return { role: msgRole || "user", content };
  }

  if (type === "function_call_output" || type === "tool_result") {
    const callID = item.call_id || item.tool_call_id || item.id || "";
    const out = {
      role: "tool",
      tool_call_id: callID,
      name: item.name || item.tool_name || (callID && callNameByID ? callNameByID[String(callID)] : "") || "",
      content: item.output != null ? item.output : item.content != null ? item.content : "",
    };
    return out;
  }

  if (type === "function_call" || type === "tool_call") {
    const fn = isRecord(item.function) ? item.function : {};
    const name = String(item.name || fn.name || "").trim();
    if (!name) return null;
    const argsRaw = item.arguments != null ? item.arguments : item.input != null ? item.input : fn.arguments != null ? fn.arguments : fn.input;
    const callID = item.call_id || item.id || `call_${randHex(6)}`;
    if (callID && callNameByID) callNameByID[String(callID)] = name;
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: callID, type: "function", function: { name, arguments: stringifyToolCallArguments(argsRaw) } }],
    };
  }

  if (type === "reasoning" || type === "thinking") {
    const text = responsesContentToText(item.summary != null ? item.summary : item.content != null ? item.content : item.text);
    return text ? { role: "assistant", content: "", reasoning_content: text } : null;
  }

  if (isFileInputType(type)) {
    return { role: "user", content: [item] };
  }

  if ((type === "input_text" || type === "text" || type === "output_text" || type === "summary_text") && typeof item.text === "string" && item.text.trim()) {
    return { role: "user", content: item.text };
  }
  return null;
}

export function normalizeResponsesAssistantMessage(item: unknown): UnknownRecord | null {
  if (!isRecord(item)) return null;
  const out: UnknownRecord = { role: "assistant" };
  const content = item.content != null ? item.content : (typeof item.text === "string" ? item.text : null);
  const parts = Array.isArray(content) ? content : (content == null ? [] : [content]);
  let text = "";
  let reasoning = responsesContentToText(item.reasoning_content || item.reasoning || item.thinking);
  const toolCalls: unknown[] = Array.isArray(item.tool_calls) ? [...item.tool_calls] : [];

  for (const part of parts) {
    if (typeof part === "string") { text += part; continue; }
    if (!isRecord(part)) continue;
    const typ = String(part.type || "").trim().toLowerCase();
    if (typ === "output_text" || typ === "text" || typ === "input_text") text += part.text || "";
    else if (typ === "reasoning" || typ === "thinking") reasoning += responsesContentToText(part.summary != null ? part.summary : part.text != null ? part.text : part.content);
    else if (typ === "function_call" || typ === "tool_call") {
      const fn = isRecord(part.function) ? part.function : {};
      const name = part.name || fn.name || "";
      if (name) toolCalls.push({ id: part.call_id || part.id || `call_${toolCalls.length}`, type: "function", function: { name, arguments: stringifyToolCallArguments(part.arguments != null ? part.arguments : part.input != null ? part.input : fn.arguments) } });
    }
  }
  if (text) out.content = text;
  else if (item.content === null || toolCalls.length) out.content = null;
  if (reasoning) out.reasoning_content = reasoning;
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out.content != null || out.reasoning_content || out.tool_calls ? out : null;
}

export function assistantReasoningOnlyContent(msg: unknown): string {
  if (!isAssistantMessage(msg) || isAssistantToolCallMessage(msg)) return "";
  const contentText = responsesContentToText(msg.content).trim();
  const reasoning = reasoningTextForHistory(msg);
  if (!reasoning) return "";
  return !contentText || contentText === reasoning ? reasoning : "";
}

export function isAssistantMessage(msg: unknown): msg is UnknownRecord {
  return isRecord(msg) && normalizeHistoryRole(msg.role) === "assistant";
}

export function isAssistantToolCallMessage(msg: unknown): msg is UnknownRecord & { tool_calls: unknown[] } {
  return isAssistantMessage(msg) && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

export function mergeResponsesAssistantToolCalls(prev: unknown, next: unknown): boolean {
  if (!isAssistantToolCallMessage(prev) || !isAssistantToolCallMessage(next)) return false;
  prev.tool_calls = [...(prev.tool_calls || []), ...(next.tool_calls || [])];
  if (!reasoningTextForHistory(prev) && reasoningTextForHistory(next)) prev.reasoning_content = reasoningTextForHistory(next);
  return true;
}

export function normalizeResponsesFallbackPart(item: unknown): string {
  if (!isRecord(item)) return "";
  const type = String(item.type || "").trim().toLowerCase();
  if ((type === "input_text" || type === "text" || type === "output_text" || type === "summary_text") && typeof item.text === "string" && item.text.trim()) return item.text;
  return "";
}

function isFileInputType(type: unknown): boolean {
  const typ = String(type || "").trim().toLowerCase();
  return typ === "input_file" || typ === "file";
}

export function stringifyToolCallArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value != null ? value : {}); } catch (_) { return "{}"; }
}
