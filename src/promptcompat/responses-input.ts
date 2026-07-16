import { randHex } from "../shared/crypto";
import { isRecord, type UnknownRecord } from "../shared/types";
import {
	flattenText,
	type InternalMessage,
	isTextPartType,
	normalizeMessageRole,
	parseAssistantContent,
	parseOpenAIMessages,
	rawRecordReasoningText,
} from "./message-model";

export function normalizeResponsesInputAsMessages(
	req: unknown,
	preservePartTypes = false,
): UnknownRecord[] {
	const messages = responsesMessagesFromRequest(req || {}, preservePartTypes);
	return messages || [];
}

/** Strict Responses edge parser: item-level normalize then parse to the model. */
export function normalizeResponsesInputStrict(
	req: unknown,
):
	| { messages: InternalMessage[]; error?: undefined }
	| { messages?: undefined; error: string } {
	const normalized = normalizeResponsesInputAsMessagesStrict(req);
	if (normalized.error) return { error: normalized.error };
	return { messages: parseOpenAIMessages(normalized.messages) };
}

export function normalizeResponsesInputAsMessagesStrict(
	req: unknown,
):
	| { messages: UnknownRecord[]; error?: undefined }
	| { messages?: undefined; error: string } {
	if (!isRecord(req)) return { error: "request body must be a JSON object" };
	const validation = strictResponsesInputError(req.input);
	if (validation) return { error: validation };
	const messages = responsesMessagesFromRequest(req);
	return { messages: messages || [] };
}

export function responsesMessagesFromRequest(
	req: unknown,
	preservePartTypes = false,
): UnknownRecord[] | null {
	if (!isRecord(req)) return null;
	let messages: UnknownRecord[] | null = null;
	if (Array.isArray(req.messages) && req.messages.length) {
		messages = req.messages;
	} else if (req.input != null) {
		messages = normalizeResponsesInputValueAsMessages(
			req.input,
			preservePartTypes,
		);
	}
	if (!messages?.length) return null;
	return prependInstructionMessage(messages, req.instructions);
}

export function prependInstructionMessage(
	messages: readonly UnknownRecord[],
	instructions: unknown,
): UnknownRecord[] {
	const sys = typeof instructions === "string" ? instructions.trim() : "";
	if (!sys) return [...messages];
	return [{ role: "system", content: sys }, ...messages];
}

export function normalizeResponsesInputValueAsMessages(
	input: unknown,
	preservePartTypes = false,
): UnknownRecord[] | null {
	if (input == null) return null;
	if (typeof input === "string") {
		return input.trim() ? [{ role: "user", content: input }] : null;
	}
	if (Array.isArray(input))
		return normalizeResponsesInputArray(input, preservePartTypes);
	if (isRecord(input)) {
		const msg = normalizeResponsesInputItem(input, null, preservePartTypes);
		if (msg) return [msg];
	}
	return null;
}

