import { parseJsonObject } from "../shared/json";
import { isRecord } from "../shared/types";
import {
	contentTextForHistory,
	normalizeHistoryRole,
	reasoningTextForHistory,
	roleLabelForHistory,
} from "../toolcall/content";
import { formatPromptToolCallBlock } from "../toolcall/prompt-format";
import { googleContentsToOpenAIMessages } from "./google";

type HistoryTranscriptEntry = {
	role: string;
	content: string;
};

export function buildOpenAIHistoryTranscript(
	messages: unknown,
	filename: unknown = "message.txt",
): string {
	const entries: HistoryTranscriptEntry[] = [];
	if (!Array.isArray(messages)) return "";
	for (const msg of messages) {
		if (!isRecord(msg)) continue;
		const role = normalizeHistoryRole(msg.role);
		let content = "";
		if (role === "assistant") {
			const reasoning = reasoningTextForHistory(msg);
			content = [
				reasoning
					? `[reasoning_content]\n${reasoning}\n[/reasoning_content]`
					: "",
				contentTextForHistory(msg.content),
			]
				.filter(Boolean)
				.join("\n\n");
			if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
				const blocks = msg.tool_calls.map((tc) => {
					const record = isRecord(tc) ? tc : null;
					const fn = record && isRecord(record.function) ? record.function : {};
					return formatPromptToolCallBlock(
						fn.name,
						parseJsonObject(String(fn.arguments || "{}")),
					);
				});
				content = [content, ...blocks].filter(Boolean).join("\n");
			}
		} else if (role === "tool") {
			const meta: string[] = [];
			if (msg.name) meta.push(`name=${msg.name}`);
			if (msg.tool_call_id) meta.push(`tool_call_id=${msg.tool_call_id}`);
			const toolContent = contentTextForHistory(msg.content).trim() || "null";
			content = [meta.length ? `[${meta.join(" ")}]` : "", toolContent]
				.filter(Boolean)
				.join("\n");
		} else {
			content = contentTextForHistory(msg.content);
		}
		content = String(content || "").trim();
		if (content) entries.push({ role, content });
	}
	if (!entries.length) return "";
	const sections = entries.map(
		(entry, idx) =>
			`=== ${idx + 1}. ${roleLabelForHistory(entry.role)} ===\n${entry.content}`,
	);
	return `# ${filename || "message.txt"}\nPrior conversation history and tool progress.\n\n${sections.join("\n\n")}\n`;
}

export function buildGoogleHistoryTranscript(
	req: unknown,
	filename: unknown = "message.txt",
): string {
	return buildOpenAIHistoryTranscript(
		googleContentsToOpenAIMessages(req),
		filename,
	);
}

export function latestOpenAIUserInputText(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!isRecord(msg)) continue;
		if (normalizeHistoryRole(msg.role) !== "user") continue;
		const text = contentTextForHistory(msg.content).trim();
		if (text) return text;
	}
	return "";
}

export function latestGoogleUserInputText(req: unknown): string {
	return latestOpenAIUserInputText(googleContentsToOpenAIMessages(req));
}
