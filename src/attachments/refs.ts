import { isRecord } from "../shared/types";
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
		seen: new Set(out.map(refKey).filter(Boolean) as string[]),
	};
	appendRefs(state, refs);
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
	const id = raw.ref ?? raw.fileRef ?? raw.id ?? raw.file_id;
	if (id != null) addRef(state, id, raw.name ?? raw.filename ?? raw.file_name);
}

function addRef(
	state: ExistingRefState,
	fileID: unknown,
	filename: unknown = undefined,
): void {
	const id = String(fileID || "").trim();
	if (!id || state.seen.has(id)) return;
	state.seen.add(id);
	const name = typeof filename === "string" ? filename.trim() : "";
	state.out.push(name ? { id, name } : id);
}

function refKey(ref: AttachmentFileRef): string {
	if (typeof ref === "string") return ref;
	return ref.ref || ref.fileRef || ref.id || "";
}
