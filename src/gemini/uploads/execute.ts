import type {
	AttachmentFileRef,
	AttachmentPlan,
	AttachmentUploadResult,
} from "../../attachments/types";
import type { RuntimeConfig } from "../../config";
import { TEXT_ENCODER } from "../../shared/encoding";
import { errorLogSummary } from "../../shared/errors";
import { log } from "../../shared/logging";
import { configWithFreshGeminiCookie } from "../cookies";
import { resolveAttachmentCandidate } from "./attachment-candidate";
import {
	attachmentLimitsFromConfig,
	AttachmentExecutionState,
	mapAttachmentCandidates,
} from "./attachment-execution-state";
import { aggregateAttachmentResults } from "./attachment-results";
import { uploadMultipartFile } from "./multipart";

export async function resolveAttachments(
	cfg: RuntimeConfig,
	plan: AttachmentPlan,
): Promise<AttachmentUploadResult> {
	const activeConfig = await configWithFreshGeminiCookie(cfg);
	const supportsFileRefs = !!activeConfig.cookie;
	const state = new AttachmentExecutionState();
	const limits = attachmentLimitsFromConfig(activeConfig);
	const results = await mapAttachmentCandidates(plan.candidates, (candidate) =>
		resolveAttachmentCandidate(
			activeConfig,
			candidate,
			limits,
			state,
			supportsFileRefs,
		),
	);
	return aggregateAttachmentResults(
		activeConfig,
		plan,
		results,
		state,
		supportsFileRefs,
	);
}

export async function uploadTextFile(
	cfg: RuntimeConfig,
	text: unknown,
	filename: unknown,
): Promise<AttachmentFileRef> {
	const activeConfig = await configWithFreshGeminiCookie(cfg);
	const name = String(filename || "context.txt").trim() || "context.txt";
	try {
		const ref = await uploadMultipartFile(activeConfig, {
			bytes: TEXT_ENCODER.encode(String(text || "")),
			mime: "text/plain; charset=utf-8",
			filename: name,
		});
		return { ref, name };
	} catch (error) {
		log(activeConfig, `multipart upload failed ${errorLogSummary(error)}`);
		throw error;
	}
}
