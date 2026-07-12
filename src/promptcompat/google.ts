import { imageFilenameFromObject } from "../attachments/input";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";
import { messageContentToPrompt, openAIToolDefs } from "../toolcall/content";
import {
	googleAllowedFunctionNames,
	googleFunctionCallingConfig,
} from "../toolcall/policy-google";
import { formatPromptToolCallBlock } from "../toolcall/prompt-format";
import { toolPromptBlockFor } from "../toolcall/tool-bundle";
import { createPromptPartAccumulator } from "./prompt-text";

type GooglePromptToolCall = {
	name: unknown;
	args: unknown;
};
type ToolPromptDef = {
	name?: unknown;
	description?: unknown;
	parameters?: unknown;
};

// Google native API prompt conversion helpers.
export function buildGoogleToolPrompt(
	toolDefs: unknown,
	req: unknown,
	toolPromptSource?: unknown,
): string {
	const fallbackDefs = Array.isArray(toolDefs)
		? (toolDefs as readonly ToolPromptDef[])
		: undefined;
	return toolPromptBlockFor(
		toolPromptSource || toolDefs,
		googleToolChoiceInstruction(req),
		fallbackDefs,
	);
}

export function googleToolChoiceInstruction(req: unknown): string {
	const fc = googleFunctionCallingConfig(req);
	const mode = String(fc.mode || "AUTO")
		.trim()
		.toUpperCase();
	const allowed = googleAllowedFunctionNames(fc);
	if (mode === "NONE")
		return "\n\nIMPORTANT: Do NOT call any tools. Respond with text only.";
	if (mode === "ANY") {
		if (allowed.length) {
			const names = allowed.map((name) => `"${name}"`).join(", ");
			return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
		}
		return "\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.";
	}
	return "";
}