export function normalizeResponsesInputArray(
	items: readonly unknown[],
	preservePartTypes = false,
): UnknownRecord[] | null {
	const out: UnknownRecord[] = [];
	const callNameByID: Record<string, string> = {};
	const fallbackParts: string[] = [];
	let pendingAssistantReasoning = "";

	const flushPendingReasoning = () => {
		if (!pendingAssistantReasoning) return;
		out.push({
			role: "assistant",
			reasoning_content: pendingAssistantReasoning,
		});
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

		const msg = normalizeResponsesInputItem(
			item,
			callNameByID,
			preservePartTypes,
		);
		if (msg) {
			const reasoning = assistantReasoningOnlyContent(msg);
			if (reasoning) {
				pendingAssistantReasoning = pendingAssistantReasoning
					? `${pendingAssistantReasoning}\n${reasoning}`
					: reasoning;
				continue;
			}
			if (isAssistantToolCallMessage(msg) && pendingAssistantReasoning) {
				if (!rawRecordReasoningText(msg))
					msg.reasoning_content = pendingAssistantReasoning;
				pendingAssistantReasoning = "";
			} else {
				flushPendingReasoning();
			}
			flushFallback();
			if (
				isAssistantToolCallMessage(msg) &&
				out.length &&
				mergeResponsesAssistantToolCalls(out[out.length - 1], msg)
			)
				continue;
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

export function normalizeResponsesInputItem(
	item: unknown,
	callNameByID: Record<string, string> | null,
	preservePartTypes = false,
): UnknownRecord | null {
	return parseResponsesInputItem(item, callNameByID, preservePartTypes).message;
}

type ResponsesInputItemParseResult = {
	message: UnknownRecord | null;
	error: string;
};

function parsedItem(message: UnknownRecord): ResponsesInputItemParseResult {
	return { message, error: "" };
}

function invalidItem(error: string): ResponsesInputItemParseResult {
	return { message: null, error };
}

function parseResponsesInputItem(
	item: unknown,
	callNameByID: Record<string, string> | null,
	preservePartTypes = false,
): ResponsesInputItemParseResult {
	if (!isRecord(item))
		return invalidItem("must be a supported object or string");
	const itemType = String(item.type || "")
		.trim()
		.toLowerCase();
	const role = normalizeMessageRole(item.role);
	if (item.role != null && role) {
		if (role === "assistant") {
			const message = normalizeResponsesAssistantMessage(item);
			return message
				? parsedItem(message)
				: invalidItem("assistant message requires content or tool calls");
		}
		let content = item.content ?? (role === "tool" ? item.output : null);
		if (
			content == null &&
			((typeof item.text === "string" && item.text.trim()) ||
				typeof item.text === "number" ||
				typeof item.text === "boolean")
		)
			content = item.text;
		if (content == null && isFileInputType(itemType)) content = [item];
		if (content == null)
			return invalidItem(
				role === "tool"
					? "tool message requires content"
					: "message requires content",
			);
		const out: UnknownRecord = {
			role: role === "function" ? "tool" : role,
			content,
		};
		if (role === "tool") {
			if (item.tool_call_id || item.call_id)
				out.tool_call_id = item.tool_call_id || item.call_id;
			if (item.name) out.name = item.name;
		}
		return parsedItem(out);
	}

	const type = itemType;
	if (type === "message" || type === "input_message") {
		const msgRole = normalizeMessageRole(item.role || "user");
		if (msgRole === "assistant") {
			const message = normalizeResponsesAssistantMessage(item);
			return message
				? parsedItem(message)
				: invalidItem("assistant message requires content or tool calls");
		}
		let content = item.content;
		if (
			content == null &&
			((typeof item.text === "string" && item.text.trim()) ||
				typeof item.text === "number" ||
				typeof item.text === "boolean")
		)
			content = item.text;
		if (content == null) return invalidItem("message requires content");
		return parsedItem({ role: msgRole || "user", content });
	}

	if (type === "function_call_output" || type === "tool_result") {
		const callID = item.call_id || item.tool_call_id || item.id || "";
		const out = {
			role: "tool",
			tool_call_id: callID,
			name:
				item.name ||
				item.tool_name ||
				(callID && callNameByID ? callNameByID[String(callID)] : "") ||
				"",
			content: item.output ?? item.content ?? "",
		};
		return item.output != null || item.content != null
			? parsedItem(out)
			: invalidItem("tool result requires output");
	}

	if (type === "function_call" || type === "tool_call") {
		const fn = isRecord(item.function) ? item.function : {};
		const name = String(item.name || fn.name || "").trim();
		if (!name) return invalidItem("function call requires name");
		const argsRaw = item.arguments ?? item.input ?? fn.arguments ?? fn.input;
		const callID = item.call_id || item.id || `call_${randHex(6)}`;
		if (callID && callNameByID) callNameByID[String(callID)] = name;
		return parsedItem({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: callID,
					type: "function",
					function: { name, arguments: stringifyToolCallArguments(argsRaw) },
				},
			],
		});
	}

	if (type === "reasoning" || type === "thinking") {
		const text = flattenText(item.summary ?? item.content ?? item.text);
		return text
			? parsedItem({ role: "assistant", content: "", reasoning_content: text })
			: invalidItem("reasoning item requires text");
	}

	if (isFileInputType(type)) {
		return parsedItem({ role: "user", content: [item] });
	}

	if (
		isTextPartType(type) &&
		typeof item.text === "string" &&
		item.text.trim()
	) {
		return parsedItem({
			role: "user",
			content: preservePartTypes ? [item] : item.text,
		});
	}
	if (isTextPartType(type)) return invalidItem("text item requires text");
	return invalidItem(`has unsupported type${type ? `: ${type}` : ""}`);
}

export function normalizeResponsesAssistantMessage(
	item: unknown,
): UnknownRecord | null {
	if (!isRecord(item)) return null;
	const out: UnknownRecord = { role: "assistant" };
	const parsed = parseAssistantContent(item);
	const text = parsed.text;
	const reasoning = parsed.reasoning;
	const toolCalls = parsed.toolCalls.map((call) => ({
		id: call.id,
		type: "function",
		function: {
			name: call.name,
			arguments: JSON.stringify(call.args),
		},
	}));
	if (text) out.content = text;
	else if (item.content === null || toolCalls.length) out.content = null;
	if (reasoning) out.reasoning_content = reasoning;
	if (toolCalls.length) out.tool_calls = toolCalls;
	return out.content != null || out.reasoning_content || out.tool_calls
		? out
		: null;
}

export function assistantReasoningOnlyContent(msg: unknown): string {
	if (!isAssistantMessage(msg) || isAssistantToolCallMessage(msg)) return "";
	const contentText = flattenText(msg.content).trim();
	const reasoning = rawRecordReasoningText(msg);
	if (!reasoning) return "";
	return !contentText || contentText === reasoning ? reasoning : "";
}

export function isAssistantMessage(msg: unknown): msg is UnknownRecord {
	return isRecord(msg) && normalizeMessageRole(msg.role) === "assistant";
}

export function isAssistantToolCallMessage(
	msg: unknown,
): msg is UnknownRecord & { tool_calls: unknown[] } {
	return (
		isAssistantMessage(msg) &&
		Array.isArray(msg.tool_calls) &&
		msg.tool_calls.length > 0
	);
}

export function mergeResponsesAssistantToolCalls(
	prev: unknown,
	next: unknown,
): boolean {
	if (!isAssistantToolCallMessage(prev) || !isAssistantToolCallMessage(next))
		return false;
	prev.tool_calls = [...(prev.tool_calls || []), ...(next.tool_calls || [])];
	if (!rawRecordReasoningText(prev) && rawRecordReasoningText(next))
		prev.reasoning_content = rawRecordReasoningText(next);
	return true;
}

export function normalizeResponsesFallbackPart(item: unknown): string {
	if (!isRecord(item)) return "";
	const type = String(item.type || "")
		.trim()
		.toLowerCase();
	if (isTextPartType(type) && typeof item.text === "string" && item.text.trim())
		return item.text;
	return "";
}

function isFileInputType(type: unknown): boolean {
	const typ = String(type || "")
		.trim()
		.toLowerCase();
	return typ === "input_file" || typ === "file";
}

export function stringifyToolCallArguments(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value != null ? value : {});
	} catch (_) {
		return "{}";
	}
}

function strictResponsesInputError(input: unknown): string {
	if (input == null || typeof input === "string") return "";
	if (Array.isArray(input)) {
		const callNameByID: Record<string, string> = {};
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			if (typeof item === "string") {
				if (!item.trim()) return `Responses input item ${i} is empty`;
				continue;
			}
			if (!isRecord(item))
				return `Responses input item ${i} must be a supported object or string`;
			const error = parseResponsesInputItem(item, callNameByID).error;
			if (error) return `Responses input item ${i} ${error}`;
		}
		return "";
	}
	if (isRecord(input)) {
		const error = parseResponsesInputItem(input, null).error;
		return error ? `input ${error}` : "";
	}
	return "Responses input must be a string, object, or array of supported items";
}
