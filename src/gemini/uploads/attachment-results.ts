import type { MaterializedAttachment } from "../../attachments/materialize";
import { attachmentDrop, droppedAttachmentNote } from "../../attachments/notes";
import type {
	AttachmentCandidate,
	AttachmentDrop,
	AttachmentFileRef,
	AttachmentPlan,
	AttachmentUploadResult,
} from "../../attachments/types";
import type { RuntimeConfig } from "../../config";
import { errorLogSummary } from "../../shared/errors";
import { log, logStage } from "../../shared/logging";
import { firstNonEmptyString } from "../../shared/strings";
import type { AttachmentExecutionState } from "./attachment-execution-state";

export type AttachmentCandidateResult = {
	candidate: AttachmentCandidate;
	fileRef: AttachmentFileRef | null;
	promptText: string;
	drop: AttachmentDrop | null;
	bytesLength: number;
	failureSummary?: string;
};

export function aggregateAttachmentResults(
	cfg: RuntimeConfig,
	plan: AttachmentPlan,
	results: readonly AttachmentCandidateResult[],
	state: AttachmentExecutionState,
	supportsFileRefs: boolean,
): AttachmentUploadResult {
	const fileRefs: AttachmentFileRef[] = [];
	const imageFileRefs: AttachmentFileRef[] = [];
	const genericFileRefs: AttachmentFileRef[] = [];
	const promptParts: string[] = [];
	const drops = [...plan.dropped];
	let fileRefBytes = 0;

	for (const result of results) {
		if (result.drop) {
			drops.push(result.drop);
			log(
				cfg,
				`attachment upload dropped kind=${result.candidate.kind} bytes=${result.bytesLength || "unknown"} ${result.failureSummary || errorLogSummary(result.drop.message)}`,
			);
			continue;
		}
		if (result.promptText) promptParts.push(result.promptText);
		if (!result.fileRef) continue;
		fileRefBytes += result.bytesLength;
		fileRefs.push(result.fileRef);
		if (result.candidate.kind === "image") imageFileRefs.push(result.fileRef);
		else genericFileRefs.push(result.fileRef);
	}

	const usage = state.usage(fileRefBytes, drops.length);
	if (cfg.log_requests) {
		logStage(cfg, "attachment_upload", {
			candidates: plan.candidates.length,
			existingRefs: plan.existingFileRefs ? plan.existingFileRefs.length : 0,
			uploadedFiles: usage.uploadedFiles,
			dedupedFiles: usage.dedupedFiles,
			uploadedBytes: usage.uploadedBytes,
			fileRefBytes: usage.fileRefBytes,
			inlinedFiles: usage.inlinedFiles,
			inlinedBytes: usage.inlinedBytes,
			droppedFiles: usage.droppedFiles,
			multipartUploads: usage.multipartUploads,
			supportsFileRefs,
		});
	}

	return {
		fileRefs: fileRefs.length ? fileRefs : null,
		imageFileRefs: imageFileRefs.length ? imageFileRefs : null,
		genericFileRefs: genericFileRefs.length ? genericFileRefs : null,
		promptText: promptParts.join(""),
		droppedNote: droppedAttachmentNote(drops),
		supportsFileRefs,
		usage,
	};
}

export function attachmentCandidateDrop(
	candidate: AttachmentCandidate,
	message: string,
	bytesLength: number,
	filename: unknown = candidate.filename,
): AttachmentCandidateResult {
	return {
		candidate,
		fileRef: null,
		promptText: "",
		drop: attachmentDrop(candidate.kind, "upload_failed", message, filename),
		bytesLength,
		failureSummary: errorLogSummary(message),
	};
}

export function attachmentCandidateFailure(
	candidate: AttachmentCandidate,
	error: unknown,
	materialized: MaterializedAttachment | null,
): AttachmentCandidateResult {
	const code = dropCodeFromError(candidate, error);
	return {
		candidate,
		fileRef: null,
		promptText: "",
		drop: attachmentDrop(
			candidate.kind,
			code,
			dropMessageFromError(code, error),
			candidate.filename,
		),
		bytesLength: materialized ? materialized.bytes.byteLength : 0,
		failureSummary: errorLogSummary(error),
	};
}

function dropCodeFromError(
	candidate: AttachmentCandidate,
	error: unknown,
): AttachmentDrop["code"] {
	const code =
		error && typeof error === "object"
			? String((error as { code?: unknown }).code || "")
			: "";
	switch (code) {
		case "invalid_base64":
		case "invalid_remote_url":
		case "file_too_large":
		case "image_too_large":
			return code;
		default:
			return candidate.kind === "image" && code === "invalid_image_input"
				? "invalid_image_input"
				: "upload_failed";
	}
}

function dropMessageFromError(
	code: AttachmentDrop["code"],
	error: unknown,
): string {
	const message =
		error && typeof error === "object" && "message" in error
			? firstNonEmptyString((error as { message?: unknown }).message)
			: "";
	switch (code) {
		case "invalid_base64":
			return "invalid base64 payload";
		case "invalid_remote_url":
			return "invalid remote URL";
		case "file_too_large":
			return message || "file attachment is too large";
		case "image_too_large":
			return message || "image attachment is too large";
		case "invalid_image_input":
			return "invalid image input";
		case "invalid_file_input":
			return "invalid file input";
		case "too_many_files":
			return "too many attachments";
		case "upload_failed":
			return "attachment upload failed";
	}
}
