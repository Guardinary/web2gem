import {
	toolCallInstructionsFor,
	toolNamesForPromptSource,
	toolPromptBlockFor,
} from "../toolcall/tool-bundle";
import type { PromptMetadata } from "./types";

export function ensureInlineToolPrompt(
	prompt: string,
	toolDefs: unknown,
	toolChoiceInstruction: string,
	contextFiles?: unknown,
	metadata?: PromptMetadata,
): string {
	const text = String(prompt || "");
	const toolNames = toolNamesForPromptSource(toolDefs || []);
	if (contextFiles) {
		if (metadata?.hasToolInstructions) return text;
		if (!toolNames.length)
			return withMissingInstruction(text, toolChoiceInstruction);
		if (!metadata && text.includes("<|DSML|tool_calls>")) return text;
		return [toolCallInstructionsFor(toolDefs), toolChoiceInstruction, text]
			.filter((part) => part.trim())
			.join("\n\n");
	}
	if (!toolNames.length) {
		return withMissingInstruction(text, toolChoiceInstruction);
	}
	if (metadata?.hasToolPrompt && metadata.hasToolInstructions) return text;
	if (
		!metadata &&
		text.includes("Available tools") &&
		text.includes("<|DSML|tool_calls>")
	)
		return text;
	return [toolPromptBlockFor(toolDefs, toolChoiceInstruction), text]
		.filter((part) => part.trim())
		.join("\n\n");
}

function withMissingInstruction(text: string, instruction: string): string {
	const trimmed = String(instruction || "").trim();
	if (!trimmed || text.includes(trimmed)) return text;
	return [instruction, text].filter((part) => part.trim()).join("\n\n");
}
