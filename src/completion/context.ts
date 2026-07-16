import { droppedAttachmentNote } from "../attachments/notes";
import type { AttachmentPlan } from "../attachments/types";
import type { RuntimeConfig } from "../config";
import {
	buildOpenAIHistoryTranscript,
	latestOpenAIUserInputText,
} from "../promptcompat/history";
import type { InternalMessage } from "../promptcompat/message-model";
import {
	attachmentPlanFromMessages,
	openAIAttachmentPlanFromRequest,
} from "../promptcompat/message-model";
import type { PromptToolContext } from "../promptcompat/messages";
import { messagesToPrompt } from "../promptcompat/messages";
import {
	appendStructuredOutputInstructionToPrepared,
	appendTextToPreparedWithTokens,
	structuredInstruction,
	withGeminiNativeHiddenToolsPromptForPrepared,
	withGeminiNativeHiddenToolsPromptWithTokens,
} from "../promptcompat/prompt-build";
import { logStage } from "../shared/logging";
import {
	buildTextWithTokens,
	createPromptByteLengthSniffer,
	type PromptByteLengthBounded,
} from "../shared/tokens";
import { isRecord } from "../shared/types";
import type { ToolChoicePolicy } from "../toolcall/policy-openai";
import { buildToolChoiceInstructionFromPolicy } from "../toolcall/policy-openai";
import type { ToolBundle } from "../toolcall/tool-bundle";
import type { ContextFilePromptByteCheck } from "./context-files";
import {
	contextFilePromptByteCheck,
	contextFileThreshold,
	contextFileUploadUnavailableReason,
	oversizedInlineContextFailure,
	prepareContextFiles,
	shouldConsiderContextFiles,
} from "./context-files";
import type { CompletionProvider } from "./ports";
import type {
	AttachmentResolutionResult,
	ContextFileFailure,
	ContextFileResult,
	FileRef,
	GeminiContextPrepareResult,
	LooseRequest,
	PromptMetadata,
	PromptWithTokens,
	ToolDef,
} from "./types";
import { hasCompletionError } from "./types";

type FileRefGroup = "context" | "existing" | "generic" | "image";

const OPENAI_FILE_REF_ORDER: readonly FileRefGroup[] = [
	"context",
	"existing",
	"generic",
	"image",
];
const GOOGLE_FILE_REF_ORDER: readonly FileRefGroup[] = [
	"image",
	"context",
	"generic",
];

export async function prepareOpenAIGeminiContext(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: LooseRequest,
	messages: readonly InternalMessage[],
	tools: ToolBundle | null | undefined,
	promptToolChoice: unknown,
	toolPolicy: ToolChoicePolicy | null | undefined,
	structured: unknown,
): Promise<GeminiContextPrepareResult> {
	const bundle = tools || null;
	const toolChoiceInstruction =
		buildToolChoiceInstructionFromPolicy(toolPolicy);
	const toolContext: PromptToolContext | null = bundle
		? {
				bundle,
				choiceInstruction: toolChoiceInstruction,
				include: promptToolChoice !== "none",
			}
		: null;
	return prepareGeminiContext({
		cfg,
		provider,
		messages,
		toolContext,
		attachmentPlan: openAIAttachmentPlanFromRequest(req, messages),
		structured,
		fileRefOrder: OPENAI_FILE_REF_ORDER,
	});
}

export async function prepareGoogleGeminiContext(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	messages: readonly InternalMessage[],
	hasTools: boolean,
	toolBundle?: ToolBundle | null,
	toolChoiceInstructionOverride?: string,
): Promise<GeminiContextPrepareResult> {
	const bundle = hasTools && toolBundle ? toolBundle : null;
	const toolChoiceInstruction = toolChoiceInstructionOverride ?? "";
	const toolContext: PromptToolContext | null = bundle
		? { bundle, choiceInstruction: toolChoiceInstruction, include: true }
		: null;
	return prepareGeminiContext({
		cfg,
		provider,
		messages,
		toolContext,
		attachmentPlan: attachmentPlanFromMessages(messages),
		structured: null,
		fileRefOrder: GOOGLE_FILE_REF_ORDER,
	});
}

type PrepareGeminiContextParams = {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	messages: readonly InternalMessage[];
	toolContext: PromptToolContext | null;
	attachmentPlan: AttachmentPlan;
	structured: unknown;
	fileRefOrder: readonly FileRefGroup[];
};

