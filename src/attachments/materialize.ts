import type { ErrorWithMetadata } from "../shared/types";
import { base64DecodedByteLength, base64ToBytes } from "./base64";
import {
	chooseUploadMime,
	detectUploadMimeFromBytes,
	firstNonEmptyString,
	genericFilenameFromMime,
	imageFilenameFromMime,
	mimeFromFilename,
} from "./mime";
import type { AttachmentCandidate, AttachmentDropReason } from "./types";

export type AttachmentLimits = {
	maxFileBytes: number;
	maxImageBytes: number;
};

export type MaterializedAttachment = {
	candidate: AttachmentCandidate;
	bytes: Uint8Array;
	mime: string;
	filename: string;
};

export const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export async function materializeAttachment(
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
): Promise<MaterializedAttachment> {
	const maxBytes = maxBytesForCandidate(candidate, limits);
	if (candidate.source.type === "bytes") {
		ensureWithinLimit(candidate, candidate.source.bytes.byteLength, maxBytes);
		const mime = mimeForCandidate(candidate, candidate.source.bytes);
		return {
			candidate,
			bytes: candidate.source.bytes,
			mime,
			filename: filenameForCandidate(candidate, mime),
		};
	}
	const compact = String(candidate.source.data || "").replace(/\s+/g, "");
	ensureWithinLimit(candidate, base64DecodedByteLength(compact), maxBytes);
	try {
		const bytes = base64ToBytes(compact);
		ensureWithinLimit(candidate, bytes.byteLength, maxBytes);
		const mime = mimeForCandidate(candidate, bytes);
		return {
			candidate,
			bytes,
			mime,
			filename: filenameForCandidate(candidate, mime),
		};
	} catch (e) {
		throw attachmentMaterializeFailure(
			candidate,
			"invalid_base64",
			"invalid base64 payload",
			400,
			e,
		);
	}
}

export function joinByteChunks(
	chunks: readonly Uint8Array[],
	total: number,
): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export function attachmentMaterializeFailure(
	candidate: AttachmentCandidate,
	code: AttachmentDropReason,
	message: string,
	status: number,
	cause?: unknown,
): ErrorWithMetadata {
	const err: ErrorWithMetadata = new Error(message);
	err.code = code;
	err.status = status;
	(err as ErrorWithMetadata & { attachmentKind?: string }).attachmentKind =
		candidate.kind;
	if (cause !== undefined) err.cause = cause;
	return err;
}

function maxBytesForCandidate(
	candidate: AttachmentCandidate,
	limits: AttachmentLimits,
): number {
	if (candidate.kind === "image") return Math.max(0, limits.maxImageBytes);
	return Math.max(0, limits.maxFileBytes);
}

function ensureWithinLimit(
	candidate: AttachmentCandidate,
	bytes: number,
	maxBytes: number,
): void {
	if (bytes > maxBytes) {
		throw attachmentMaterializeFailure(
			candidate,
			candidate.kind === "image" ? "image_too_large" : "file_too_large",
			`${candidate.kind} attachment is too large (${bytes} bytes > ${maxBytes} bytes)`,
			413,
		);
	}
}

function mimeForCandidate(
	candidate: AttachmentCandidate,
	bytes: Uint8Array,
): string {
	return chooseUploadMime(
		candidate.mime,
		mimeFromFilename(candidate.filename),
		detectUploadMimeFromBytes(bytes),
	);
}

function filenameForCandidate(
	candidate: AttachmentCandidate,
	mimeHint: unknown,
): string {
	const explicit = firstNonEmptyString(candidate.filename);
	if (explicit) return explicit;
	if (candidate.kind === "image")
		return imageFilenameFromMime(candidate.mime || mimeHint || "image/png", 1);
	return genericFilenameFromMime(
		candidate.mime || mimeHint || "application/octet-stream",
		1,
	);
}
