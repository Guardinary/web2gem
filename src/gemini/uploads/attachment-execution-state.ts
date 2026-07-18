import {
	type AttachmentLimits,
	DEFAULT_ATTACHMENT_MAX_BYTES,
	type MaterializedAttachment,
} from "../../attachments/materialize";
import type {
	AttachmentCandidate,
	AttachmentFileRef,
	AttachmentUsage,
} from "../../attachments/types";
import type { RuntimeConfig } from "../../config";
import { bytesToHex } from "../../shared/crypto";
import { mapWithConcurrencyAndWeight } from "../concurrency";

const MAX_PARALLEL_UPLOADS = 4;
const MAX_IN_FLIGHT_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export class AttachmentExecutionState {
	private readonly uploadedByKey = new Map<string, AttachmentFileRef>();
	private readonly pendingByKey = new Map<string, Promise<AttachmentFileRef>>();
	private readonly inlinedByKey = new Map<string, string>();
	private uploadedFiles = 0;
	private dedupedFiles = 0;
	private uploadedBytes = 0;
	private inlinedFiles = 0;
	private inlinedBytes = 0;
	private multipartUploads = 0;

	async resolveUploaded(
		key: string,
		bytesLength: number,
		upload: () => Promise<AttachmentFileRef>,
	): Promise<AttachmentFileRef> {
		const existing = this.uploadedByKey.get(key);
		if (existing) {
			this.dedupedFiles += 1;
			return existing;
		}
		const pending = this.pendingByKey.get(key);
		if (pending) {
			const fileRef = await pending;
			this.dedupedFiles += 1;
			return fileRef;
		}

		const uploadPromise = upload();
		this.pendingByKey.set(key, uploadPromise);
		try {
			const fileRef = await uploadPromise;
			this.uploadedByKey.set(key, fileRef);
			this.uploadedFiles += 1;
			this.uploadedBytes += bytesLength;
			this.multipartUploads += 1;
			return fileRef;
		} finally {
			if (this.pendingByKey.get(key) === uploadPromise)
				this.pendingByKey.delete(key);
		}
	}

	rememberInline(key: string, promptText: string, bytesLength: number): string {
		if (this.inlinedByKey.has(key)) {
			this.dedupedFiles += 1;
			return "";
		}
		this.inlinedByKey.set(key, promptText);
		this.inlinedFiles += 1;
		this.inlinedBytes += bytesLength;
		return promptText;
	}

	usage(fileRefBytes: number, droppedFiles: number): AttachmentUsage {
		return {
			uploadedFiles: this.uploadedFiles,
			dedupedFiles: this.dedupedFiles,
			uploadedBytes: this.uploadedBytes,
			fileRefBytes,
			inlinedFiles: this.inlinedFiles,
			inlinedBytes: this.inlinedBytes,
			droppedFiles,
			multipartUploads: this.multipartUploads,
		};
	}
}

export function attachmentLimitsFromConfig(
	cfg: RuntimeConfig,
): AttachmentLimits {
	const configuredMaxBytes = Number(cfg.generic_file_upload_max_bytes);
	const maxBytes = Number.isFinite(configuredMaxBytes)
		? Math.max(0, Math.floor(configuredMaxBytes))
		: DEFAULT_ATTACHMENT_MAX_BYTES;
	return { maxFileBytes: maxBytes, maxImageBytes: maxBytes };
}

export function mapAttachmentCandidates<R>(
	candidates: readonly AttachmentCandidate[],
	mapper: (candidate: AttachmentCandidate, index: number) => Promise<R>,
): Promise<R[]> {
	return mapWithConcurrencyAndWeight(
		candidates,
		MAX_PARALLEL_UPLOADS,
		MAX_IN_FLIGHT_ATTACHMENT_BYTES,
		estimatedMaterializedBytes,
		mapper,
	);
}

export async function attachmentDedupeKey(
	materialized: MaterializedAttachment,
): Promise<string> {
	const digestInput =
		materialized.bytes.buffer instanceof ArrayBuffer
			? (materialized.bytes as Uint8Array<ArrayBuffer>)
			: new Uint8Array(materialized.bytes);
	const digest = await crypto.subtle.digest("SHA-256", digestInput);
	return `${materialized.mime}\x00${materialized.filename}\x00${bytesToHex(new Uint8Array(digest))}`;
}

function estimatedMaterializedBytes(candidate: AttachmentCandidate): number {
	if (candidate.source.type === "bytes")
		return candidate.source.bytes.byteLength;
	return Math.floor((String(candidate.source.data || "").length * 3) / 4);
}
