import { formatPromptToolCallBlock } from "../toolcall/prompt-format";
import {
	type InternalMessage,
	latestUserInputText,
	renderMessageBody,
} from "./message-model";

type HistoryTranscriptEntry = {
	role: string;
	content: string;
};

export function buildOpenAIHistoryTranscript(
	messages: readonly InternalMessage[],
	filename: unknown = "message.txt",
): string {
	const entries: HistoryTranscriptEntry[] = [];
	for (const msg of messages) {
		let content = "";
		if (msg.role === "assistant") {
			content = renderMessageBody(msg, "history");
			if (msg.toolCalls.length) {
				const blocks = msg.toolCalls.map((tc) =>
					formatPromptToolCallBlock(tc.name, tc.args),
				);
				content = [content, ...blocks].filter(Boolean).join("\n");
			}
		} else if (msg.role === "tool") {
			const meta: string[] = [];
			if (msg.toolName) meta.push(`name=${msg.toolName}`);
			if (msg.toolCallId) meta.push(`tool_call_id=${msg.toolCallId}`);
			const toolContent = renderMessageBody(msg, "history").trim() || "null";
			content = [meta.length ? `[${meta.join(" ")}]` : "", toolContent]
				.filter(Boolean)
				.join("\n");
		} else {
			content = renderMessageBody(msg, "history");
		}
		content = String(content || "").trim();
		if (content) entries.push({ role: msg.roleLabel, content });
	}
	if (!entries.length) return "";
	const sections = entries.map(
		(entry, idx) =>
			`=== ${idx + 1}. ${entry.role.toUpperCase()} ===\n${entry.content}`,
	);
	return `# ${filename || "message.txt"}\nPrior conversation history and tool progress.\n\n${sections.join("\n\n")}\n`;
}

export function latestOpenAIUserInputText(
	messages: readonly InternalMessage[],
): string {
	return latestUserInputText(messages);
}
