import {
	normalizeUploadFileInput,
	parseImageUrl,
	type UploadFileInput,
	uploadFilenameFromObject,
	uploadMimeFromObject,
} from "../attachments/input";
import { firstNonEmptyString } from "../shared/strings";
import type { AttachmentFileRef } from "../attachments/types";
import { parseJsonObject } from "../shared/json";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type TextPart = {
	kind: "text";
	text: string;
	historyText: string | null;
	/**
	 * True when the text came from direct input text (string parts and
	 * text/input_text-typed parts); false for assistant output/summary echoes
	 * and unknown-typed text fallbacks, which prompt rendering includes but
	 * user-input extraction (image generation) must skip.
	 */
	inputText: boolean;
};

export type ReasoningPart = {
	kind: "reasoning";
	text: string;
	historyText: string | null;
	liftText: string | null;
};

export type ImagePart = {
	kind: "image";
	b64: string;
	mime: string;
	filename: string;
	remoteUrl: string;
	fileRef: AttachmentFileRef | null;
	hasInline: boolean;
	historyText: string | null;
};

export type FilePart = {
	kind: "file";
	upload: UploadFileInput | null;
	filename: string;
	remoteUrl: string;
	fileRef: AttachmentFileRef | null;
	label: string;
	historyText: string | null;
};

export type MessagePart = TextPart | ReasoningPart | ImagePart | FilePart;

export type InternalToolCall = {
	id: string;
	name: string;
	args: UnknownRecord;
};

export type InternalMessage = {
	role: MessageRole;
	roleLabel: string;
	parts: MessagePart[];
	toolCalls: InternalToolCall[];
	toolCallId: string;
	toolName: string;
	reasoningText: string;
};

export function parseOpenAIMessages(messages: unknown): InternalMessage[] {
	if (!Array.isArray(messages)) return [];
	const out: InternalMessage[] = [];
	for (const msg of messages) {
		if (!isRecord(msg)) continue;
		out.push(parseOpenAIMessage(msg));
	}
	return out;
}

/** Prompt-visible content text of a message rendered for history/latest-input. */
export function historyContentText(message: InternalMessage): string {
	const parts: string[] = [];
	for (const part of message.parts) {
		if (part.historyText !== null) parts.push(part.historyText);
	}
	return parts.join("\n");
}

/** Direct reasoning field first, else content-embedded reasoning part text. */
export function messageReasoningText(message: InternalMessage): string {
	if (message.reasoningText) return message.reasoningText;
	const parts: string[] = [];
	for (const part of message.parts) {
		if (part.kind === "reasoning" && part.liftText !== null)
			parts.push(part.liftText);
	}
	return parts.join("\n").trim();
}

export type ParsedAssistantContent = {
	text: string;
	reasoning: string;
	toolCalls: InternalToolCall[];
};

/** Parse assistant content parts once for Responses item normalization. */
export function parseAssistantContent(
	item: UnknownRecord,
): ParsedAssistantContent {
	const content =
		item.content ?? (typeof item.text === "string" ? item.text : null);
	let text = "";
	let reasoning = flattenText(
		item.reasoning_content || item.reasoning || item.thinking,
	);
	const toolCalls = parseMessageToolCalls(item.tool_calls);
	const parts = Array.isArray(content)
		? content
		: [content].filter((part) => part != null);
	for (const raw of parts) {
		if (isRecord(raw)) {
			const type = String(raw.type || "")
				.trim()
				.toLowerCase();
			if (type === "function_call" || type === "tool_call") {
				const call = parseContentToolCall(raw, toolCalls.length);
				if (call) toolCalls.push(call);
				continue;
			}
		}
		if (typeof raw === "string") {
			text += raw;
			continue;
		}
		const part = parseMessagePart(raw);
		if (!part) continue;
		if (part.kind === "text") text += part.text;
		else if (part.kind === "reasoning") reasoning += part.text;
	}
	return { text, reasoning, toolCalls };
}

function parseContentToolCall(
	raw: UnknownRecord,
	index: number,
): InternalToolCall | null {
	const fn = isRecord(raw.function) ? raw.function : {};
	const name = String(raw.name || fn.name || "").trim();
	if (!name) return null;
	const id = String(raw.call_id || raw.id || `call_${index}`);
	return {
		id,
		name,
		args: parseToolCallArgs(
			raw.arguments ?? raw.input ?? fn.arguments ?? fn.input,
		),
	};
}

