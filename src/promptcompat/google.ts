import { uploadFilenameFromObject } from "../attachments/input";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";
import {
	type InternalMessage,
	type InternalToolCall,
	type MessagePart,
	parseMessagePart,
} from "./message-model";

/**
 * Parse a Google `generateContent` request (contents/parts + systemInstruction)
 * into the shared internal message model. Each Google-wire part is dispatched
 * through the single content-part walker (`parseMessagePart`) via an intermediate
 * OpenAI-shaped part record, so there is one part parser for both dialects.
 */
export function parseGoogleRequest(req: unknown): InternalMessage[] {
	const request = isRecord(req) ? req : {};
	const messages: InternalMessage[] = [];

	const sysInst = isRecord(request.systemInstruction)
		? request.systemInstruction
		: null;
	if (sysInst && Array.isArray(sysInst.parts)) {
		const sysText = sysInst.parts
			.filter((part) => isRecord(part) && part.text)
			.map((part) => (isRecord(part) ? part.text : ""))
			.join(" ");
		if (sysText)
			messages.push(makeMessage("system", parseParts([{ text: sysText }])));
	}

	const contents = Array.isArray(request.contents) ? request.contents : [];
	for (const content of contents) {
		if (!isRecord(content)) continue;
		const role = content.role === "model" ? "assistant" : "user";
		let pending: unknown[] = [];
		const toolCalls: InternalToolCall[] = [];
		const parts = Array.isArray(content.parts) ? content.parts : [];

		const flushContent = () => {
			if (!pending.length && !toolCalls.length) return;
			messages.push(makeMessage(role, parseParts(pending), toolCalls.splice(0)));
			pending = [];
		};

		for (const p of parts) {
			if (!isRecord(p)) continue;
			if (p.text) {
				pending.push({ type: "text", text: p.text });
			} else if (p.inlineData || p.inline_data) {
				const inlineData = firstRecord(p.inlineData, p.inline_data) || {};
				const mime = inlineData.mimeType || inlineData.mime_type || "image/png";
				const isImage = String(mime || "")
					.trim()
					.toLowerCase()
					.startsWith("image/");
				pending.push({
					type: isImage ? "image" : "file",
					source: { data: inlineData.data, media_type: mime },
					filename: uploadNameFromPart(p),
				});
			} else if (p.fileData || p.file_data) {
				const fileData = firstRecord(p.fileData, p.file_data) || {};
				pending.push({
					type: "file",
					fileData,
					filename: uploadNameFromPart(p),
				});
			} else if (isRecord(p.functionCall)) {
				const fc = p.functionCall;
				toolCalls.push({
					id: "",
					name: String(fc.name || ""),
					args: isRecord(fc.args) ? fc.args : {},
				});
			} else if (isRecord(p.functionResponse)) {
				const fr = p.functionResponse;
				flushContent();
				messages.push({
					role: "tool",
					roleLabel: "tool",
					parts: parseParts([
						{ type: "text", text: JSON.stringify(fr.response || {}) },
					]),
					toolCalls: [],
					toolCallId: "",
					toolName: fr.name ? String(fr.name) : "",
					reasoningText: "",
				});
			}
		}

		flushContent();
	}

	return messages;
}

function makeMessage(
	role: "system" | "user" | "assistant",
	parts: MessagePart[],
	toolCalls: InternalToolCall[] = [],
): InternalMessage {
	return {
		role,
		roleLabel: role,
		parts,
		toolCalls,
		toolCallId: "",
		toolName: "",
		reasoningText: "",
	};
}

function parseParts(rawParts: readonly unknown[]): MessagePart[] {
	const out: MessagePart[] = [];
	for (const raw of rawParts) {
		const part = parseMessagePart(raw, "item");
		if (part) out.push(part);
	}
	return out;
}

function uploadNameFromPart(part: UnknownRecord): string {
	return uploadFilenameFromObject(part);
}
