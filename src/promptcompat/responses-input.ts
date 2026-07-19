import { isRecord, type UnknownRecord } from "../shared/types";
import {
	createInternalMessage,
	flattenText,
	type InternalMessage,
	type InternalToolCall,
	isTextPartType,
	parseAssistantContent,
	parseMessageContent,
	parseOpenAIMessages,
	parseToolCallArguments,
	projectMessageText,
	rawRecordReasoningText,
} from "./message-model";
import {
	isResponsesFileInputType,
	reduceResponsesSequence,
	rememberResponsesCallName,
	responsesCallName,
	responsesInputItemType,
	responsesItemKind,
	responsesItemRole,
	responsesReasoningText,
	type ResponsesSequenceEvent,
	responsesToolCallInput,
	responsesToolResultCallID,
} from "./responses-semantics";

export type ResponsesInputMode = "completion" | "image-generation";

export type ResponsesInputParseResult =
	| { messages: InternalMessage[]; error?: undefined }
	| { messages?: undefined; error: string };

type DirectItemResult =
	| { kind: "message"; message: InternalMessage }
	| { kind: "reasoning"; text: string }
	| { kind: "unknown" }
	| { kind: "error"; error: string };

export function parseResponsesInput(
	req: unknown,
	mode: ResponsesInputMode = "completion",
): ResponsesInputParseResult {
	if (!isRecord(req)) return { error: "request body must be a JSON object" };
	let parsed: ResponsesInputParseResult;
	if (Array.isArray(req.messages) && req.messages.length) {
		parsed = { messages: parseOpenAIMessages(req.messages) };
	} else {
		parsed = parseResponsesInputValue(req.input, mode);
	}
	if (parsed.error || !parsed.messages) return parsed;
	const instructions =
		typeof req.instructions === "string" ? req.instructions.trim() : "";
	if (!instructions) return parsed;
	return {
		messages: [
			createInternalMessage("system", parseMessageContent(instructions)),
			...parsed.messages,
		],
	};
}

function parseResponsesInputValue(
	input: unknown,
	mode: ResponsesInputMode,
): ResponsesInputParseResult {
	if (input == null) return { messages: [] };
	if (typeof input === "string") {
		return {
			messages: input.trim()
				? [createInternalMessage("user", parseMessageContent(input))]
				: [],
		};
	}
	if (Array.isArray(input)) return parseResponsesInputArrayDirect(input, mode);
	if (!isRecord(input)) {
		return {
			error:
				"Responses input must be a string, object, or array of supported items",
		};
	}
	const callNameByID: Record<string, string> = {};
	const item = parseResponsesInputItemDirect(input, callNameByID, mode);
	if (item.kind === "error") return { error: `input ${item.error}` };
	if (item.kind === "unknown") return { messages: [] };
	if (item.kind === "reasoning") {
		return {
			messages: [
				createInternalMessage("assistant", [], {
					reasoningText: item.text,
				}),
			],
		};
	}
	return { messages: [item.message] };
}

function parseResponsesInputArrayDirect(
	items: readonly unknown[],
	mode: ResponsesInputMode,
): ResponsesInputParseResult {
	const callNameByID: Record<string, string> = {};
	const events: ResponsesSequenceEvent<InternalMessage>[] = [];
	for (let index = 0; index < items.length; index++) {
		const raw = items[index];
		if (typeof raw === "string") {
			if (!raw.trim())
				return { error: `Responses input item ${index} is empty` };
			events.push({ kind: "fallback", text: raw });
			continue;
		}
		if (!isRecord(raw)) {
			return {
				error: `Responses input item ${index} must be a supported object or string`,
			};
		}

		const item = parseResponsesInputItemDirect(raw, callNameByID, mode);
		if (item.kind === "error")
			return { error: `Responses input item ${index} ${item.error}` };
		if (item.kind === "unknown") continue;
		if (item.kind === "reasoning") {
			events.push({ kind: "reasoning", text: item.text });
			continue;
		}
		events.push({ kind: "message", value: item.message });
	}
	return {
		messages: reduceResponsesSequence(events, {
			createReasoning: (text) =>
				createInternalMessage("assistant", [], { reasoningText: text }),
			createFallback: (text) =>
				createInternalMessage("user", parseMessageContent(text)),
			isToolCall: isInternalAssistantToolCallMessage,
			reasoningText: (message) => projectMessageText(message, "reasoning"),
			attachReasoning: (message, text) => {
				message.reasoningText = text;
			},
			mergeToolCalls: (previous, next) => {
				previous.toolCalls.push(...next.toolCalls);
				if (!projectMessageText(previous, "reasoning"))
					previous.reasoningText = projectMessageText(next, "reasoning");
				return true;
			},
		}),
	};
}

