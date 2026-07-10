import { parseJsonObject } from "../shared/json";
import { isRecord, type UnknownRecord } from "../shared/types";
import {
	contentTextForHistory,
	messageContentToPrompt,
	normalizeHistoryRole,
	openAIToolDefs,
	reasoningTextForHistory,
} from "../toolcall/content";
import { formatPromptToolCallBlock } from "../toolcall/prompt-format";
import { toolPromptBlockFor } from "../toolcall/tool-bundle";
import { createPromptPartAccumulator } from "./prompt-text";

type ToolPromptDef = {
	name?: unknown;
	description?: unknown;
	parameters?: unknown;
};

export function messagesToPrompt(
	messages: unknown,
	tools: unknown,
	toolChoice: unknown,
	toolDefsOverride: unknown,
	toolChoiceInstructionOverride: unknown,
	maxPromptBytes?: number | null,
) {
	const prompt = createPromptPartAccumulator(maxPromptBytes);
	const images: UnknownRecord[] = [];
	const files: UnknownRecord[] = [];
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
		: undefined;

	const messageList = Array.isArray(messages) ? messages : [];
	for (const msg of messageList) {
		if (!isRecord(msg)) continue;
		const role = normalizeHistoryRole(msg.role);
		let content = messageContentToPrompt(
			msg.content != null ? msg.content : "",
			images,
			files,
		);

		if (role === "system") {
			prompt.add(`[System instruction]: ${content}`);
		} else if (role === "assistant") {
			const reasoning = reasoningTextForHistory(msg);
			if (reasoning && !content.includes("[reasoning_content]")) {
				content = [
					`[reasoning_content]\n${reasoning}\n[/reasoning_content]`,
					content,
				]
					.filter(Boolean)
					.join("\n\n");
			}
			if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
				const tcStrs = msg.tool_calls.map((tc) => {
					const record = isRecord(tc) ? tc : null;
					const fn = record && isRecord(record.function) ? record.function : {};
					return formatPromptToolCallBlock(
						fn.name,
						parseJsonObject(String(fn.arguments || "{}")),
					);
				});
				prompt.add(`[Assistant]: ${content || ""}\n${tcStrs.join("\n")}`);
			} else {
				prompt.add(`[Assistant]: ${content}`);
			}
		} else if (role === "tool") {
			const meta: string[] = [];
			if (msg.name) meta.push(String(msg.name));
			if (msg.tool_call_id) meta.push(`id=${msg.tool_call_id}`);
			prompt.add(
				`[Tool result${meta.length ? ` for ${meta.join(" ")}` : ""}]: ${content || "null"}`,
			);
		} else {
			const latest = contentTextForHistory(msg.content).trim();
			if (role === "user" && latest) latestInputText = latest;
			prompt.add(content ? content : "");
		}
	}

	const result = prompt.result(images);
	if (files.length) result.files = files;
	if (hiddenPromptInsertOffset != null)
		result.hiddenPromptInsertOffset = hiddenPromptInsertOffset;
	if (latestInputText) result.latestInputText = latestInputText;
	if (promptToolDefs.length) {
		result.hasToolPrompt = true;
		result.hasToolInstructions = true;
	}
	return result;
}
