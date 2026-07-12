import {
	type AttachmentLimits,
	DEFAULT_ATTACHMENT_MAX_BYTES,
	type MaterializedAttachment,
	materializeAttachment,
} from "../../attachments/materialize";
import {
	chooseUploadMime,
	firstNonEmptyString,
	genericFilenameFromMime,
	imageFilenameFromMime,
	normalizeMimeType,
} from "../../attachments/mime";
import { attachmentDrop, droppedAttachmentNote } from "../../attachments/notes";
import { createAttachmentPlan } from "../../attachments/plan";
import type {
	AttachmentCandidate,
	AttachmentDrop,
	AttachmentFileRef,
	AttachmentPlan,
	AttachmentUploadResult,
	AttachmentUsage,
} from "../../attachments/types";
import type { RuntimeConfig } from "../../config";
import { bytesToHex } from "../../shared/crypto";
import { TEXT_ENCODER, UTF8_FATAL_DECODER } from "../../shared/encoding";
import { errorLogSummary } from "../../shared/errors";
import { log, logStage } from "../../shared/logging";
import { mapWithConcurrencyAndWeight } from "../concurrency";
import { configWithFreshGeminiCookie } from "../cookies";
import { type UploadBytesInput, uploadMultipartFile } from "./multipart";

const MAX_PARALLEL_UPLOADS = 4;
const MAX_IN_FLIGHT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

type UploadOneResult = {
	candidate: AttachmentCandidate;
	fileRef: AttachmentFileRef | null;
	promptText: string;
	drop: AttachmentDrop | null;
	bytesLength: number;
	deduped: boolean;
};

type UploadState = {
	uploadedByKey: Map<string, AttachmentFileRef>;
	pendingByKey: Map<string, Promise<UploadedAttachmentRef>>;
	inlinedByKey: Map<string, string>;
	uploadedFiles: number;
	dedupedFiles: number;
	uploadedBytes: number;
	inlinedFiles: number;
	inlinedBytes: number;
	multipartUploads: number;
};

type UploadProtocol = "multipart";

type UploadBytesResult = {
	ref: string;
	protocol: UploadProtocol;
};

type UploadedAttachmentRef = {
	fileRef: AttachmentFileRef;
	protocol: UploadProtocol;
};

