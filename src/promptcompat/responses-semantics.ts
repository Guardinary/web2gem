import { randHex } from "../shared/crypto";
import { isRecord, type UnknownRecord } from "../shared/types";
import {
	flattenText,
	isTextPartType,
	normalizeMessageRole,
} from "./message-model";

export type ResponsesToolCallInput = {
	id: string;
	name: string;
	arguments: unknown;
};

export type ResponsesItemKind =
	| "role-message"
	| "message"
	| "tool-result"
	| "tool-call"
	| "reasoning"
	| "input-image"
	| "file"
	| "text"
	| "unknown";

export type ResponsesSequenceEvent<T> =
	| { kind: "reasoning"; text: string }
	| { kind: "message"; value: T }
	| { kind: "fallback"; text: string };

export function responsesInputItemType(item: UnknownRecord): string {
	return String(item.type || "")
		.trim()
		.toLowerCase();
}

export function responsesItemKind(item: UnknownRecord): ResponsesItemKind {
	if (item.role != null) return "role-message";
	const type = responsesInputItemType(item);
	if (type === "message" || type === "input_message") return "message";
	if (type === "function_call_output" || type === "tool_result")
		return "tool-result";
	if (type === "function_call" || type === "tool_call") return "tool-call";
	if (type === "reasoning" || type === "thinking") return "reasoning";
	if (type === "input_image") return "input-image";
	if (isResponsesFileInputType(type)) return "file";
	if (isTextPartType(type)) return "text";
	return "unknown";
}

export function responsesItemRole(
	item: UnknownRecord,
	defaultRole = "",
): string {
	const role = normalizeMessageRole(item.role ?? defaultRole);
	return role === "function" ? "tool" : role;
}

export function isResponsesFileInputType(type: unknown): boolean {
	const normalized = String(type || "")
		.trim()
		.toLowerCase();
	return normalized === "input_file" || normalized === "file";
}

export function responsesToolCallInput(
	item: UnknownRecord,
): ResponsesToolCallInput | null {
	const fn = isRecord(item.function) ? item.function : {};
	const name = String(item.name ?? fn.name ?? "").trim();
	if (!name) return null;
	return {
		id: String(item.call_id || item.id || `call_${randHex(6)}`),
		name,
		arguments: item.arguments ?? item.input ?? fn.arguments ?? fn.input,
	};
}

export function responsesReasoningText(item: UnknownRecord): string {
	return flattenText(item.summary ?? item.content ?? item.text);
}

export function responsesToolResultCallID(item: UnknownRecord): string {
	return String(item.call_id ?? item.tool_call_id ?? item.id ?? "");
}

export function appendResponsesReasoning(
	pending: string,
	next: string,
): string {
	return pending ? `${pending}\n${next}` : next;
}

export function rememberResponsesCallName(
	callNameByID: Record<string, string> | null,
	call: Pick<ResponsesToolCallInput, "id" | "name">,
): void {
	if (call.id && callNameByID) callNameByID[call.id] = call.name;
}

export function responsesCallName(
	callNameByID: Record<string, string> | null,
	callID: string,
): string {
	return callID && callNameByID ? callNameByID[callID] || "" : "";
}

export function reduceResponsesSequence<T>(
	events: Iterable<ResponsesSequenceEvent<T>>,
	options: {
		createReasoning: (text: string) => T;
		createFallback: (text: string) => T;
		isToolCall: (value: T) => boolean;
		reasoningText: (value: T) => string;
		attachReasoning: (value: T, text: string) => void;
		mergeToolCalls: (previous: T, next: T) => boolean;
	},
): T[] {
	const values: T[] = [];
	let pendingReasoning = "";
	let fallbackParts: string[] = [];
	const flushReasoning = () => {
		if (!pendingReasoning) return;
		values.push(options.createReasoning(pendingReasoning));
		pendingReasoning = "";
	};
	const flushFallback = () => {
		if (!fallbackParts.length) return;
		flushReasoning();
		values.push(options.createFallback(fallbackParts.join("\n")));
		fallbackParts = [];
	};
	for (const event of events) {
		if (event.kind === "reasoning") {
			pendingReasoning = appendResponsesReasoning(pendingReasoning, event.text);
			continue;
		}
		if (event.kind === "fallback") {
			flushReasoning();
			fallbackParts.push(event.text);
			continue;
		}
		const value = event.value;
		if (options.isToolCall(value) && pendingReasoning) {
			if (!options.reasoningText(value))
				options.attachReasoning(value, pendingReasoning);
			pendingReasoning = "";
		} else {
			flushReasoning();
		}
		flushFallback();
		const previous = values[values.length - 1];
		if (
			previous !== undefined &&
			options.isToolCall(previous) &&
			options.isToolCall(value) &&
			options.mergeToolCalls(previous, value)
		)
			continue;
		values.push(value);
	}
	flushReasoning();
	flushFallback();
	return values;
}