function parseResponsesInputItemDirect(
	item: UnknownRecord,
	callNameByID: Record<string, string>,
	mode: ResponsesInputMode,
): DirectItemResult {
	const type = responsesInputItemType(item);
	const kind = responsesItemKind(item);
	if (type === "input_image" && mode === "completion")
		return directError("has unsupported type: input_image");
	if (kind === "role-message") return parseResponsesRoleMessage(item, type);
	if (kind === "message") return parseResponsesRoleMessage(item, type, "user");

	if (kind === "tool-result") {
		if (item.output == null && item.content == null)
			return directError("tool result requires output");
		const callID = responsesToolResultCallID(item);
		return directMessage(
			createInternalMessage(
				"tool",
				parseMessageContent(item.output ?? item.content),
				{
					toolCallId: callID,
					toolName:
						item.name ||
						item.tool_name ||
						responsesCallName(callNameByID, callID) ||
						"",
				},
			),
		);
	}

	if (kind === "tool-call") {
		const call = responsesToolCall(item);
		if (!call) return directError("function call requires name");
		rememberResponsesCallName(callNameByID, call);
		return directMessage(
			createInternalMessage("assistant", [], { toolCalls: [call] }),
		);
	}

	if (kind === "reasoning") {
		const text = responsesReasoningText(item);
		return text
			? { kind: "reasoning", text }
			: directError("reasoning item requires text");
	}

	if (kind === "input-image") {
		return directMessage(
			createInternalMessage("user", parseMessageContent([item])),
		);
	}
	if (kind === "file") {
		return directMessage(
			createInternalMessage("user", parseMessageContent([item])),
		);
	}
	if (kind === "text") {
		if (typeof item.text !== "string" || !item.text.trim())
			return directError("text item requires text");
		return directMessage(
			createInternalMessage("user", parseMessageContent([item])),
		);
	}
	return { kind: "unknown" };
}

function parseResponsesRoleMessage(
	item: UnknownRecord,
	itemType: string,
	defaultRole?: string,
): DirectItemResult {
	const role = responsesItemRole(item, defaultRole ?? "user");
	if (role === "assistant") return parseResponsesAssistantDirect(item);
	let content = item.content ?? (role === "tool" ? item.output : null);
	if (
		content == null &&
		((typeof item.text === "string" && item.text.trim()) ||
			typeof item.text === "number" ||
			typeof item.text === "boolean")
	)
		content = item.text;
	if (
		content == null &&
		(isResponsesFileInputType(itemType) || itemType === "input_image")
	)
		content = [item];
	if (content == null)
		return directError(
			role === "tool"
				? "tool message requires content"
				: "message requires content",
		);
	return directMessage(
		createInternalMessage(role, parseMessageContent(content), {
			toolCallId: role === "tool" ? (item.tool_call_id ?? item.call_id) : "",
			toolName: role === "tool" ? item.name : "",
		}),
	);
}

