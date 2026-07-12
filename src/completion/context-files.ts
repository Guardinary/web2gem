import { currentInputFilePrompt } from "../toolcall/content";
import { toolsContextTranscriptFor } from "../toolcall/tool-bundle";
import { elapsedMs, log, logStage, nowMs } from "../shared/logging";
import { errorLogSummary } from "../shared/errors";
import {
	buildTextWithTokens,
	promptByteLength,
	promptByteLengthBounded,
	promptByteLengthGreaterThan,
} from "../shared/tokens";
import type { PromptByteLengthBounded } from "../shared/tokens";
import type { ErrorWithMetadata } from "../shared/types";
import { geminiAuthenticatedSessionRequiredError } from "../shared/errors";
import type {
	ContextFileFailure,
	ContextFileResult,
	FileRef,
	ToolDef,
} from "./types";

type ContextFileConfig = {
	current_input_file_enabled?: unknown;
	current_input_file_min_bytes?: unknown;
	current_input_file_name?: unknown;
	current_tools_file_name?: unknown;
	supports_authenticated_session?: unknown;
	log_requests?: unknown;
};
export type TextFileUploader = (
	text: string,
	filename: string,
) => Promise<FileRef>;
export type ContextFilePromptByteCheck = PromptByteLengthBounded & {
	thresholdBytes: number;
};

export function buildToolsContextTranscript(
	toolDefs: readonly ToolDef[] | null | undefined,
	choiceInstruction: unknown,
	filename: unknown = "tools.txt",
): string {
	return toolsContextTranscriptFor(toolDefs, choiceInstruction, filename);
}

export function contextFileThreshold(cfg: ContextFileConfig): number {
	return Math.max(0, Number(cfg.current_input_file_min_bytes) || 95000);
}

export function contextFilePromptByteCheck(
	cfg: ContextFileConfig,
	promptText: unknown,
): ContextFilePromptByteCheck {
	const thresholdBytes = contextFileThreshold(cfg);
	return {
		...promptByteLengthBounded(promptText || "", thresholdBytes),
		thresholdBytes,
	};
}

export function contextFileConfigUnavailableReason(
	cfg: ContextFileConfig,
): string {
	if (!cfg.current_input_file_enabled)
		return "CURRENT_INPUT_FILE_ENABLED is disabled";
	if (!cfg.supports_authenticated_session)
		return "Gemini account pool is not configured";
	return "";
}

export function contextFileUploadUnavailableReason(
	cfg: ContextFileConfig,
	uploader?: TextFileUploader | null,
): string {
	return (
		contextFileConfigUnavailableReason(cfg) ||
		(uploader ? "" : "text file uploader is not configured")
	);
}

export function shouldConsiderContextFiles(
	cfg: ContextFileConfig,
	promptText: unknown,
	promptByteCheck?: ContextFilePromptByteCheck,
): boolean {
	if (contextFileConfigUnavailableReason(cfg)) return false;
	return (promptByteCheck || contextFilePromptByteCheck(cfg, promptText))
		.exceeded;
}

export function shouldUseContextFiles(
	cfg: ContextFileConfig,
	historyText: unknown,
	latestInputText: unknown,
	promptText: unknown,
	promptByteCheck?: ContextFilePromptByteCheck,
): boolean {
	if (
		!shouldConsiderContextFiles(cfg, promptText || historyText, promptByteCheck)
	)
		return false;
	const latest = String(latestInputText || "").trim();
	if (!latest) return false;
	if (!String(historyText || "").trim()) return false;
	return true;
}

