import { randHex } from "../shared/crypto";
import { isRecord, type UnknownRecord } from "../shared/types";
import { flattenText } from "./message-model";

export type ResponsesToolCallInput = {
	id: string;
	name: string;
	arguments: unknown;
};

export function responsesInputItemType(item: UnknownRecord): string {
	return String(item.type || "")
		.trim()
		.toLowerCase();
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
