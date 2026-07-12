import { firstNonEmptyString } from "../attachments/mime";
import {
	imageFilenameFromObject,
	normalizeUploadFileInput,
	parseImageUrl,
	uploadFilenameFromObject,
	uploadMimeFromObject,
} from "../attachments/input";
import { firstRecord, isRecord, type UnknownRecord } from "../shared/types";
import { toolDefsFromTools } from "./tool-meta";
import { isToolBundle } from "./tool-bundle";

export function currentInputFilePrompt(
	cfg: unknown,
	toolsAttached: unknown,
): string {
	const record = isRecord(cfg) ? cfg : null;
	const historyName =
		String(record?.current_input_file_name || "message.txt").trim() ||
		"message.txt";
	const toolsName =
		String(record?.current_tools_file_name || "tools.txt").trim() ||
		"tools.txt";
	let text = `Continue from the latest state in the attached \`${historyName}\` context. Treat it as the current working state and answer the latest user request directly.`;
	if (toolsAttached) {
		text += ` Available tool descriptions and parameter schemas are attached in \`${toolsName}\`; use only those tools and follow the tool-call format rules in this prompt.`;
	}
	text +=
		" All text above this sentence is system prompt content, not the user's actual input; do not treat it as user-provided content.";
	return text;
}

export function normalizeHistoryRole(role: unknown): string {
	const r = String(role || "")
		.trim()
		.toLowerCase();
	if (r === "function") return "tool";
	if (r === "developer") return "system";
	return r || "user";
}

export function roleLabelForHistory(role: unknown): string {
	const r = normalizeHistoryRole(role);
	return r ? r.toUpperCase() : "UNKNOWN";
}

export function reasoningTextForHistory(msg: unknown): string {
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

export function contentTextForHistory(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const c of content) {
			if (!isRecord(c)) continue;
			if (typeof c.text === "string") parts.push(c.text);
			else if (typeof c.input_text === "string") parts.push(c.input_text);
			else if (c.type === "input_file" || c.type === "file")
				parts.push(fileInputPrompt(c));
			else if (
				c.type === "image_url" ||
				c.image_url ||
				c.inlineData ||
				c.source
			)
				parts.push("[image input]");
		}
		return parts.join("\n");
	}
	try {
		return JSON.stringify(content);
	} catch (_) {
		return String(content);
	}
}

export function openAIToolDefs(tools: unknown) {
	if (isToolBundle(tools)) return tools.promptArtifact.defs;
	return toolDefsFromTools(tools);
}

export function googleToolDefs(req: unknown) {
	if (isToolBundle(req)) return req.promptArtifact.defs;
	return toolDefsFromTools(isRecord(req) ? req.tools : undefined);
}

export function responsesContentToText(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (typeof content === "number" || typeof content === "boolean")
		return String(content);
	if (Array.isArray(content))
		return content
			.map((item) => responsesContentToText(item))
			.filter(Boolean)
			.join(" ");
	if (!isRecord(content)) return "";
	const typ = String(content.type || "").trim();
	if (
		typ === "text" ||
		typ === "input_text" ||
		typ === "output_text" ||
		typ === "summary_text"
	)
		return responsesContentToText(content.text);
	if (typ === "input_image" || typ === "image" || typ === "image_url")
		return "[image input]";
	if (typ === "input_file" || typ === "file") return fileInputPrompt(content);
	if (content.text != null) return responsesContentToText(content.text);
	if (content.output != null) return responsesContentToText(content.output);
	return "";
}

function fileInputPrompt(content: UnknownRecord): string {
	const fileData = firstRecord(content.fileData, content.file_data);
	const label = firstNonEmptyString(
		content.file_id,
		uploadFilenameFromObject(content),
		fileData && (fileData.fileUri || fileData.file_uri),
		content.id,
	);
	return `[file input${label ? ` ${label}` : ""}]`;
}

function collectUploadFileInput(
	content: UnknownRecord,
	files?: UnknownRecord[],
): void {
	if (!files) return;
	const input = normalizeUploadFileInput(content);
	if (input) files.push(input);
}