function parseToolCallArgs(value: unknown): UnknownRecord {
	return isRecord(value) ? value : parseJsonObject(String(value ?? "{}"));
}

function parseOpenAIMessage(msg: UnknownRecord): InternalMessage {
	const roleLabel = normalizeMessageRole(msg.role);
	const role = messageRoleBucket(roleLabel);
	const message: InternalMessage = {
		role,
		roleLabel,
		parts: [
			...parseMessageContent(msg.content != null ? msg.content : msg.text),
			...parseMessageContent(msg.attachments),
		],
		toolCalls:
			role === "assistant" ? parseMessageToolCalls(msg.tool_calls) : [],
		toolCallId: "",
		toolName: "",
		reasoningText: role === "assistant" ? directReasoningText(msg) : "",
	};
	if (role === "tool") {
		message.toolName = msg.name ? String(msg.name) : "";
		message.toolCallId = msg.tool_call_id ? String(msg.tool_call_id) : "";
	}
	return message;
}

/**
 * Role normalization for message/history records: `function` -> `tool`,
 * `developer` -> `system`, default `user`.
 */
export function normalizeMessageRole(role: unknown): string {
	const r = String(role || "")
		.trim()
		.toLowerCase();
	if (r === "function") return "tool";
	if (r === "developer") return "system";
	return r || "user";
}

/** Whether an item/part type flattens to text (text|input_text|output_text|summary_text). */
export function isTextPartType(type: unknown): boolean {
	const t = String(type || "")
		.trim()
		.toLowerCase();
	return (
		t === "text" ||
		t === "input_text" ||
		t === "output_text" ||
		t === "summary_text"
	);
}

/** Reasoning text of a raw OpenAI-shaped message record (direct field or content parts). */
export function rawRecordReasoningText(msg: unknown): string {
	if (!isRecord(msg)) return "";
	const direct = msg.reasoning_content || msg.reasoning || msg.thinking;
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	const content = msg.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (!isRecord(c)) continue;
		const typ = String(c.type || "").toLowerCase();
		if (
			(typ === "reasoning" || typ === "thinking") &&
			typeof c.text === "string"
		)
			parts.push(c.text);
	}
	return parts.join("\n").trim();
}

function messageRoleBucket(roleLabel: string): MessageRole {
	if (
		roleLabel === "system" ||
		roleLabel === "assistant" ||
		roleLabel === "tool"
	)
		return roleLabel;
	return "user";
}

function directReasoningText(msg: UnknownRecord): string {
	const direct = msg.reasoning_content || msg.reasoning || msg.thinking;
	if (typeof direct === "string" && direct.trim()) return direct.trim();
	return "";
}

function parseMessageToolCalls(raw: unknown): InternalToolCall[] {
	if (!Array.isArray(raw)) return [];
	const calls: InternalToolCall[] = [];
	for (const tc of raw) {
		const record = isRecord(tc) ? tc : null;
		const fn = record && isRecord(record.function) ? record.function : null;
		calls.push({
			id: toolCallID(record),
			name: fn?.name ? String(fn.name) : "",
			args: parseToolCallArgs(fn?.arguments),
		});
	}
	return calls;
}

function toolCallID(record: UnknownRecord | null): string {
	if (!record) return "";
	if (record.id != null) return String(record.id);
	if (record.call_id != null) return String(record.call_id);
	return "";
}

function parseMessageContent(content: unknown): MessagePart[] {
	if (content == null) return [];
	if (typeof content === "string")
		return [
			{ kind: "text", text: content, historyText: content, inputText: true },
		];
	if (typeof content === "number" || typeof content === "boolean") {
		const text = String(content);
		return [{ kind: "text", text, historyText: text, inputText: true }];
	}
	if (Array.isArray(content)) {
		const parts: MessagePart[] = [];
		for (const item of content) {
			const part = parseMessagePart(item, "item");
			if (part) parts.push(part);
		}
		return parts;
	}
	if (!isRecord(content)) return [];
	const part = parseMessagePart(content, "content");
	return part ? [part] : [];
}

type PartParseMode = "item" | "content";