export function oversizedInlineContextFailure(
	cfg: ContextFileConfig,
	promptText: unknown,
	promptByteCheck?: ContextFilePromptByteCheck,
	reason?: unknown,
): ErrorWithMetadata {
	const check = promptByteCheck || contextFilePromptByteCheck(cfg, promptText);
	if (cfg.current_input_file_enabled && !cfg.supports_authenticated_session) {
		const error = geminiAuthenticatedSessionRequiredError(
			"large_context",
			`This request requires an authenticated Gemini session because the rendered context exceeds the inline limit (${formatPromptByteComparison(check)})`,
		);
		error.promptBytes = check.bytes;
		error.promptBytesExact = check.exact;
		error.thresholdBytes = check.thresholdBytes;
		return error;
	}
	const unavailable = String(
		reason ||
			contextFileConfigUnavailableReason(cfg) ||
			"context-file attachments are unavailable",
	);
	const err: ErrorWithMetadata = new Error(
		`context is too long to send inline (${formatPromptByteComparison(check)}) and ${unavailable}; configure the Gemini account pool with CURRENT_INPUT_FILE_ENABLED=true so this worker can use text attachments, or reduce the request size`,
	);
	err.code = "large_context_inline_unsupported";
	err.status = 422;
	err.promptBytes = check.bytes;
	err.promptBytesExact = check.exact;
	err.thresholdBytes = check.thresholdBytes;
	return err;
}

export function contextFileUploadFailure(
	kind: unknown,
	promptText: unknown,
	cause: unknown,
	promptByteCheck?: ContextFilePromptByteCheck,
): ErrorWithMetadata {
	const check = promptByteCheck || null;
	const err: ErrorWithMetadata = new Error(
		`failed to upload ${kind || "context"} text file for large prompt; refusing to fall back to oversized inline context`,
	);
	err.code = "large_context_file_upload_failed";
	err.promptBytes = check ? check.bytes : promptByteLength(promptText || "");
	err.promptBytesExact = check ? check.exact : true;
	if (check) err.thresholdBytes = check.thresholdBytes;
	err.cause = cause;
	return err;
}

export function latestInputInlineLimit(cfg: ContextFileConfig): number {
	return Math.max(
		4000,
		Math.min(16000, Math.floor(contextFileThreshold(cfg) / 6)),
	);
}

export function latestInputPromptForContextFile(
	cfg: ContextFileConfig,
	latestInputText: unknown,
): string {
	const latest = String(latestInputText || "").trim();
	if (!latest) return "";
	if (!promptByteLengthGreaterThan(latest, latestInputInlineLimit(cfg)))
		return `Latest user request:\n${latest}`;
	const historyName =
		String(cfg?.current_input_file_name || "message.txt").trim() ||
		"message.txt";
	return [
		`The latest user request is at the end of \`${historyName}\`; do not duplicate it inline.`,
		"Read it from the txt file and answer directly.",
	].join("\n");
}

export async function prepareContextFiles(
	cfg: ContextFileConfig,
	historyText: string,
	toolDefs: readonly ToolDef[] | null | undefined,
	choiceInstruction: unknown,
	latestInputText: unknown,
	promptText: unknown,
	uploader?: TextFileUploader,
	promptByteCheck?: ContextFilePromptByteCheck,
	toolPromptSource?: unknown,
): Promise<ContextFileResult | ContextFileFailure | null> {
	if (!uploader) {
		if (
			!shouldUseContextFiles(
				cfg,
				historyText,
				latestInputText,
				promptText,
				promptByteCheck,
			)
		)
			return null;
		return {
			error: contextFileUploadFailure(
				"context",
				promptText,
				new Error("text file uploader is not configured"),
				promptByteCheck,
			),
		};
	}
	return prepareContextFilesWithUploader(
		cfg,
		historyText,
		toolDefs,
		choiceInstruction,
		latestInputText,
		promptText,
		uploader,
		promptByteCheck,
		toolPromptSource,
	);
}