/** Google contents/tools/systemInstruction -> [promptString, images]. */
export function googleContentsToPrompt(
	req: unknown,
	toolDefsOverride: unknown,
	maxPromptBytes?: number | null,
	toolPromptSource?: unknown,
) {
	const request = isRecord(req) ? req : {};
	const prompt = createPromptPartAccumulator(maxPromptBytes);
	const images: UnknownRecord[] = [];
	const files: UnknownRecord[] = [];
	const fcMode = String(googleFunctionCallingConfig(req).mode || "AUTO")
		.trim()
		.toUpperCase();
	let promptToolDefs: readonly ToolPromptDef[] = [];
	if (fcMode !== "NONE") {
		promptToolDefs = Array.isArray(toolDefsOverride)
			? toolDefsOverride
			: openAIToolDefs(request.tools);
	}
	if (promptToolDefs.length) {
		prompt.add(buildGoogleToolPrompt(promptToolDefs, req, toolPromptSource));
	}
	const hiddenPromptInsertOffset = promptToolDefs.length
		? prompt.length()
		: undefined;

	const sysInst = isRecord(request.systemInstruction)
		? request.systemInstruction
		: null;
	if (sysInst && Array.isArray(sysInst.parts)) {
		const sysText = sysInst.parts
			.filter((part) => isRecord(part) && part.text)
			.map((part) => (isRecord(part) ? part.text : ""))
			.join(" ");
		if (sysText) prompt.add(`[System instruction]: ${sysText}`);
	}

	let latestInputText = "";
	const contents = Array.isArray(request.contents) ? request.contents : [];
	for (const content of contents) {
		if (!isRecord(content)) continue;
		const role = content.role === "model" ? "assistant" : "user";
		const msgContent: UnknownRecord[] = [];
		const toolCalls: GooglePromptToolCall[] = [];
		const latestParts: string[] = [];

		const flushContentOnly = () => {
			if (!msgContent.length) return;
			addGooglePromptMessage(prompt, images, files, role, msgContent, []);
			msgContent.length = 0;
		};

		const parts = Array.isArray(content.parts) ? content.parts : [];
		for (const p of parts) {
			if (!isRecord(p)) continue;
			if (p.text) {
				msgContent.push({ type: "text", text: p.text });
				if (role === "user") latestParts.push(String(p.text));
			} else if (p.inlineData || p.inline_data) {
				const inlineData = firstRecord(p.inlineData, p.inline_data) || {};
				const mime = inlineData.mimeType || inlineData.mime_type || "image/png";
				if (
					String(mime || "")
						.trim()
						.toLowerCase()
						.startsWith("image/")
				) {
					msgContent.push({
						type: "image",
						source: {
							data: inlineData.data,
							media_type: mime,
						},
						filename: imageFilenameFromObject(p),
					});
					if (role === "user") latestParts.push("[image input]");
				} else {
					msgContent.push({
						type: "file",
						source: {
							data: inlineData.data,
							media_type: mime,
						},
						filename: imageFilenameFromObject(p),
					});
					if (role === "user")
						latestParts.push(
							`[file input${imageFilenameFromObject(p) ? ` ${imageFilenameFromObject(p)}` : ""}]`,
						);
				}
			} else if (p.fileData || p.file_data) {
				const fileData = firstRecord(p.fileData, p.file_data) || {};
				msgContent.push({
					type: "file",
					fileData,
					filename: imageFilenameFromObject(p),
				});
				if (role === "user")
					latestParts.push(
						`[file input${fileData.fileUri ? ` ${fileData.fileUri}` : ""}]`,
					);
			} else if (isRecord(p.functionCall)) {
				const fc = p.functionCall;
				toolCalls.push({ name: fc.name || "", args: fc.args || {} });
			} else if (isRecord(p.functionResponse)) {
				const fr = p.functionResponse;
				flushContentOnly();
				prompt.add(
					`[Tool result${fr.name ? ` for ${fr.name}` : ""}]: ${JSON.stringify(fr.response || {})}`,
				);
			}
		}

		if (msgContent.length || toolCalls.length)
			addGooglePromptMessage(
				prompt,
				images,
				files,
				role,
				msgContent,
				toolCalls,
			);
		if (role === "user") {
			const latest = latestParts.join("\n").trim();
			if (latest) latestInputText = latest;
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

function addGooglePromptMessage(
	prompt: ReturnType<typeof createPromptPartAccumulator>,
	images: UnknownRecord[],
	files: UnknownRecord[],
	role: string,
	msgContent: UnknownRecord[],
	toolCalls: GooglePromptToolCall[],
): void {
	const content = messageContentToPrompt(msgContent, images, files);
	if (role === "assistant") {
		if (toolCalls.length) {
			const blocks = toolCalls.map((tc) =>
				formatPromptToolCallBlock(tc.name, tc.args || {}),
			);
			prompt.add(`[Assistant]: ${content || ""}\n${blocks.join("\n")}`);
		} else {
			prompt.add(`[Assistant]: ${content}`);
		}
	} else {
		prompt.add(content ? content : "");
	}
}

export function googleContentsToOpenAIMessages(req: unknown): UnknownRecord[] {
	const request = isRecord(req) ? req : {};
	const messages: UnknownRecord[] = [];
	const sysInst = isRecord(request.systemInstruction)
		? request.systemInstruction
		: null;
	if (sysInst && Array.isArray(sysInst.parts)) {
		const sysText = sysInst.parts
			.filter((part) => isRecord(part) && part.text)
			.map((part) => (isRecord(part) ? part.text : ""))
			.join(" ");
		if (sysText) messages.push({ role: "system", content: sysText });
	}

	const contents = Array.isArray(request.contents) ? request.contents : [];
	for (const content of contents) {
		if (!isRecord(content)) continue;
		const role = content.role === "model" ? "assistant" : "user";
		const msgContent: UnknownRecord[] = [];
		const toolCalls: UnknownRecord[] = [];
		const parts = Array.isArray(content.parts) ? content.parts : [];
		for (const p of parts) {
			if (!isRecord(p)) continue;
			if (p.text) {
				msgContent.push({ type: "text", text: p.text });
			} else if (p.inlineData || p.inline_data) {
				const inlineData = firstRecord(p.inlineData, p.inline_data) || {};
				const mime = inlineData.mimeType || inlineData.mime_type || "image/png";
				if (
					String(mime || "")
						.trim()
						.toLowerCase()
						.startsWith("image/")
				) {
					msgContent.push({
						type: "image",
						source: {
							data: inlineData.data,
							media_type: mime,
						},
						filename: imageFilenameFromObject(p),
					});
				} else {
					msgContent.push({
						type: "file",
						source: {
							data: inlineData.data,
							media_type: mime,
						},
						filename: imageFilenameFromObject(p),
					});
				}
			} else if (p.fileData || p.file_data) {
				const fileData = firstRecord(p.fileData, p.file_data) || {};
				msgContent.push({
					type: "file",
					fileData,
					filename: imageFilenameFromObject(p),
				});
			} else if (isRecord(p.functionCall)) {
				const fc = p.functionCall;
				toolCalls.push({
					type: "function",
					function: {
						name: fc.name || "",
						arguments: JSON.stringify(fc.args || {}),
					},
				});
			} else if (isRecord(p.functionResponse)) {
				const fr = p.functionResponse;
				if (msgContent.length) {
					messages.push({ role, content: [...msgContent] });
					msgContent.length = 0;
				}
				messages.push({
					role: "tool",
					name: fr.name || "",
					content: JSON.stringify(fr.response || {}),
				});
			}
		}
		if (msgContent.length || toolCalls.length) {
			const firstPart = msgContent[0] || null;
			const onlyText =
				msgContent.length === 1 && firstPart && firstPart.type === "text";
			const msg: UnknownRecord = {
				role,
				content: onlyText ? firstPart.text : msgContent,
			};
			if (toolCalls.length) msg.tool_calls = toolCalls;
			messages.push(msg);
		}
	}

	return messages;
}