/** The single raw content-part walker. */
export function parseMessagePart(
	raw: unknown,
	mode: PartParseMode = "item",
): MessagePart | null {
	if (typeof raw === "string")
		return { kind: "text", text: raw, historyText: null, inputText: true };
	if (!isRecord(raw)) return null;
	const historyText =
		mode === "content" ? stringifyContent(raw) : historyTextForRecord(raw);
	const type = String(raw.type || "")
		.trim()
		.toLowerCase();
	if (mode === "content") {
		if (type === "image_url" || type === "image" || type === "input_image")
			return imagePart(raw, contentImagePayload(raw), historyText);
		if (type === "input_file" || type === "file")
			return filePart(raw, historyText);
		const text = flattenText(raw);
		return {
			kind: "text",
			text: text || stringifyContent(raw),
			historyText,
			inputText: true,
		};
	}
	if (
		type === "text" ||
		type === "input_text" ||
		type === "output_text" ||
		type === "summary_text"
	)
		return {
			kind: "text",
			text: flattenText(raw.text),
			historyText,
			inputText: type === "text" || type === "input_text",
		};
	if (type === "reasoning" || type === "thinking") {
		const rawTypeLower = String(raw.type || "").toLowerCase();
		return {
			kind: "reasoning",
			text: flattenText(raw.summary ?? raw.text ?? raw.content),
			historyText,
			liftText:
				(rawTypeLower === "reasoning" || rawTypeLower === "thinking") &&
				typeof raw.text === "string"
					? raw.text
					: null,
		};
	}
	if (type === "image_url" || raw.image_url) {
		const urlValue = raw.image_url != null ? raw.image_url : raw.url;
		return imagePart(raw, parsedImagePayload(raw, urlValue), historyText);
	}
	if (type === "image" || type === "input_image") {
		const source = isRecord(raw.source) ? raw.source : null;
		if (source?.data)
			return imagePart(
				raw,
				{
					b64: String(source.data),
					mime: uploadMimeFromObject(raw) || "image/png",
				},
				historyText,
			);
		const urlValue = raw.image_url != null ? raw.image_url : raw.url;
		if (urlValue != null)
			return imagePart(raw, parsedImagePayload(raw, urlValue), historyText);
		return imagePart(raw, null, historyText);
	}
	if (type === "input_file" || type === "file")
		return filePart(raw, historyText);
	if (raw.text != null || raw.content != null || raw.output != null)
		return {
			kind: "text",
			text: flattenText(raw.text ?? raw.content ?? raw.output),
			historyText,
			inputText: false,
		};
	if (historyText !== null)
		return { kind: "text", text: "", historyText, inputText: false };
	return null;
}

/** Per-part history text; replicates contentTextForHistory array-item rules. */
function historyTextForRecord(raw: UnknownRecord): string | null {
	if (typeof raw.text === "string") return raw.text;
	if (typeof raw.input_text === "string") return raw.input_text;
	if (raw.type === "input_file" || raw.type === "file")
		return filePlaceholder(raw);
	if (raw.type === "image_url" || raw.image_url || raw.inlineData || raw.source)
		return "[image input]";
	return null;
}

function stringifyContent(content: unknown): string {
	try {
		return JSON.stringify(content);
	} catch (_) {
		return String(content);
	}
}

/** Recursive text flattening; replicates responsesContentToText. */
export function flattenText(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (typeof content === "number" || typeof content === "boolean")
		return String(content);
	if (Array.isArray(content))
		return content
			.map((item) => flattenText(item))
			.filter(Boolean)
			.join(" ");
	if (!isRecord(content)) return "";
	const type = String(content.type || "").trim();
	if (
		type === "text" ||
		type === "input_text" ||
		type === "output_text" ||
		type === "summary_text"
	)
		return flattenText(content.text);
	if (type === "input_image" || type === "image" || type === "image_url")
		return "[image input]";
	if (type === "input_file" || type === "file") return filePlaceholder(content);
	if (content.text != null) return flattenText(content.text);
	if (content.output != null) return flattenText(content.output);
	return "";
}

type ImagePayload = { b64: string; mime: string };