async function prepareGeminiContext(
	params: PrepareGeminiContextParams,
): Promise<GeminiContextPrepareResult> {
	const promptResult = messagesToPrompt(
		params.messages,
		params.toolContext,
		contextFileThreshold(params.cfg),
	);
	const bundle = params.toolContext?.bundle ?? null;
	const toolDefs = bundle
		? (bundle.promptArtifact.defs as readonly ToolDef[])
		: [];
	const prompt = promptResult.text;
	return preparePromptWithAttachments({
		cfg: params.cfg,
		provider: params.provider,
		basePrompt: prompt,
		basePromptPrepared: promptResultToPrepared(promptResult, prompt),
		basePromptByteCheck: contextFilePromptByteCheckFromBounded(
			params.cfg,
			promptResult.byteCheck,
		),
		hiddenPromptInsertOffset:
			promptResult.hiddenPromptInsertOffset ?? undefined,
		attachmentPlan: params.attachmentPlan,
		toolDefs,
		toolPromptSource: bundle,
		toolChoiceInstruction: params.toolContext?.choiceInstruction ?? "",
		basePromptMetadata: promptResult.metadata,
		buildHistoryText: () =>
			buildOpenAIHistoryTranscript(
				params.messages,
				params.cfg.current_input_file_name || "message.txt",
			),
		getLatestInputText: () =>
			promptResult.latestInputText ||
			latestOpenAIUserInputText(params.messages),
		structured: params.structured,
		fileRefOrder: params.fileRefOrder,
	});
}

type PromptWithAttachmentParams = {
	cfg: RuntimeConfig;
	provider: CompletionProvider;
	basePrompt: string;
	basePromptPrepared?: PromptWithTokens | null;
	basePromptByteCheck?: ContextFilePromptByteCheck | null;
	hiddenPromptInsertOffset?: number | undefined;
	attachmentPlan: AttachmentPlan;
	toolDefs: readonly ToolDef[];
	toolPromptSource?: ToolBundle | null;
	toolChoiceInstruction: string;
	basePromptMetadata: PromptMetadata;
	buildHistoryText: () => string;
	getLatestInputText: () => unknown;
	structured: unknown;
	fileRefOrder: readonly FileRefGroup[];
};

