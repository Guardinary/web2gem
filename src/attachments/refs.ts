import { isRecord } from "../shared/types";
import { uploadFilenameFromObject } from "./metadata";
import type { AttachmentFileRef } from "./types";

type ExistingRefState = {
	out: AttachmentFileRef[];
	seen: Set<string>;
};

export function appendExistingFileRefs(
	out: AttachmentFileRef[],
	refs: unknown,
): void {
	const state: ExistingRefState = {
		out,
		seen: new Set(
			out
				.map((ref) => recognizedFileRefKey(ref))
				.filter((key): key is string => !!key),
		),
	};
	appendRefs(state, refs);
}

export function existingFileRefFromRecord(
	raw: unknown,
	includeDirectID: boolean,
): AttachmentFileRef | null {
	if (!isRecord(raw)) return null;
	let source = raw;
	let id = recognizedFileRefID(raw, includeDirectID);
	if (!id && isRecord(raw.file)) {
		source = raw.file;
		id = recognizedFileRefID(source, true);
	}
	if (!id) return null;
	const name =
		uploadFilenameFromObject(source) || uploadFilenameFromObject(raw);
	return name ? { id, name } : id;
}

export function recognizedFileRefID(
	raw: unknown,
	includeDirectID = true,
): string | null {
	if (typeof raw === "string") return normalizedRefID(raw);
	if (!isRecord(raw)) return null;
	const value =
		raw.file_id ??
		raw.fileId ??
		raw.file_ref ??
		raw.fileRef ??
		raw.ref ??
		(includeDirectID ? raw.id : null);
	return normalizedRefID(value);
}

export function recognizedFileRefKey(raw: unknown): string | null {
	return recognizedFileRefID(raw, true);
}

function appendRefs(state: ExistingRefState, raw: unknown): void {
	if (raw == null) return;
	if (typeof raw === "string") {
		addRef(state, raw);
		return;
	}
	if (Array.isArray(raw)) {
		for (const item of raw) appendRefs(state, item);
		return;
	}
	if (!isRecord(raw)) return;
	const ref = existingFileRefFromRecord(raw, true);
	if (ref) addRefValue(state, ref);
}

function addRefValue(state: ExistingRefState, ref: AttachmentFileRef): void {
	if (typeof ref === "string") {
		addRef(state, ref);
		return;
	}
	addRef(state, recognizedFileRefKey(ref), ref.name ?? ref.filename);
}

function addRef(
	state: ExistingRefState,
	fileID: unknown,
	filename: unknown = undefined,
): void {
	const id = normalizedRefID(fileID);
	if (!id || state.seen.has(id)) return;
	state.seen.add(id);
	const name = typeof filename === "string" ? filename.trim() : "";
	state.out.push(name ? { id, name } : id);
}

function normalizedRefID(value: unknown): string | null {
	const id = String(value ?? "").trim();
	return id || null;
}