function contentImagePayload(raw: UnknownRecord): ImagePayload | null {
	const source = isRecord(raw.source) ? raw.source : null;
	if (source?.data)
		return {
			b64: String(source.data),
			mime: uploadMimeFromObject(raw) || "image/png",
		};
	const urlValue = raw.image_url != null ? raw.image_url : raw.url;
	return parsedImagePayload(raw, urlValue);
}

function parsedImagePayload(
	raw: UnknownRecord,
	urlValue: unknown,
): ImagePayload | null {
	const url = isRecord(urlValue) ? urlValue.url : urlValue;
	const parsed = parseImageUrl(url, uploadMimeFromObject(raw));
	return parsed ? { b64: parsed.b64, mime: parsed.mime } : null;
}

function imagePart(
	raw: UnknownRecord,
	payload: ImagePayload | null,
	historyText: string | null,
): ImagePart {
	return {
		kind: "image",
		b64: payload ? payload.b64 : "",
		mime: payload ? payload.mime : uploadMimeFromObject(raw),
		filename: uploadFilenameFromObject(raw),
		remoteUrl: remoteUrlFromRecord(raw),
		fileRef: payload ? null : existingFileRefFromRecord(raw, false),
		hasInline: !!payload,
		historyText,
	};
}

function filePart(raw: UnknownRecord, historyText: string | null): FilePart {
	const upload = normalizeUploadFileInput(raw);
	return {
		kind: "file",
		upload,
		filename: uploadFilenameFromObject(raw),
		remoteUrl: remoteUrlFromRecord(raw),
		fileRef: upload?.b64 != null ? null : existingFileRefFromRecord(raw, true),
		label: fileLabel(raw),
		historyText,
	};
}

function fileLabel(raw: UnknownRecord): string {
	const fileData = firstRecord(raw.fileData, raw.file_data);
	return firstNonEmptyString(
		raw.file_id,
		uploadFilenameFromObject(raw),
		fileData && (fileData.fileUri || fileData.file_uri),
		raw.id,
	);
}

function filePlaceholder(raw: UnknownRecord): string {
	const label = fileLabel(raw);
	return `[file input${label ? ` ${label}` : ""}]`;
}

function remoteUrlFromRecord(raw: UnknownRecord): string {
	const direct = firstNonEmptyString(raw.url, raw.file_url, raw.fileUrl);
	if (isRemoteUrl(direct)) return direct;
	const source = isRecord(raw.source) ? raw.source : null;
	const sourceUrl = source
		? firstNonEmptyString(
				source.url,
				source.file_url,
				source.fileUrl,
				source.file_uri,
				source.fileUri,
			)
		: "";
	if (isRemoteUrl(sourceUrl)) return sourceUrl;
	const imageUrl = isRecord(raw.image_url) ? raw.image_url : null;
	if (imageUrl && isRemoteUrl(imageUrl.url)) return String(imageUrl.url);
	if (isRemoteUrl(raw.image_url)) return String(raw.image_url);
	const file = isRecord(raw.file) ? raw.file : null;
	const fileUrl = file
		? firstNonEmptyString(file.url, file.file_url, file.fileUrl)
		: "";
	if (isRemoteUrl(fileUrl)) return fileUrl;
	const fileData = firstRecord(raw.fileData, raw.file_data);
	const nestedUrl = fileData
		? firstNonEmptyString(fileData.url, fileData.file_uri, fileData.fileUri)
		: "";
	return isRemoteUrl(nestedUrl) ? nestedUrl : "";
}

function isRemoteUrl(value: unknown): boolean {
	return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function existingFileRefFromRecord(
	raw: UnknownRecord,
	includeDirectID: boolean,
): AttachmentFileRef | null {
	const id =
		raw.file_id ??
		raw.fileId ??
		raw.file_ref ??
		raw.fileRef ??
		raw.ref ??
		(includeDirectID ? raw.id : null);
	if (id == null) {
		const file = isRecord(raw.file) ? raw.file : null;
		const nested = file
			? (file.file_id ??
				file.fileId ??
				file.file_ref ??
				file.fileRef ??
				file.ref ??
				file.id)
			: null;
		if (nested == null) return null;
		const name = firstNonEmptyString(
			uploadFilenameFromObject(file),
			uploadFilenameFromObject(raw),
		);
		return name ? { id: String(nested), name } : String(nested);
	}
	const name = uploadFilenameFromObject(raw);
	return name ? { id: String(id), name } : String(id);
}