async function preparePromptWithAttachments(
	params: PromptWithAttachmentParams,
): Promise<GeminiContextPrepareResult> {
	const plannedDroppedNote = droppedAttachmentNote(
		params.attachmentPlan.dropped,
	);
	const preUploadPromptDecision = preUploadPromptDecisionForPlannedDrops(
		params,
		plannedDroppedNote,
	);
	if (preUploadPromptDecision.promptByteCheck.exceeded) {
		const contextUnavailableReason = contextFileUploadUnavailableReason(
			params.cfg,
			params.provider.uploadTextFile,
		);
		if (contextUnavailableReason) {
			return {
				error: oversizedInlineContextFailure(
					params.cfg,
					preUploadPromptDecision.contextPromptText,
					preUploadPromptDecision.promptByteCheck,
					contextUnavailableReason,
				),
			};
		}
	}

	let contextFiles: ContextFileResult | null = null;
	if (preUploadPromptDecision.considerContextFiles) {
		const prepared = await prepareContextFilesForDecision(
			params,
			preUploadPromptDecision,
		);
		if (prepared && hasCompletionError(prepared))
			return { error: prepared.error };
		contextFiles = prepared;
	}

	let attachmentResult: AttachmentResolutionResult;
	try {
		attachmentResult = await params.provider.resolveAttachments(
			params.attachmentPlan,
		);
	} catch (error) {
		return {
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
	const attachmentPromptText =
		(attachmentResult.promptText || "") + (attachmentResult.droppedNote || "");
	const preparedBase = params.basePromptPrepared
		? (appendTextToPreparedWithTokens(params.basePromptPrepared, [
				attachmentPromptText,
			]) as PromptWithTokens)
		: (buildTextWithTokens([
				params.basePrompt,
				attachmentPromptText,
			]) as PromptWithTokens);
	const inlineHiddenToolsPrompt = withGeminiNativeHiddenToolsPromptForPrepared(
		preparedBase,
		true,
		params.hiddenPromptInsertOffset,
	) as PromptWithTokens;
	const inlinePreparedPrompt = prepareStructuredPrompt(
		inlineHiddenToolsPrompt,
		params.structured,
	);
	let contextPromptText = preUploadPromptDecision.contextPromptText;
	let promptCheckSource = preUploadPromptDecision.promptCheckSource;
	let promptByteCheck = preUploadPromptDecision.promptByteCheck;
	if (!contextFiles) {
		contextPromptText = inlinePreparedPrompt.text;
		promptCheckSource = "inline";
		promptByteCheck = contextFilePromptByteCheck(params.cfg, contextPromptText);
		const considerContextFiles = shouldConsiderContextFiles(
			params.cfg,
			contextPromptText,
			promptByteCheck,
		);

		const contextUnavailableReason = promptByteCheck.exceeded
			? contextFileUploadUnavailableReason(
					params.cfg,
					params.provider.uploadTextFile,
				)
			: "";
		if (promptByteCheck.exceeded && contextUnavailableReason) {
			return {
				error: oversizedInlineContextFailure(
					params.cfg,
					contextPromptText,
					promptByteCheck,
					contextUnavailableReason,
				),
			};
		}

		if (considerContextFiles) {
			const promptDecision: PromptDecision = {
				contextPromptText,
				promptCheckSource,
				promptByteCheck,
				considerContextFiles,
			};
			const prepared = await prepareContextFilesForDecision(
				params,
				promptDecision,
			);
			if (prepared && hasCompletionError(prepared))
				return { error: prepared.error };
			contextFiles = prepared;
		}
	}
	if (params.cfg.log_requests) {
		const contextPrepareStageFields: Record<string, unknown> = {
			promptCheck: promptCheckSource,
			promptBytes: promptByteCheck.exact
				? promptByteCheck.bytes
				: `>${promptByteCheck.thresholdBytes}`,
			threshold: promptByteCheck.thresholdBytes,
			exceeded: promptByteCheck.exceeded,
			contextFiles: !!contextFiles,
			contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
			genericFileRefs: attachmentResult.genericFileRefs
				? attachmentResult.genericFileRefs.length
				: 0,
			imageRefs: attachmentResult.imageFileRefs
				? attachmentResult.imageFileRefs.length
				: 0,
			droppedAttachments: attachmentResult.usage.droppedFiles,
			dedupedAttachments: attachmentResult.usage.dedupedFiles,
			toolDefs: params.toolDefs.length,
		};
		contextPrepareStageFields.basePromptHasToolBlock =
			params.basePromptMetadata.hasToolPrompt;
		contextPrepareStageFields.basePromptHasToolNames =
			params.basePromptMetadata.hasToolPrompt && params.toolDefs.length > 0;
		logStage(params.cfg, "context_prepare", contextPrepareStageFields);
	}

	const contextFileRefs = contextFiles ? contextFiles.fileRefs : null;
	const fileRefGroups: Record<FileRefGroup, FileRef[] | null> = {
		context: contextFileRefs,
		existing: params.attachmentPlan.existingFileRefs as FileRef[] | null,
		generic: attachmentResult.genericFileRefs as FileRef[] | null,
		image: attachmentResult.imageFileRefs as FileRef[] | null,
	};
	const fileRefs = attachmentResult.supportsFileRefs
		? mergeFileRefs(...params.fileRefOrder.map((group) => fileRefGroups[group]))
		: null;
	const livePreparedPrompt = contextFiles
		? prepareStructuredPrompt(
				buildTextWithTokens([
					contextFiles.prompt,
					attachmentPromptText,
				]) as PromptWithTokens,
				params.structured,
			)
		: inlinePreparedPrompt;
	const usagePreparedPrompt = contextFiles
		? prepareStructuredPrompt(
				appendTextToPreparedWithTokens(
					{ text: "", tokens: 0, counts: contextFiles.promptTokenCounts },
					[attachmentPromptText],
					false,
				) as PromptWithTokens,
				params.structured,
				false,
			)
		: livePreparedPrompt;
	const attachmentFileRefTokens = attachmentFileRefTokenEstimate(
		attachmentResult.usage,
	);

	return {
		toolDefs: params.toolDefs,
		toolChoiceInstruction: params.toolChoiceInstruction,
		prompt: livePreparedPrompt.text,
		promptTokens: usagePreparedPrompt.tokens + attachmentFileRefTokens,
		fileRefs,
		contextFiles,
		promptMetadata: contextFiles
			? { hasToolPrompt: false, hasToolInstructions: true }
			: params.basePromptMetadata,
	};
}

/** Ordered de-duplicating merge of provider file-ref groups. */
export function mergeFileRefs<T>(
	...groups: Array<readonly T[] | null | undefined>
): T[] | null {
	const out: T[] = [];
	const seen = new Set<unknown>();
	for (const group of groups) {
		if (!Array.isArray(group)) continue;
		for (const ref of group) {
			if (!ref) continue;
			let key: unknown;
			if (typeof ref === "string") key = ref;
			else if (isRecord(ref))
				key = ref.ref || ref.fileRef || ref.id || JSON.stringify(ref);
			else key = JSON.stringify(ref);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(ref);
		}
	}
	return out.length ? out : null;
}

function attachmentFileRefTokenEstimate(
	usage: { fileRefBytes?: unknown; uploadedBytes?: unknown } | null | undefined,
): number {
	if (!usage) return 0;
	const bytes = Number(usage.fileRefBytes ?? usage.uploadedBytes);
	if (!Number.isFinite(bytes) || bytes <= 0) return 0;
	return Math.floor(bytes / 3);
}

type PromptDecision = {
	contextPromptText: string;
	promptCheckSource: string;
	promptByteCheck: ContextFilePromptByteCheck;
	considerContextFiles: boolean;
};

function preUploadPromptDecisionForPlannedDrops(
	params: PromptWithAttachmentParams,
	droppedNote: string,
): PromptDecision {
	const contextPromptText = params.basePrompt + droppedNote;
	let promptCheckSource = "base";
	let promptByteCheck = droppedNote
		? contextFilePromptByteCheck(params.cfg, contextPromptText)
		: params.basePromptByteCheck ||
			contextFilePromptByteCheck(params.cfg, contextPromptText);
	let considerContextFiles = shouldConsiderContextFiles(
		params.cfg,
		contextPromptText,
		promptByteCheck,
	);
	if (!promptByteCheck.exceeded) {
		promptByteCheck = inlinePreparedPromptByteCheck(
			params.cfg,
			contextPromptText,
			params.structured,
			params.hiddenPromptInsertOffset,
		);
		promptCheckSource = "inline_estimate";
		considerContextFiles = shouldConsiderContextFiles(
			params.cfg,
			contextPromptText,
			promptByteCheck,
		);
	}
	return {
		contextPromptText,
		promptCheckSource,
		promptByteCheck,
		considerContextFiles,
	};
}

async function prepareContextFilesForDecision(
	params: PromptWithAttachmentParams,
	decision: PromptDecision,
): Promise<ContextFileResult | ContextFileFailure | null> {
	const historyText = params.buildHistoryText();
	const latestInputText = params.getLatestInputText();
	return prepareContextFiles(
		params.cfg,
		historyText,
		params.toolDefs,
		params.toolChoiceInstruction,
		latestInputText,
		decision.contextPromptText,
		params.provider.uploadTextFile,
		decision.promptByteCheck,
		params.toolPromptSource ?? null,
	);
}

function prepareStructuredPrompt(
	prompt: PromptWithTokens,
	structured: unknown,
	keepText = true,
): PromptWithTokens {
	return structured
		? (appendStructuredOutputInstructionToPrepared(
				prompt,
				structured,
				keepText,
			) as PromptWithTokens)
		: prompt;
}

function promptResultToPrepared(
	promptResult: { tokens?: number; counts?: unknown },
	text: string,
): PromptWithTokens | null {
	if (!promptResult?.counts) return null;
	return {
		text,
		tokens: promptResult.tokens || 0,
		counts: promptResult.counts,
	};
}

function contextFilePromptByteCheckFromBounded(
	cfg: RuntimeConfig,
	check: PromptByteLengthBounded | null | undefined,
): ContextFilePromptByteCheck | null {
	if (!check) return null;
	const thresholdBytes = contextFileThreshold(cfg);
	if (check.maxBytes !== thresholdBytes) return null;
	return { ...check, thresholdBytes };
}

function inlinePreparedPromptByteCheck(
	cfg: RuntimeConfig,
	prompt: string,
	structured: unknown,
	hiddenPromptInsertOffset?: number,
): ContextFilePromptByteCheck {
	const thresholdBytes = contextFileThreshold(cfg);
	const sniffer = createPromptByteLengthSniffer(thresholdBytes);
	const prepared = withGeminiNativeHiddenToolsPromptWithTokens(
		prompt,
		true,
		hiddenPromptInsertOffset,
	).text;
	const hasText = !!prepared;
	if (prepared) sniffer.append(prepared);
	const instruction = structuredInstruction(structured);
	if (instruction) {
		if (hasText) sniffer.append("\n\n");
		sniffer.append(instruction);
	}
	return { ...sniffer.result(), thresholdBytes };
}