export async function resolveAttachments(
	cfg: RuntimeConfig,
	plan: AttachmentPlan,
): Promise<AttachmentUploadResult> {
	const activeCfg = await configWithFreshGeminiCookie(cfg);
	const supportsFileRefs = !!activeCfg.cookie;
	const state: UploadState = {
		uploadedByKey: new Map(),
		pendingByKey: new Map(),
		inlinedByKey: new Map(),
		uploadedFiles: 0,
		dedupedFiles: 0,
		uploadedBytes: 0,
		inlinedFiles: 0,
		inlinedBytes: 0,
		multipartUploads: 0,
	};
	const limits = attachmentLimitsFromConfig(activeCfg);
	const uploadResults = await mapWithConcurrencyAndWeight(
		plan.candidates,
		MAX_PARALLEL_UPLOADS,
		MAX_IN_FLIGHT_ATTACHMENT_BYTES,
		estimatedMaterializedBytes,
		(candidate) =>
			resolveOneRequestAttachment(
				activeCfg,
				candidate,
				limits,
				state,
				supportsFileRefs,
			),
	);
	const fileRefs: AttachmentFileRef[] = [];
	const imageFileRefs: AttachmentFileRef[] = [];
	const genericFileRefs: AttachmentFileRef[] = [];
	const promptParts: string[] = [];
	const drops = [...plan.dropped];
	let fileRefBytes = 0;
	for (const result of uploadResults) {
		if (result.drop) {
			drops.push(result.drop);
			log(
				activeCfg,
				`attachment upload dropped kind=${result.candidate.kind} bytes=${result.bytesLength || "unknown"} ${errorLogSummary(result.drop.message)}`,
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
	const usage: AttachmentUsage = {
		uploadedFiles: state.uploadedFiles,
		dedupedFiles: state.dedupedFiles,
		uploadedBytes: state.uploadedBytes,
		fileRefBytes,
		inlinedFiles: state.inlinedFiles,
		inlinedBytes: state.inlinedBytes,
		droppedFiles: drops.length,
		multipartUploads: state.multipartUploads,
	};
	if (activeCfg.log_requests) {
		logStage(activeCfg, "attachment_upload", {
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

export async function uploadTextFile(
	cfg: RuntimeConfig,
	text: unknown,
	filename: unknown,
): Promise<AttachmentFileRef> {
	const activeCfg = await configWithFreshGeminiCookie(cfg);
	const name = String(filename || "context.txt").trim() || "context.txt";
	const bytes = TEXT_ENCODER.encode(String(text || ""));
	const { ref } = await uploadBytesWithFallbackResult(activeCfg, {
		bytes,
		mime: "text/plain; charset=utf-8",
		filename: name,
	});
	return { ref, name };
}

export async function uploadImage(
	cfg: RuntimeConfig,
	bytes: Uint8Array,
	mime: string,
): Promise<string> {
	const activeCfg = await configWithFreshGeminiCookie(cfg);
	const result = await uploadBytesWithFallbackResult(activeCfg, {
		bytes,
		mime: chooseUploadMime(mime, "image/png"),
		filename: imageFilenameFromMime(mime, 1),
	});
	return result.ref;
}

export async function uploadFile(
	cfg: RuntimeConfig,
	bytes: Uint8Array,
	mime: string,
): Promise<string> {
	const activeCfg = await configWithFreshGeminiCookie(cfg);
	const result = await uploadBytesWithFallbackResult(activeCfg, {
		bytes,
		mime: chooseUploadMime(mime),
		filename: genericFilenameFromMime(mime, 1),
	});
	return result.ref;
}

export async function resolveImages(
	cfg: RuntimeConfig,
	images: unknown,
): Promise<AttachmentUploadResult> {
	return resolveAttachments(cfg, createAttachmentPlan({ images }));
}

export async function resolveFiles(
	cfg: RuntimeConfig,
	files: unknown,
): Promise<AttachmentUploadResult> {
	return resolveAttachments(cfg, createAttachmentPlan({ files }));
}

export async function uploadBytesWithFallback(
	cfg: RuntimeConfig,
	input: UploadBytesInput,
): Promise<string> {
	const result = await uploadBytesWithFallbackResult(cfg, input);
	return result.ref;
}

async function uploadBytesWithFallbackResult(
	cfg: RuntimeConfig,
	input: UploadBytesInput,
): Promise<UploadBytesResult> {
	try {
		return {
			ref: await uploadMultipartFile(cfg, input),
			protocol: "multipart",
		};
	} catch (e) {
		log(cfg, `multipart upload failed ${errorLogSummary(e)}`);
		throw e;
	}
}

function attachmentLimitsFromConfig(cfg: RuntimeConfig): AttachmentLimits {
	const n = Number(cfg.generic_file_upload_max_bytes);
	const maxBytes = Number.isFinite(n)
		? Math.max(0, Math.floor(n))
		: DEFAULT_ATTACHMENT_MAX_BYTES;
	return {
		maxFileBytes: maxBytes,
		maxImageBytes: maxBytes,
	};
}

async function resolveOneRequestAttachment(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: UploadState,
	supportsFileRefs: boolean,
): Promise<UploadOneResult> {
	if (!supportsFileRefs)
		return inlineOrDropAnonymousAttachment(cfg, candidate, limits, state);
	return uploadOneRequestAttachment(cfg, candidate, limits, state);
}

async function uploadOneRequestAttachment(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: UploadState,
): Promise<UploadOneResult> {
	let materialized: MaterializedAttachment | null = null;
	try {
		materialized = await materializeAttachment(candidate, limits);
		const key = await dedupeKey(materialized);
		const existing = state.uploadedByKey.get(key);
		if (existing) {
			state.dedupedFiles += 1;
			return {
				candidate,
				fileRef: existing,
				promptText: "",
				drop: null,
				bytesLength: materialized.bytes.byteLength,
				deduped: true,
			};
		}
		const pending = state.pendingByKey.get(key);
		if (pending) {
			const { fileRef } = await pending;
			state.dedupedFiles += 1;
			return {
				candidate,
				fileRef,
				promptText: "",
				drop: null,
				bytesLength: materialized.bytes.byteLength,
				deduped: true,
			};
		}
		const uploadPromise = uploadMaterializedAttachment(cfg, materialized);
		state.pendingByKey.set(key, uploadPromise);
		const uploaded = await uploadPromise.finally(() => {
			state.pendingByKey.delete(key);
		});
		const fileRef = uploaded.fileRef;
		state.uploadedByKey.set(key, fileRef);
		state.uploadedFiles += 1;
		state.uploadedBytes += materialized.bytes.byteLength;
		state.multipartUploads += 1;
		return {
			candidate,
			fileRef,
			promptText: "",
			drop: null,
			bytesLength: materialized.bytes.byteLength,
			deduped: false,
		};
	} catch (e) {
		const code = dropCodeFromError(candidate, e);
		const message = dropMessageFromError(code, e);
		return {
			candidate,
			fileRef: null,
			promptText: "",
			drop: attachmentDrop(candidate.kind, code, message, candidate.filename),
			bytesLength: materialized ? materialized.bytes.byteLength : 0,
			deduped: false,
		};
	}
}

async function inlineOrDropAnonymousAttachment(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
	state: UploadState,
): Promise<UploadOneResult> {
	let materialized: MaterializedAttachment | null = null;
	try {
		materialized = await materializeAttachment(candidate, limits);
		if (candidate.kind !== "file") {
			return droppedAnonymousAttachment(
				cfg,
				candidate,
				materialized,
				"image input requires a configured Gemini account pool",
			);
		}
		const inlineText = anonymousInlineTextFor(materialized);
		if (inlineText == null) {
			return droppedAnonymousAttachment(
				cfg,
				candidate,
				materialized,
				"file attachment requires a configured Gemini account pool",
			);
		}
		const key = await dedupeKey(materialized);
		const existingInlineText = state.inlinedByKey.get(key);
		if (existingInlineText != null) {
			state.dedupedFiles += 1;
			return {
				candidate,
				fileRef: null,
				promptText: "",
				drop: null,
				bytesLength: materialized.bytes.byteLength,
				deduped: true,
			};
		}
		const promptText = formatInlineAttachmentText(
			materialized.filename,
			inlineText,
		);
		state.inlinedByKey.set(key, promptText);
		state.inlinedFiles += 1;
		state.inlinedBytes += materialized.bytes.byteLength;
		return {
			candidate,
			fileRef: null,
			promptText,
			drop: null,
			bytesLength: materialized.bytes.byteLength,
			deduped: false,
		};
	} catch (e) {
		const code = dropCodeFromError(candidate, e);
		const message = dropMessageFromError(code, e);
		return {
			candidate,
			fileRef: null,
			promptText: "",
			drop: attachmentDrop(candidate.kind, code, message, candidate.filename),
			bytesLength: materialized ? materialized.bytes.byteLength : 0,
			deduped: false,
		};
	}
}

function droppedAnonymousAttachment(
	cfg: RuntimeConfig,
	candidate: AttachmentCandidate,
	materialized: MaterializedAttachment,
	message: string,
): UploadOneResult {
	log(
		cfg,
		`attachment upload skipped kind=${candidate.kind} bytes=${materialized.bytes.byteLength} reason=anonymous_file_refs_unavailable`,
	);
	return {
		candidate,
		fileRef: null,
		promptText: "",
		drop: attachmentDrop(
			candidate.kind,
			"upload_failed",
			message,
			materialized.filename,
		),
		bytesLength: materialized.bytes.byteLength,
		deduped: false,
	};
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

async function uploadMaterializedAttachment(
	cfg: RuntimeConfig,
	materialized: MaterializedAttachment,
): Promise<UploadedAttachmentRef> {
	const result = await uploadBytesWithFallbackResult(cfg, {
		bytes: materialized.bytes,
		mime: materialized.mime,
		filename: materialized.filename,
	});
	return {
		fileRef: { ref: result.ref, name: materialized.filename },
		protocol: result.protocol,
	};
}

async function dedupeKey(
	materialized: MaterializedAttachment,
): Promise<string> {
	const digestInput =
		materialized.bytes.buffer instanceof ArrayBuffer
			? (materialized.bytes as Uint8Array<ArrayBuffer>)
			: new Uint8Array(materialized.bytes);
	const digest = await crypto.subtle.digest("SHA-256", digestInput);
	return `${materialized.mime}\x00${materialized.filename}\x00${bytesToHex(new Uint8Array(digest))}`;
}

export const attachmentDedupeKeyForTest = dedupeKey;

function estimatedMaterializedBytes(candidate: AttachmentCandidate): number {
	if (candidate.source.type === "bytes")
		return candidate.source.bytes.byteLength;
	return Math.floor((String(candidate.source.data || "").length * 3) / 4);
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
