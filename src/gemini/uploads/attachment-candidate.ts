import {
	type AttachmentLimits,
	type MaterializedAttachment,
	materializeAttachment,
} from "../../attachments/materialize";
import { normalizeMimeType } from "../../attachments/mime";
import type { AttachmentCandidate } from "../../attachments/types";
import type { RuntimeConfig } from "../../config";
import { UTF8_FATAL_DECODER } from "../../shared/encoding";
import {
	attachmentDedupeKey,
	type AttachmentExecutionState,
} from "./attachment-execution-state";
import {
	attachmentCandidateDrop,
	attachmentCandidateFailure,
	type AttachmentCandidateResult,
} from "./attachment-results";
import { uploadMultipartFile } from "./multipart";

export function resolveAttachmentCandidate(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: AttachmentExecutionState,
	supportsFileRefs: boolean,
): Promise<AttachmentCandidateResult> {
	return supportsFileRefs
		? uploadAttachmentCandidate(cfg, candidate, limits, state)
		: inlineOrDropAnonymousAttachment(candidate, limits, state);
}

async function uploadAttachmentCandidate(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: AttachmentExecutionState,
): Promise<AttachmentCandidateResult> {
	let materialized: MaterializedAttachment | null = null;
	try {
		materialized = await materializeAttachment(candidate, limits);
		const key = await attachmentDedupeKey(materialized);
		const uploadInput = {
			bytes: materialized.bytes,
			mime: materialized.mime,
			filename: materialized.filename,
		};
		const fileRef = await state.resolveUploaded(
			key,
			materialized.bytes.byteLength,
			async () => ({
				ref: await uploadMultipartFile(cfg, uploadInput),
				name: uploadInput.filename,
			}),
		);
		return {
			candidate,
			fileRef,
			promptText: "",
			drop: null,
			bytesLength: materialized.bytes.byteLength,
		};
	} catch (error) {
		return attachmentCandidateFailure(candidate, error, materialized);
	}
}

async function inlineOrDropAnonymousAttachment(
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: AttachmentExecutionState,
): Promise<AttachmentCandidateResult> {
	let materialized: MaterializedAttachment | null = null;
	try {
		materialized = await materializeAttachment(candidate, limits);
		if (candidate.kind !== "file") {
			return attachmentCandidateDrop(
				candidate,
				"image input requires a configured Gemini account pool",
				materialized.bytes.byteLength,
				materialized.filename,
			);
		}
		const inlineText = anonymousInlineTextFor(materialized);
		if (inlineText == null) {
			return attachmentCandidateDrop(
				candidate,
				"file attachment requires a configured Gemini account pool",
				materialized.bytes.byteLength,
				materialized.filename,
			);
		}
		const key = await attachmentDedupeKey(materialized);
		const promptText = state.rememberInline(
			key,
			formatInlineAttachmentText(materialized.filename, inlineText),
			materialized.bytes.byteLength,
		);
		return {
			candidate,
			fileRef: null,
			promptText,
			drop: null,
			bytesLength: materialized.bytes.byteLength,
		};
	} catch (error) {
		return attachmentCandidateFailure(candidate, error, materialized);
	}
}

function anonymousInlineTextFor(
	materialized: MaterializedAttachment,
): string | null {
	const mime = normalizeMimeType(materialized.mime);
	if (!isInlineTextMime(mime)) return null;
	try {
		return UTF8_FATAL_DECODER.decode(materialized.bytes);
	} catch (_) {
		return null;
	}
}

function isInlineTextMime(mime: string): boolean {
	return (
		mime.startsWith("text/") ||
		mime === "application/json" ||
		mime === "application/x-ndjson" ||
		mime === "application/xml"
	);
}

function formatInlineAttachmentText(filename: string, text: string): string {
	return `\n\n[File attachment: ${filename}]\n${text}\n[/File attachment]`;
}
