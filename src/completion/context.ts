import {
	googleToolDefs,
	mergeFileRefs,
	openAIToolDefs,
} from "../toolcall/content";
import { buildToolChoiceInstructionFromPolicy } from "../toolcall/policy-openai";
import type { ToolBundle } from "../toolcall/tool-bundle";
import {
	googleContentsToPrompt,
	googleToolChoiceInstruction,
} from "../promptcompat/google";
import {
	appendStructuredOutputInstructionToPrepared,
	appendTextToPreparedWithTokens,
	structuredInstruction,
	withGeminiNativeHiddenToolsPromptForPrepared,
	withGeminiNativeHiddenToolsPromptWithTokens,
} from "../promptcompat/prompt-build";
import {
	buildGoogleHistoryTranscript,
	buildOpenAIHistoryTranscript,
	latestGoogleUserInputText,
	latestOpenAIUserInputText,
} from "../promptcompat/history";
import { collectOpenAIRequestAttachmentPlan } from "../attachments/collect-openai";
import { droppedAttachmentNote } from "../attachments/notes";
import {
	createAttachmentPlan,
	mergeAttachmentPlans,
} from "../attachments/plan";
import { messagesToPrompt } from "../promptcompat/messages";
import type { RuntimeConfig } from "../config";
import { logStage } from "../shared/logging";

import {
	prepareContextFiles,
	shouldConsiderContextFiles,
} from "./context-files";
import {
	contextFilePromptByteCheck,
	contextFileThreshold,
	contextFileUploadUnavailableReason,
	oversizedInlineContextFailure,
} from "./context-files";
import type {
	AttachmentResolutionResult,
	ContextFileFailure,
	ContextFileResult,
	FileRef,
	GeminiContextPrepareResult,
	LooseRequest,
	PromptWithTokens,
	ToolDef,
} from "./types";
import type { PromptMetadata } from "./types";
import { hasCompletionError } from "./types";
import type { CompletionProvider } from "./ports";
import type { ToolChoicePolicy } from "../toolcall/policy-openai";
import type { ContextFilePromptByteCheck } from "./context-files";
import {
	buildTextWithTokens,
	createPromptByteLengthSniffer,
	type PromptByteLengthBounded,
} from "../shared/tokens";
import type { AttachmentPlan } from "../attachments/types";

export { currentInputFilePrompt } from "../toolcall/content";
export {
	buildToolsContextTranscript,
	contextFilePromptByteCheck,
	contextFileThreshold,
	contextFileUploadFailure,
	latestInputInlineLimit,
	latestInputPromptForContextFile,
	oversizedInlineContextFailure,
	prepareContextFiles,
	prepareContextFilesWithUploader,
	shouldConsiderContextFiles,
	shouldUseContextFiles,
} from "./context-files";

export async function prepareOpenAIGeminiContext(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	req: LooseRequest,
	messages: unknown,
	tools: unknown,
	promptToolChoice: unknown,
	toolPolicy: ToolChoicePolicy | null | undefined,
	structured: unknown,
): Promise<GeminiContextPrepareResult> {
	const toolDefs = openAIToolDefs(tools) as ToolDef[];
	const toolChoiceInstruction =
		buildToolChoiceInstructionFromPolicy(toolPolicy);
	const promptResult = messagesToPrompt(
		messages,
		tools,
		promptToolChoice,
		toolDefs,
		toolChoiceInstruction,
		contextFileThreshold(cfg),
	);
	const [prompt0, images] = promptResult as [string, unknown];
	const attachmentPlan = mergeAttachmentPlans(
		createAttachmentPlan({ images, files: promptResult.files }),
		collectOpenAIRequestAttachmentPlan(req),
	);
	return preparePromptWithAttachments({
		cfg,
		provider,
		basePrompt: prompt0,
		basePromptPrepared: promptResultToPrepared(promptResult, prompt0),
		basePromptByteCheck: contextFilePromptByteCheckFromBounded(
			cfg,
			promptResult.byteCheck,
		),
		hiddenPromptInsertOffset: promptResult.hiddenPromptInsertOffset,
		attachmentPlan,
		toolDefs,
		toolPromptSource: tools,
		toolChoiceInstruction,
		basePromptMetadata: promptResultMetadata(promptResult),
		buildHistoryText: () =>
			buildOpenAIHistoryTranscript(
				messages,
				cfg.current_input_file_name || "message.txt",
			),
		getLatestInputText: () =>
			promptResult.latestInputText != null
				? promptResult.latestInputText
				: latestOpenAIUserInputText(messages),
		structured,
		buildFileRefGroups: (
			contextFileRefs,
			existingFileRefs,
			genericFileRefs,
			imageFileRefs,
		) => [contextFileRefs, existingFileRefs, genericFileRefs, imageFileRefs],
	});
}