function parseResponsesAssistantDirect(item: UnknownRecord): DirectItemResult {
	const content =
		item.content ?? (typeof item.text === "string" ? item.text : null);
	const parts = parseMessageContent(content);
	const toolCalls = [
		...responsesToolCalls(item.tool_calls),
		...responsesContentToolCalls(content),
	];
	const reasoningText = flattenText(
		item.reasoning_content ?? item.reasoning ?? item.thinking,
	);
	const message = createInternalMessage("assistant", parts, {
		toolCalls,
		reasoningText,
	});
	const reasoningOnly = projectMessageText(message, "reasoning");
	const hasVisiblePart = parts.some(
		(part) =>
			part.kind !== "reasoning" && (part.kind !== "text" || !!part.text),
	);
	if (!toolCalls.length && !hasVisiblePart && reasoningOnly)
		return { kind: "reasoning", text: reasoningOnly };
	if (!toolCalls.length && !parts.length && !reasoningText)
		return directError("assistant message requires content or tool calls");
	return directMessage(message);
}

function responsesToolCalls(raw: unknown): InternalToolCall[] {
	if (!Array.isArray(raw)) return [];
	const calls: InternalToolCall[] = [];
	for (let index = 0; index < raw.length; index++) {
		const record = isRecord(raw[index]) ? raw[index] : null;
		if (!record) continue;
		const fn = isRecord(record.function) ? record.function : {};
		calls.push({
			id: String(record.id ?? record.call_id ?? ""),
			name: String(fn.name ?? record.name ?? ""),
			args: parseToolCallArguments(
				fn.arguments ?? fn.input ?? record.arguments ?? record.input,
			),
		});
	}
	return calls;
}

function responsesContentToolCalls(content: unknown): InternalToolCall[] {
	const rawParts = Array.isArray(content) ? content : [];
	const calls: InternalToolCall[] = [];
	for (const raw of rawParts) {
		if (!isRecord(raw)) continue;
		const type = responsesInputItemType(raw);
		if (type !== "function_call" && type !== "tool_call") continue;
		const call = responsesToolCall(raw);
		if (call) calls.push(call);
	}
	return calls;
}

function responsesToolCall(item: UnknownRecord): InternalToolCall | null {
	const call = responsesToolCallInput(item);
	if (!call) return null;
	return {
		id: call.id,
		name: call.name,
		args: parseToolCallArguments(call.arguments),
	};
}

function isInternalAssistantToolCallMessage(message: InternalMessage): boolean {
	return message.role === "assistant" && message.toolCalls.length > 0;
}

function directMessage(message: InternalMessage): DirectItemResult {
	return { kind: "message", message };
}

function directError(error: string): DirectItemResult {
	return { kind: "error", error };
}

export function normalizeResponsesInputAsMessages(
	req: unknown,
	preservePartTypes = false,
): UnknownRecord[] {
	const messages = responsesMessagesFromRequest(req || {}, preservePartTypes);
	return messages || [];
}

