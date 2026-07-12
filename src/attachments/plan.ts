import { isRecord } from "../shared/types";
import {
	firstNonEmptyString,
	genericFilenameFromMime,
	imageFilenameFromMime,
	mimeFromFilename,
	sanitizeUploadFilename,
} from "./mime";
import {
	imageFilenameFromObject,
	normalizeUploadFileInput,
	type UploadFileInput,
} from "./input";
import { attachmentDrop } from "./notes";
import { appendExistingFileRefs } from "./refs";
import type {
	AttachmentCandidate,
	AttachmentDrop,
	AttachmentFileRef,
	AttachmentKind,
	AttachmentPlan,
} from "./types";

export const MAX_ATTACHMENTS_PER_REQUEST = 50;

type PlanState = {
	candidates: AttachmentCandidate[];
	existingFileRefs: AttachmentFileRef[];
	dropped: AttachmentDrop[];
	maxFiles: number;
	nextID: number;
};

type CreatePlanInput = {
	images?: unknown;
	files?: unknown;
	existingFileRefs?: unknown;
	maxFiles?: number;
};

export function createAttachmentPlan(
	input: CreatePlanInput = {},
): AttachmentPlan {
	const state: PlanState = {
		candidates: [],
		existingFileRefs: [],
		dropped: [],
		maxFiles: normalizeMaxFiles(input.maxFiles),
		nextID: 1,
	};
	appendExistingFileRefs(state.existingFileRefs, input.existingFileRefs);
	appendImageInputs(state, input.images);
	appendFileInputs(state, input.files);
	return finishPlan(state);
}

export function mergeAttachmentPlans(
	...plans: Array<AttachmentPlan | null | undefined>
): AttachmentPlan {
	const state: PlanState = {
		candidates: [],
		existingFileRefs: [],
		dropped: [],
		maxFiles: MAX_ATTACHMENTS_PER_REQUEST,
		nextID: 1,
	};
	for (const plan of plans) {
		if (!plan) continue;
		state.maxFiles = Math.min(state.maxFiles, normalizeMaxFiles(plan.maxFiles));
		appendExistingFileRefs(state.existingFileRefs, plan.existingFileRefs);
		for (const candidate of plan.candidates) {
			const meta: { filename?: string; mime?: string } = {};
			if (candidate.filename) meta.filename = candidate.filename;
			if (candidate.mime) meta.mime = candidate.mime;
			addCandidate(state, candidate.kind, candidate.source, meta);
		}
		state.dropped.push(...plan.dropped);
	}
	return finishPlan(state);
}

function appendImageInputs(state: PlanState, raw: unknown): void {
	if (!Array.isArray(raw)) return;
	for (let i = 0; i < raw.length; i++) {
		const image = raw[i];
		if (!isRecord(image)) continue;
		const b64 = image.b64;
		if (b64 == null) {
			state.dropped.push(
				attachmentDrop(
					"image",
					"invalid_image_input",
					"invalid image input",
					imageFilenameFromObject(image),
				),
			);
			continue;
		}
		const name =
			firstNonEmptyString(
				sanitizeUploadFilename(image.filename),
				sanitizeUploadFilename(image.name),
			) ||
			imageFilenameFromMime(
				image.mime || "image/png",
				state.candidates.length + 1,
			);
		const source = { type: "base64" as const, data: b64 };
		const mime = firstNonEmptyString(image.mime, "image/png");
		addCandidate(state, "image", source, {
			filename: name,
			mime,
		});
	}
}

function appendFileInputs(state: PlanState, raw: unknown): void {
	if (!Array.isArray(raw)) return;
	for (const item of raw) {
		const input = isNormalizedUploadFileInput(item)
			? item
			: normalizeUploadFileInput(item);
		if (!input) continue;
		appendUploadFileInput(state, input);
	}
}

function appendUploadFileInput(state: PlanState, input: UploadFileInput): void {
	const nameHint = firstNonEmptyString(
		sanitizeUploadFilename(input.filename),
		sanitizeUploadFilename(input.name),
	);
	const mime = firstNonEmptyString(input.mime, mimeFromFilename(nameHint));
	if (input.invalidReason) {
		state.dropped.push(
			attachmentDrop(
				"file",
				"invalid_file_input",
				String(input.invalidReason || "invalid file input"),
				nameHint,
			),
		);
		return;
	}
	if (input.b64 != null) {
		const meta: { filename?: string; mime?: string } = {};
		if (nameHint) meta.filename = nameHint;
		else if (mime)
			meta.filename = genericFilenameFromMime(
				mime,
				state.candidates.length + 1,
			);
		if (mime) meta.mime = mime;
		addCandidate(
			state,
			"file",
			{ type: "base64", data: input.b64 },
			{
				...meta,
			},
		);
	}
}

function addCandidate(
	state: PlanState,
	kind: AttachmentKind,
	source: AttachmentCandidate["source"],
	meta: { filename?: string; mime?: string } = {},
): void {
	if (state.candidates.length >= state.maxFiles) {
		state.dropped.push(
			attachmentDrop(
				kind,
				"too_many_files",
				`exceeded maximum of ${state.maxFiles} attachments per request`,
				meta.filename,
			),
		);
		return;
	}
	const candidate: AttachmentCandidate = {
		id: `att_${state.nextID++}`,
		kind,
		role: "request",
		source,
	};
	const filename = sanitizeUploadFilename(meta.filename);
	if (filename) candidate.filename = filename;
	const mime = firstNonEmptyString(meta.mime);
	if (mime) candidate.mime = mime;
	state.candidates.push(candidate);
}

function finishPlan(state: PlanState): AttachmentPlan {
	return {
		candidates: state.candidates,
		existingFileRefs: state.existingFileRefs.length
			? state.existingFileRefs
			: null,
		dropped: state.dropped,
		maxFiles: state.maxFiles,
	};
}

function normalizeMaxFiles(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) return MAX_ATTACHMENTS_PER_REQUEST;
	return Math.max(1, Math.floor(n));
}

function isNormalizedUploadFileInput(value: unknown): value is UploadFileInput {
	if (!isRecord(value)) return false;
	return "invalidReason" in value || "b64" in value;
}
