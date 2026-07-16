import {
	normalizeUploadFileInput,
	parseImageUrl,
	type UploadFileInput,
	uploadFilenameFromObject,
	uploadMimeFromObject,
} from "../attachments/input";
import { firstNonEmptyString } from "../attachments/mime";
import type { AttachmentFileRef } from "../attachments/types";
import { parseJsonObject } from "../shared/json";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type TextPart = {
	kind: "text";
	text: string;
	historyText: string | null;
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

function parseOpenAIMessage(msg: UnknownRecord): InternalMessage {
	const roleLabel = normalizeMessageRole(msg.role);
	const role = messageRoleBucket(roleLabel);
	const message: InternalMessage = {
		role,
		roleLabel,
		parts: parseMessageContent(msg.content),
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

function normalizeMessageRole(role: unknown): string {
	const r = String(role || "")
		.trim()
		.toLowerCase();
	if (r === "function") return "tool";
	if (r === "developer") return "system";
	return r || "user";
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
			args: parseJsonObject(String(fn?.arguments || "{}")),
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
		return [{ kind: "text", text: content, historyText: content }];
	if (typeof content === "number" || typeof content === "boolean") {
		const text = String(content);
		return [{ kind: "text", text, historyText: text }];
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
function parseMessagePart(
	raw: unknown,
	mode: PartParseMode,
): MessagePart | null {
	if (typeof raw === "string")
		return { kind: "text", text: raw, historyText: null };
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
		return { kind: "text", text: text || stringifyContent(raw), historyText };
	}
	if (
		type === "text" ||
		type === "input_text" ||
		type === "output_text" ||
		type === "summary_text"
	)
		return { kind: "text", text: flattenText(raw.text), historyText };
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
		if (raw.image_url)
			return imagePart(
				raw,
				parsedImagePayload(raw, raw.image_url),
				historyText,
			);
		return imagePart(raw, null, historyText);
	}
	if (type === "input_file" || type === "file")
		return filePart(raw, historyText);
	if (raw.text != null || raw.content != null || raw.output != null)
		return {
			kind: "text",
			text: flattenText(raw.text ?? raw.content ?? raw.output),
			historyText,
		};
	if (historyText !== null) return { kind: "text", text: "", historyText };
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
function flattenText(content: unknown): string {
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
		fileRef: existingFileRefFromRecord(raw),
		hasInline: !!payload,
		historyText,
	};
}

function filePart(raw: UnknownRecord, historyText: string | null): FilePart {
	return {
		kind: "file",
		upload: normalizeUploadFileInput(raw),
		filename: uploadFilenameFromObject(raw),
		remoteUrl: remoteUrlFromRecord(raw),
		fileRef: existingFileRefFromRecord(raw),
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
): AttachmentFileRef | null {
	const id =
		raw.file_id ?? raw.fileId ?? raw.file_ref ?? raw.fileRef ?? raw.ref;
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