export function mergeFileRefs<T>(
	...groups: Array<readonly T[] | null | undefined>
): T[] | null {
	const out: T[] = [];
	const seen = new Set<unknown>();
	for (const group of groups) {
		if (!Array.isArray(group)) continue;
		for (const ref of group) {
			if (!ref) continue;
			let key: unknown;
			if (typeof ref === "string") key = ref;
			else if (isRecord(ref))
				key = ref.ref || ref.fileRef || ref.id || JSON.stringify(ref);
			else key = JSON.stringify(ref);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(ref);
		}
	}
	return out.length ? out : null;
}

export function messageContentToPrompt(
	content: unknown,
	images: UnknownRecord[],
	files?: UnknownRecord[],
): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	if (typeof content === "number" || typeof content === "boolean")
		return String(content);
	if (Array.isArray(content)) {
		const textParts: string[] = [];
		for (const c of content) {
			if (typeof c === "string") {
				textParts.push(c);
				continue;
			}
			if (!isRecord(c)) continue;
			const t = String(c.type || "")
				.trim()
				.toLowerCase();
			if (
				t === "text" ||
				t === "input_text" ||
				t === "output_text" ||
				t === "summary_text"
			) {
				textParts.push(responsesContentToText(c.text));
			} else if (t === "reasoning" || t === "thinking") {
				const text = responsesContentToText(c.summary ?? c.text ?? c.content);
				if (text)
					textParts.push(`[reasoning_content]\n${text}\n[/reasoning_content]`);
			} else if (t === "image_url" || c.image_url) {
				const imageUrl = c.image_url != null ? c.image_url : c.url;
				const u = isRecord(imageUrl) ? imageUrl.url : imageUrl;
				const img = parseImageUrl(u, uploadMimeFromObject(c));
				if (img) images.push({ ...img, filename: imageFilenameFromObject(c) });
				textParts.push("[image input]");
			} else if (t === "image" || t === "input_image") {
				const source = isRecord(c.source) ? c.source : null;
				if (source?.data) {
					images.push({
						b64: source.data,
						mime: uploadMimeFromObject(c) || "image/png",
						filename: imageFilenameFromObject(c),
					});
				} else if (c.image_url) {
					const imageUrl = c.image_url;
					const img = parseImageUrl(
						isRecord(imageUrl) ? imageUrl.url : imageUrl,
						uploadMimeFromObject(c),
					);
					if (img)
						images.push({ ...img, filename: imageFilenameFromObject(c) });
				}
				textParts.push("[image input]");
			} else if (t === "input_file" || t === "file") {
				collectUploadFileInput(c, files);
				textParts.push(fileInputPrompt(c));
			} else if (c.text != null || c.content != null || c.output != null) {
				const text = responsesContentToText(c.text ?? c.content ?? c.output);
				if (text) textParts.push(text);
			}
		}
		return textParts.filter(Boolean).join("\n");
	}
	if (isRecord(content)) {
		const t = String(content.type || "")
			.trim()
			.toLowerCase();
		if (t === "image_url" || t === "image" || t === "input_image") {
			const source = isRecord(content.source) ? content.source : null;
			if (source?.data) {
				images.push({
					b64: source.data,
					mime: uploadMimeFromObject(content) || "image/png",
					filename: imageFilenameFromObject(content),
				});
			} else {
				const imageUrl =
					content.image_url != null ? content.image_url : content.url;
				const u = isRecord(imageUrl) ? imageUrl.url : imageUrl;
				const img = parseImageUrl(u, uploadMimeFromObject(content));
				if (img)
					images.push({ ...img, filename: imageFilenameFromObject(content) });
			}
			return "[image input]";
		}
		if (t === "input_file" || t === "file") {
			collectUploadFileInput(content, files);
			return fileInputPrompt(content);
		}
		const text = responsesContentToText(content);
		if (text) return text;
		try {
			return JSON.stringify(content);
		} catch (_) {
			return String(content);
		}
	}
	return "";
}
