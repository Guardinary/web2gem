import { openAIToolDefs } from "../toolcall/content";
import { formatPromptToolCallBlock } from "../toolcall/prompt-format";
import { toolPromptBlockFor } from "../toolcall/tool-bundle";
import {
	historyContentText,
	type InternalMessage,
	messageReasoningText,
	type MessagePart,
} from "./message-model";
import {
	createPromptPartAccumulator,
	type PromptBuildResult,
} from "./prompt-text";

type ToolPromptDef = {
	name?: unknown;
	description?: unknown;
	parameters?: unknown;
};

export function messagesToPrompt(
	messages: readonly InternalMessage[],
	tools: unknown,
	toolChoice: unknown,
	toolDefsOverride: unknown,
	toolChoiceInstructionOverride: unknown,
	maxPromptBytes?: number | null,
): PromptBuildResult {
	const prompt = createPromptPartAccumulator(maxPromptBytes);
	let latestInputText = "";
	let promptToolDefs: readonly ToolPromptDef[] = [];
	if (toolChoice !== "none") {
		promptToolDefs = Array.isArray(toolDefsOverride)
			? toolDefsOverride
			: openAIToolDefs(tools);
	}

	if (promptToolDefs.length) {
		const choiceInstruction = toolChoiceInstructionOverride || "";
		prompt.add(toolPromptBlockFor(tools, choiceInstruction, promptToolDefs));
	}
	const hiddenPromptInsertOffset = promptToolDefs.length
		? prompt.length()
		: null;

	for (const msg of messages) {
		let content = renderMessagePromptContent(msg);

		if (msg.role === "system") {
			prompt.add(`[System instruction]: ${content}`);
		} else if (msg.role === "assistant") {
			const reasoning = messageReasoningText(msg);
			if (reasoning && !content.includes("[reasoning_content]")) {
				content = [
					`[reasoning_content]\n${reasoning}\n[/reasoning_content]`,
					content,
				]
					.filter(Boolean)
					.join("\n\n");
			}
			if (msg.toolCalls.length) {
				const tcStrs = msg.toolCalls.map((tc) =>
					formatPromptToolCallBlock(tc.name, tc.args),
				);
				prompt.add(`[Assistant]: ${content || ""}\n${tcStrs.join("\n")}`);
			} else {
				prompt.add(`[Assistant]: ${content}`);
			}
		} else if (msg.role === "tool") {
			const meta: string[] = [];
			if (msg.toolName) meta.push(msg.toolName);
			if (msg.toolCallId) meta.push(`id=${msg.toolCallId}`);
			prompt.add(
				`[Tool result${meta.length ? ` for ${meta.join(" ")}` : ""}]: ${content || "null"}`,
			);
		} else {
			const latest = historyContentText(msg).trim();
			if (msg.roleLabel === "user" && latest) latestInputText = latest;
			prompt.add(content ? content : "");
		}
	}

	const accumulated = prompt.result();
	const hasToolPrompt = promptToolDefs.length > 0;
	return {
		text: accumulated.text,
		byteCheck: accumulated.byteCheck,
		tokens: accumulated.tokens,
		counts: accumulated.counts,
		latestInputText,
		hiddenPromptInsertOffset,
		metadata: {
			hasToolPrompt,
			hasToolInstructions: hasToolPrompt,
		},
	};
}

function renderMessagePromptContent(msg: InternalMessage): string {
	const textParts: string[] = [];
	for (const part of msg.parts) {
		const text = promptPartText(part);
		if (text) textParts.push(text);
	}
	return textParts.join("\n");
}

function promptPartText(part: MessagePart): string {
	if (part.kind === "text") return part.text;
	if (part.kind === "reasoning")
		return part.text
			? `[reasoning_content]\n${part.text}\n[/reasoning_content]`
			: "";
	if (part.kind === "image") return "[image input]";
	return `[file input${part.label ? ` ${part.label}` : ""}]`;
}
