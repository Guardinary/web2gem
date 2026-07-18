import { formatPromptToolCallBlock } from "../toolcall/prompt-format";
import type { ToolBundle } from "../toolcall/tool-bundle";
import { type InternalMessage, renderMessageBody } from "./message-model";
import {
	createPromptPartAccumulator,
	type PromptBuildResult,
} from "./prompt-text";

export type PromptToolContext = {
	bundle: ToolBundle;
	choiceInstruction: string;
	/** False when tool choice/mode is none: tools stay declared but unprompted. */
	include: boolean;
};

export function messagesToPrompt(
	messages: readonly InternalMessage[],
	toolContext: PromptToolContext | null,
	maxPromptBytes?: number | null,
): PromptBuildResult {
	const prompt = createPromptPartAccumulator(maxPromptBytes);
	let latestInputText = "";
	const includeTools = !!toolContext?.include;
	const promptToolDefs =
		includeTools && toolContext ? toolContext.bundle.promptArtifact.defs : [];

	if (promptToolDefs.length && toolContext) {
		prompt.add(
			toolContext.bundle.promptArtifact.inlinePromptBlock(
				toolContext.choiceInstruction,
			),
		);
	}
	const hiddenPromptInsertOffset = promptToolDefs.length
		? prompt.length()
		: null;

	for (const msg of messages) {
		const content = renderMessageBody(msg, "prompt");

		if (msg.role === "system") {
			prompt.add(`[System instruction]: ${content}`);
		} else if (msg.role === "assistant") {
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
			const latest = renderMessageBody(msg, "latest-input").trim();
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
