import { isRecord } from "../shared/types";
import { imageFilenameFromObject, normalizeUploadFileInput } from "./input";
import { sanitizeUploadFilename } from "./mime";
import type { AttachmentFileRef } from "./types";

type ExistingRefState = {
	out: AttachmentFileRef[];
	seen: Set<string>;
};

export function collectOpenAIRefFileIDs(
	req: unknown,
): AttachmentFileRef[] | null {
	if (!isRecord(req)) return null;
	const state: ExistingRefState = { out: [], seen: new Set() };
	for (const key of [
		"ref_file_ids",
		"file_ids",
		"attachments",
		"messages",
		"input",
	]) {
		const raw = req[key];
		if (raw == null) continue;
		if ((key === "messages" || key === "input") && typeof raw === "string")
			continue;
		appendOpenAIRefFileIDs(state, raw);
	}
	return state.out.length ? state.out : null;
}

export function appendExistingFileRefs(
	out: AttachmentFileRef[],
	refs: unknown,
): void {
	const state: ExistingRefState = {
		out,
		seen: new Set(out.map(refKey).filter(Boolean) as string[]),
	};
	appendDirectOrOpenAIRefFileIDs(state, refs);
}

function appendOpenAIRefFileIDs(state: ExistingRefState, raw: unknown): void {
	if (raw == null) return;
	if (typeof raw === "string") {
		addOpenAIRefFileID(state, raw);
		return;
	}
	if (Array.isArray(raw)) {
		for (const item of raw) appendOpenAIRefFileIDs(state, item);
		return;
	}
	if (!isRecord(raw)) return;

	const rawFilename = imageFilenameFromObject(raw);
	if (raw.file_id != null) addOpenAIRefFileID(state, raw.file_id, rawFilename);
	const typ = String(raw.type || "")
		.trim()
		.toLowerCase();
	const hasInlinePayload =
		typ.includes("file") && !!normalizeUploadFileInput(raw);
	if (typ.includes("file") && !hasInlinePayload && raw.id != null)
		addOpenAIRefFileID(state, raw.id, rawFilename);
	const file = isRecord(raw.file) ? raw.file : null;
	if (file) {
		const fileFilename = imageFilenameFromObject(file) || rawFilename;
		const nestedInlinePayload = !!normalizeUploadFileInput(file);
		if (file.file_id != null)
			addOpenAIRefFileID(state, file.file_id, fileFilename);
		if (!nestedInlinePayload && file.id != null)
			addOpenAIRefFileID(state, file.id, fileFilename);
	}
	for (const key of [
		"ref_file_ids",
		"file_ids",
		"attachments",
		"messages",
		"input",
		"content",
		"files",
		"items",
		"data",
		"source",
	]) {
		if (!(key in raw)) continue;
		if (hasInlinePayload && (key === "data" || key === "source")) continue;
		const nested = raw[key];
		if ((key === "content" || key === "input") && typeof nested === "string")
			continue;
		appendOpenAIRefFileIDs(state, nested);
	}
}

function appendDirectOrOpenAIRefFileIDs(
	state: ExistingRefState,
	refs: unknown,
): void {
	if (refs == null) return;
	if (typeof refs === "string") {
		addOpenAIRefFileID(state, refs);
		return;
	}
	if (Array.isArray(refs)) {
		for (const ref of refs) appendDirectOrOpenAIRefFileIDs(state, ref);
		return;
	}
	if (isRecord(refs)) {
		const id = refs.ref || refs.fileRef || refs.id || refs.file_id;
		const name = refs.name || refs.filename || refs.file_name;
		if (id != null) {
			addOpenAIRefFileID(state, id, name);
			return;
		}
	}
	appendOpenAIRefFileIDs(state, refs);
}

function addOpenAIRefFileID(
	state: ExistingRefState,
	fileID: unknown,
	filename: unknown = undefined,
): void {
	const id = String(fileID || "").trim();
	if (!id || state.seen.has(id)) return;
	state.seen.add(id);
	const name = sanitizeUploadFilename(filename);
	state.out.push(name ? { id, name } : id);
}

function refKey(ref: AttachmentFileRef): string {
	if (typeof ref === "string") return ref;
	return ref.ref || ref.fileRef || ref.id || "";
}