export async function prepareGoogleGeminiContext(
	cfg: RuntimeConfig,
	provider: CompletionProvider,
	effectiveReq: LooseRequest,
	hasTools: boolean,
	toolBundle?: ToolBundle | null,
	toolChoiceInstructionOverride?: string,
): Promise<GeminiContextPrepareResult> {
	const toolDefs = (
		hasTools ? googleToolDefs(toolBundle || effectiveReq) : []
	) as ToolDef[];
	const toolChoiceInstruction =
		toolChoiceInstructionOverride ?? googleToolChoiceInstruction(effectiveReq);
	const promptResult = googleContentsToPrompt(
		effectiveReq,
		toolDefs,
		contextFileThreshold(cfg),
		toolBundle || effectiveReq,
	);
	const [prompt0, images] = promptResult as [string, unknown];
	const attachmentPlan = createAttachmentPlan({
		images,
		files: promptResult.files,
	});
	return preparePromptWithAttachments({
		cfg,
		provider,
		basePrompt: prompt0,
		basePromptPrepared: promptResultToPrepared(promptResult, prompt0),
		basePromptByteCheck: contextFilePromptByteCheckFromBounded(
			cfg,
			promptResult.byteCheck,
		),
		hiddenPromptInsertOffset: promptResult.hiddenPromptInsertOffset,
		attachmentPlan,
		toolDefs,
		toolPromptSource: toolBundle || effectiveReq,
		toolChoiceInstruction,
		basePromptMetadata: promptResultMetadata(promptResult),
		buildHistoryText: () =>
			buildGoogleHistoryTranscript(
				effectiveReq,
				cfg.current_input_file_name || "message.txt",
			),
		getLatestInputText: () =>
			promptResult.latestInputText != null
				? promptResult.latestInputText
				: latestGoogleUserInputText(effectiveReq),
		structured: null,
		buildFileRefGroups: (
			contextFileRefs,
			_existingFileRefs,
			genericFileRefs,
			imageFileRefs,
		) => [imageFileRefs, contextFileRefs, genericFileRefs],
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
	toolDefs: ToolDef[];
	toolPromptSource?: unknown;
	toolChoiceInstruction: string;
	basePromptMetadata?: PromptMetadata;
	buildHistoryText: () => string;
	getLatestInputText: () => unknown;
	structured: unknown;
	buildFileRefGroups: (
		contextFileRefs: FileRef[] | null,
		existingFileRefs: FileRef[] | null,
		genericFileRefs: FileRef[] | null,
		imageFileRefs: FileRef[] | null,
	) => Array<FileRef[] | null>;
};

async function preparePromptWithAttachments(
	params: PromptWithAttachmentParams,
): Promise<GeminiContextPrepareResult> {
	const plannedDroppedNote = droppedAttachmentNote(
		params.attachmentPlan.dropped,
	);
	const preUploadPromptDecision = promptDecisionForDroppedNote(
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
	let basePromptWithAttachmentTextPrepared: PromptWithTokens | null = null;
	const getBasePromptWithAttachmentTextPrepared =
		(): PromptWithTokens | null => {
			if (!params.basePromptPrepared) return null;
			if (!basePromptWithAttachmentTextPrepared) {
				basePromptWithAttachmentTextPrepared = appendTextToPreparedWithTokens(
					params.basePromptPrepared,
					[attachmentPromptText],
				) as PromptWithTokens;
			}
			return basePromptWithAttachmentTextPrepared;
		};
	let inlinePreparedPrompt: PromptWithTokens | null = null;
	const getInlinePreparedPrompt = (): PromptWithTokens => {
		if (!inlinePreparedPrompt) {
			const preparedBase = getBasePromptWithAttachmentTextPrepared();
			const inlineHiddenToolsPrompt = preparedBase
				? (withGeminiNativeHiddenToolsPromptForPrepared(
						preparedBase,
						true,
						params.hiddenPromptInsertOffset,
					) as PromptWithTokens)
				: (withGeminiNativeHiddenToolsPromptWithTokens(
						params.basePrompt + attachmentPromptText,
						true,
						params.hiddenPromptInsertOffset,
					) as PromptWithTokens);
			inlinePreparedPrompt = prepareStructuredPrompt(
				inlineHiddenToolsPrompt,
				params.structured,
			);
		}
		return inlinePreparedPrompt;
	};
	let contextPromptText = preUploadPromptDecision.contextPromptText;
	let promptCheckSource = preUploadPromptDecision.promptCheckSource;
	let promptByteCheck = preUploadPromptDecision.promptByteCheck;
	if (!contextFiles) {
		const promptDecision = promptDecisionForDroppedNote(
			params,
			attachmentPromptText,
			getInlinePreparedPrompt,
		);
		contextPromptText = promptDecision.contextPromptText;
		promptCheckSource = promptDecision.promptCheckSource;
		promptByteCheck = promptDecision.promptByteCheck;

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

		if (promptDecision.considerContextFiles) {
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
		contextPrepareStageFields.basePromptHasToolBlock = String(
			params.basePrompt || "",
		).includes("Available tools");
		contextPrepareStageFields.basePromptHasToolNames = promptContainsToolNames(
			params.basePrompt,
			params.toolDefs,
		);
		logStage(params.cfg, "context_prepare", contextPrepareStageFields);
	}

	const contextFileRefs = contextFiles ? contextFiles.fileRefs : null;
	const fileRefs = attachmentResult.supportsFileRefs
		? mergeFileRefs(
				...params.buildFileRefGroups(
					contextFileRefs,
					params.attachmentPlan.existingFileRefs as FileRef[] | null,
					attachmentResult.genericFileRefs as FileRef[] | null,
					attachmentResult.imageFileRefs as FileRef[] | null,
				),
			)
		: null;
	const livePreparedPrompt = contextFiles
		? prepareStructuredPrompt(
				buildTextWithTokens([
					contextFiles.prompt,
					attachmentPromptText,
				]) as PromptWithTokens,
				params.structured,
			)
		: getInlinePreparedPrompt();
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
			? { hasToolInstructions: true }
			: params.basePromptMetadata || {},
	};
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

function promptDecisionForDroppedNote(
	params: PromptWithAttachmentParams,
	droppedNote: string,
	getInlinePreparedPrompt?: () => PromptWithTokens,
): PromptDecision {
	let contextPromptText = params.basePrompt + droppedNote;
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
		const inlineByteCheck = inlinePreparedPromptByteCheck(
			params.cfg,
			contextPromptText,
			params.structured,
			params.hiddenPromptInsertOffset,
		);
		if (inlineByteCheck.exceeded) {
			promptByteCheck = inlineByteCheck;
			promptCheckSource = "inline_estimate";
		} else {
			contextPromptText = getInlinePreparedPrompt
				? getInlinePreparedPrompt().text
				: contextPromptText;
			promptByteCheck = getInlinePreparedPrompt
				? contextFilePromptByteCheck(params.cfg, contextPromptText)
				: inlineByteCheck;
			promptCheckSource = getInlinePreparedPrompt
				? "inline"
				: "inline_estimate";
		}
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
		params.toolPromptSource || params.toolDefs,
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

function promptResultMetadata(promptResult: {
	hasToolPrompt?: boolean;
	hasToolInstructions?: boolean;
}): PromptMetadata {
	return {
		hasToolPrompt: !!promptResult.hasToolPrompt,
		hasToolInstructions: !!promptResult.hasToolInstructions,
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

function promptContainsToolNames(
	prompt: unknown,
	toolDefs: readonly ToolDef[],
): boolean {
	const text = String(prompt || "");
	const names = toolDefs
		.map((tool) => String(tool.name || "").trim())
		.filter(Boolean);
	return !!names.length && names.every((name) => text.includes(name));
}