function responsesMessagesFromRequest(
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

function prependInstructionMessage(
	messages: readonly UnknownRecord[],
	instructions: unknown,
): UnknownRecord[] {
	const sys = typeof instructions === "string" ? instructions.trim() : "";
	if (!sys) return [...messages];
	return [{ role: "system", content: sys }, ...messages];
}

function normalizeResponsesInputValueAsMessages(
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

function normalizeResponsesInputArray(
	items: readonly unknown[],
	preservePartTypes = false,
): UnknownRecord[] | null {
	const callNameByID: Record<string, string> = {};
	const events: ResponsesSequenceEvent<UnknownRecord>[] = [];
	for (const item of items || []) {
		if (typeof item === "string") {
			events.push({ kind: "fallback", text: item });
			continue;
		}
		if (!isRecord(item)) {
			const s = String(item == null ? "" : item).trim();
			if (s) events.push({ kind: "fallback-deferred", text: s });
			continue;
		}

		const msg = normalizeResponsesInputItem(
			item,
			callNameByID,
			preservePartTypes,
		);
		if (msg) {
			const reasoning = assistantReasoningOnlyContent(msg);
			if (reasoning) events.push({ kind: "reasoning", text: reasoning });
			else events.push({ kind: "message", value: msg });
			continue;
		}

		const fallback = normalizeResponsesFallbackPart(item);
		if (fallback) events.push({ kind: "fallback-deferred", text: fallback });
	}
	const out = reduceResponsesSequence(events, {
		createReasoning: (text) => ({
			role: "assistant",
			reasoning_content: text,
		}),
		createFallback: (text) => ({ role: "user", content: text }),
		isToolCall: isAssistantToolCallMessage,
		reasoningText: rawRecordReasoningText,
		attachReasoning: (message, text) => {
			message.reasoning_content = text;
		},
		mergeToolCalls: mergeResponsesAssistantToolCalls,
	});
	return out.length ? out : null;
}

function normalizeResponsesInputItem(
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
	const itemType = responsesInputItemType(item);
	const kind = responsesItemKind(item);
	const role = responsesItemRole(item);
	if (kind === "role-message" && role) {
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
		if (content == null && isResponsesFileInputType(itemType)) content = [item];
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
	if (kind === "message") {
		const msgRole = responsesItemRole(item, "user");
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

	if (kind === "tool-result") {
		const callID = responsesToolResultCallID(item);
		const out = {
			role: "tool",
			tool_call_id: callID,
			name:
				item.name ||
				item.tool_name ||
				responsesCallName(callNameByID, callID) ||
				"",
			content: item.output ?? item.content ?? "",
		};
		return item.output != null || item.content != null
			? parsedItem(out)
			: invalidItem("tool result requires output");
	}

	if (kind === "tool-call") {
		const call = responsesToolCallInput(item);
		if (!call) return invalidItem("function call requires name");
		rememberResponsesCallName(callNameByID, call);
		return parsedItem({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: call.id,
					type: "function",
					function: {
						name: call.name,
						arguments: stringifyToolCallArguments(call.arguments),
					},
				},
			],
		});
	}

	if (kind === "reasoning") {
		const text = responsesReasoningText(item);
		return text
			? parsedItem({ role: "assistant", content: "", reasoning_content: text })
			: invalidItem("reasoning item requires text");
	}

	if (kind === "file") {
		return parsedItem({ role: "user", content: [item] });
	}

	if (kind === "text" && typeof item.text === "string" && item.text.trim()) {
		return parsedItem({
			role: "user",
			content: preservePartTypes ? [item] : item.text,
		});
	}
	if (isTextPartType(type)) return invalidItem("text item requires text");
	return invalidItem(`has unsupported type${type ? `: ${type}` : ""}`);
}

function normalizeResponsesAssistantMessage(
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

function assistantReasoningOnlyContent(msg: unknown): string {
	if (!isAssistantMessage(msg) || isAssistantToolCallMessage(msg)) return "";
	const contentText = flattenText(msg.content).trim();
	const reasoning = rawRecordReasoningText(msg);
	if (!reasoning) return "";
	return !contentText || contentText === reasoning ? reasoning : "";
}

function isAssistantMessage(msg: unknown): msg is UnknownRecord {
	return isRecord(msg) && responsesItemRole(msg) === "assistant";
}

function isAssistantToolCallMessage(
	msg: unknown,
): msg is UnknownRecord & { tool_calls: unknown[] } {
	return (
		isAssistantMessage(msg) &&
		Array.isArray(msg.tool_calls) &&
		msg.tool_calls.length > 0
	);
}

function mergeResponsesAssistantToolCalls(
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

function normalizeResponsesFallbackPart(item: unknown): string {
	if (!isRecord(item)) return "";
	const type = responsesInputItemType(item);
	if (isTextPartType(type) && typeof item.text === "string" && item.text.trim())
		return item.text;
	return "";
}

function stringifyToolCallArguments(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value != null ? value : {});
	} catch (_) {
		return "{}";
	}
}
