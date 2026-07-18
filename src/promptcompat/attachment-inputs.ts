import {
	normalizeUploadFileInput,
	type UploadFileInput,
	uploadFilenameFromObject,
} from "../attachments/input";
import {
	createAttachmentPlan,
	mergeAttachmentPlans,
} from "../attachments/plan";
import {
	appendExistingFileRefs,
	recognizedFileRefID,
} from "../attachments/refs";
import type { AttachmentFileRef, AttachmentPlan } from "../attachments/types";
import { isRecord } from "../shared/types";
import { type InternalMessage, parseMessagePart } from "./message-model";

type MessageImageInput = { b64: string; mime: string; filename: string };
type MessageAttachmentInputs = {
	images: MessageImageInput[];
	files: UploadFileInput[];
};
type RequestAttachmentInputs = MessageAttachmentInputs & {
	existingFileRefs: AttachmentFileRef[];
};

const REFERENCE_NESTED_KEYS = [
	"attachments",
	"files",
	"items",
	"content",
	"data",
	"source",
	"file",
] as const;
const ATTACHMENT_NESTED_KEYS = [...REFERENCE_NESTED_KEYS, "image_url"] as const;

export function attachmentInputsFromMessages(
	messages: readonly InternalMessage[],
): MessageAttachmentInputs {
	const images: MessageImageInput[] = [];
	const files: UploadFileInput[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.kind === "image" && part.hasInline)
				images.push({
					b64: part.b64,
					mime: part.mime,
					filename: part.filename,
				});
			else if (part.kind === "file" && part.upload) files.push(part.upload);
		}
	}
	return { images, files };
}

export function openAIAttachmentPlanFromRequest(
	req: unknown,
	messages: readonly InternalMessage[],
): AttachmentPlan {
	const messageInputs = attachmentInputsFromMessages(messages);
	const requestInputs = requestAttachmentInputs(req, false);
	return mergeAttachmentPlans(
		createAttachmentPlan(requestInputs),
		createAttachmentPlan({
			images: messageInputs.images,
			files: messageInputs.files,
			existingFileRefs: attachmentRefsFromMessages(messages),
		}),
		createAttachmentPlan({
			existingFileRefs: requestRefsFromChannel(req, "input"),
		}),
	);
}

export function requestAttachmentPlanFromChannels(
	req: unknown,
): AttachmentPlan {
	return createAttachmentPlan(requestAttachmentInputs(req));
}

function attachmentRefsFromMessages(
	messages: readonly InternalMessage[],
): AttachmentFileRef[] {
	const refs: AttachmentFileRef[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			if (part.kind !== "image" && part.kind !== "file") continue;
			if (part.fileRef) appendExistingFileRefs(refs, part.fileRef);
		}
	}
	return refs;
}

function requestAttachmentInputs(
	req: unknown,
	includeInputRefs = true,
): RequestAttachmentInputs {
	const out: RequestAttachmentInputs = {
		images: [],
		files: [],
		existingFileRefs: [],
	};
	if (!isRecord(req)) return out;
	appendRequestRefs(out.existingFileRefs, req.ref_file_ids);
	appendRequestRefs(out.existingFileRefs, req.file_ids);
	for (const key of ["attachments", "files"] as const)
		appendRequestAttachmentInputs(out, req[key]);
	if (includeInputRefs) appendRequestRefs(out.existingFileRefs, req.input);
	return out;
}

function requestRefsFromChannel(
	req: unknown,
	key: string,
): AttachmentFileRef[] {
	const refs: AttachmentFileRef[] = [];
	if (isRecord(req)) appendRequestRefs(refs, req[key]);
	return refs;
}

function appendRequestAttachmentInputs(
	out: RequestAttachmentInputs,
	raw: unknown,
): void {
	if (raw == null) return;
	if (Array.isArray(raw))
		for (const item of raw) appendRequestAttachmentInputs(out, item);
	if (!isRecord(raw)) return;
	const part = parseMessagePart(raw);
	if (part?.kind === "image" || part?.kind === "file") {
		if (part.kind === "image" && part.hasInline)
			out.images.push({
				b64: part.b64,
				mime: part.mime,
				filename: part.filename,
			});
		else if (part.kind === "file" && part.upload) out.files.push(part.upload);
		if (part.fileRef)
			appendExistingFileRefs(out.existingFileRefs, part.fileRef);
		return;
	}
	const upload = normalizeUploadFileInput(raw);
	if (upload) {
		out.files.push(upload);
		return;
	}
	const directID = recognizedFileRefID(raw, true);
	if (directID) {
		const name = uploadFilenameFromObject(raw);
		appendExistingFileRefs(
			out.existingFileRefs,
			name ? { id: String(directID), name } : String(directID),
		);
		return;
	}
	for (const key of ATTACHMENT_NESTED_KEYS) {
		if (key in raw) appendRequestAttachmentInputs(out, raw[key]);
	}
}

function appendRequestRefs(out: AttachmentFileRef[], raw: unknown): void {
	if (raw == null) return;
	if (Array.isArray(raw)) for (const item of raw) appendRequestRefs(out, item);
	if (typeof raw === "string") appendExistingFileRefs(out, raw);
	if (!isRecord(raw)) return;
	const part = parseMessagePart(raw);
	if (part?.kind === "image" || part?.kind === "file") {
		if (part.fileRef) appendExistingFileRefs(out, part.fileRef);
		return;
	}
	const id = recognizedFileRefID(raw, true);
	if (id) appendExistingFileRefs(out, id);
	else
		for (const key of REFERENCE_NESTED_KEYS) {
			if (key in raw) appendRequestRefs(out, raw[key]);
		}
}

export function attachmentPlanFromMessages(
	messages: readonly InternalMessage[],
): AttachmentPlan {
	const { images, files } = attachmentInputsFromMessages(messages);
	return createAttachmentPlan({ images, files });
}