export async function prepareContextFilesWithUploader(
	cfg: ContextFileConfig,
	historyText: string,
	toolDefs: readonly ToolDef[] | null | undefined,
	choiceInstruction: unknown,
	latestInputText: unknown,
	promptText: unknown,
	uploader: TextFileUploader,
	promptByteCheck?: ContextFilePromptByteCheck,
	toolPromptSource?: unknown,
): Promise<ContextFileResult | ContextFileFailure | null> {
	if (
		!shouldUseContextFiles(
			cfg,
			historyText,
			latestInputText,
			promptText,
			promptByteCheck,
		)
	)
		return null;
	const refs: FileRef[] = [];
	const toolSource = toolPromptSource || toolDefs;
	const toolsText = toolsContextTranscriptFor(
		toolSource,
		choiceInstruction,
		cfg.current_tools_file_name || "tools.txt",
		toolDefs || [],
	);
	let toolsAttached = false;
	const uploadJobs = [
		uploader(historyText, String(cfg.current_input_file_name || "message.txt")),
	];
	const hasToolsText = !!toolsText.trim();
	if (hasToolsText)
		uploadJobs.push(
			uploader(toolsText, String(cfg.current_tools_file_name || "tools.txt")),
		);
	const logRequests = !!cfg.log_requests;
	const uploadStart = logRequests ? nowMs() : 0;
	const uploadResults = await Promise.allSettled(uploadJobs);
	const historyUpload = uploadResults[0];
	if (historyUpload && historyUpload.status === "fulfilled") {
		refs.push(historyUpload.value);
	} else {
		const e = historyUpload?.reason || "missing history upload result";
		log(
			cfg,
			`history context file upload failed for large prompt ${errorLogSummary(e)}`,
		);
		return {
			error: contextFileUploadFailure(
				"history context",
				promptText,
				e,
				promptByteCheck,
			),
		};
	}
	if (hasToolsText) {
		const toolsUpload = uploadResults[1];
		if (toolsUpload && toolsUpload.status === "fulfilled") {
			refs.push(toolsUpload.value);
			toolsAttached = true;
		} else if (toolsUpload) {
			const e = toolsUpload.reason;
			log(
				cfg,
				`tools context file upload failed for large prompt ${errorLogSummary(e)}`,
			);
			return {
				error: contextFileUploadFailure(
					"tools context",
					promptText,
					e,
					promptByteCheck,
				),
			};
		}
	}
	const livePrompt = [
		currentInputFilePrompt(cfg, toolsAttached),
		latestInputPromptForContextFile(cfg, latestInputText),
		toolsText.trim() && !toolsAttached ? toolsText : "",
	]
		.filter((s: unknown) => String(s || "").trim())
		.join("\n\n");
	const promptTokenParts = promptTokenTextParts(
		historyText,
		toolsText,
		livePrompt,
	);
	const promptTokenPrepared = buildTextWithTokens(promptTokenParts, false);
	if (logRequests) {
		const threshold = contextFileThreshold(cfg);
		logStage(cfg, "context_file_upload", {
			ms: elapsedMs(uploadStart),
			refs: refs.length,
			toolsAttached,
			historyBytes: formatByteLengthCheck(
				promptByteLengthBounded(historyText, threshold),
			),
			toolsBytes: formatByteLengthCheck(
				promptByteLengthBounded(toolsText, threshold),
			),
			latestBytes: formatByteLengthCheck(
				promptByteLengthBounded(latestInputText, latestInputInlineLimit(cfg)),
			),
			livePromptBytes: formatByteLengthCheck(
				promptByteLengthBounded(livePrompt, threshold),
			),
		});
	}
	const result: ContextFileResult = {
		fileRefs: refs,
		prompt: livePrompt,
		promptTokenCounts: promptTokenPrepared.counts,
		promptTokenText: "",
	};
	Object.defineProperty(result, "promptTokenText", {
		enumerable: false,
		get() {
			return promptTokenParts.join("");
		},
	});
	return result;
}

function formatByteLengthCheck(check: PromptByteLengthBounded): string {
	return check.exact ? String(check.bytes) : `>${check.maxBytes}`;
}

function formatPromptByteComparison(check: ContextFilePromptByteCheck): string {
	const prefix = check.exact ? "" : "at least ";
	return `${prefix}${check.bytes} UTF-8 bytes > ${check.thresholdBytes}`;
}

function promptTokenTextParts(...texts: string[]): string[] {
	const parts: string[] = [];
	for (const text of texts) {
		if (!text) continue;
		if (parts.length) parts.push("\n");
		parts.push(text);
	}
	return parts;
}
