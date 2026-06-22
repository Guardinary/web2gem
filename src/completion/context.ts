import { googleToolDefs, mergeFileRefs, openAIToolDefs } from "../toolcall/content";
import { buildToolChoiceInstructionFromPolicy } from "../toolcall/policy-openai";
import type { ToolBundle } from "../toolcall/tool-bundle";
import { googleContentsToPrompt, googleToolChoiceInstruction } from "../promptcompat/google";
import { appendStructuredOutputInstructionToPrepared, appendTextToPreparedWithTokens, structuredInstruction, withGeminiNativeHiddenToolsPromptForPrepared, withGeminiNativeHiddenToolsPromptWithTokens } from "../promptcompat/prompt-build";
import { buildGoogleHistoryTranscript, buildOpenAIHistoryTranscript, latestGoogleUserInputText, latestOpenAIUserInputText } from "../promptcompat/history";
import { collectOpenAIInlineUploadFiles, collectOpenAIRefFileIDs } from "../promptcompat/file-refs";
import { messagesToPrompt } from "../promptcompat/messages";
import type { RuntimeConfig } from "../config";
import { logStage } from "../shared/runtime";

import { prepareContextFiles, shouldConsiderContextFiles } from "./context-files";
import { contextFilePromptByteCheck, contextFileThreshold, contextFileUploadUnavailableReason, oversizedInlineContextFailure } from "./context-files";
import type { ContextFileResult, FileRef, GeminiContextPrepareResult, LooseRequest, PromptWithTokens, ToolDef } from "./types";
import type { PromptMetadata } from "./types";
import { hasCompletionError } from "./types";
import type { CompletionProvider } from "./ports";
import type { ToolChoicePolicy } from "../toolcall/policy-openai";
import type { ContextFilePromptByteCheck } from "./context-files";
import { buildTextWithTokens, createPromptByteLengthSniffer, type PromptByteLengthBounded } from "../shared/tokens";

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

export async function prepareOpenAIGeminiContext(cfg: RuntimeConfig, provider: CompletionProvider, req: LooseRequest, messages: unknown, tools: unknown, promptToolChoice: unknown, toolPolicy: ToolChoicePolicy | null | undefined, structured: unknown): Promise<GeminiContextPrepareResult> {
  const toolDefs = openAIToolDefs(tools) as ToolDef[];
  const toolChoiceInstruction = buildToolChoiceInstructionFromPolicy(toolPolicy);
  const promptResult = messagesToPrompt(messages, tools, promptToolChoice, toolDefs, toolChoiceInstruction, contextFileThreshold(cfg));
  const [prompt0, images] = promptResult as [string, unknown];
  const files = mergeUploadInputs(promptResult.files, collectOpenAIInlineUploadFiles(req));
  return preparePromptWithAttachments({
    cfg,
    provider,
    basePrompt: prompt0,
    basePromptPrepared: promptResultToPrepared(promptResult, prompt0),
    basePromptByteCheck: contextFilePromptByteCheckFromBounded(cfg, promptResult.byteCheck),
    hiddenPromptInsertOffset: promptResult.hiddenPromptInsertOffset,
    images,
    files,
    toolDefs,
    toolPromptSource: tools,
    toolChoiceInstruction,
    basePromptMetadata: promptResultMetadata(promptResult),
    buildHistoryText: () => buildOpenAIHistoryTranscript(messages, cfg.current_input_file_name || "message.txt"),
    getLatestInputText: () => promptResult.latestInputText != null ? promptResult.latestInputText : latestOpenAIUserInputText(messages),
    structured,
    buildFileRefGroups: (contextFileRefs, genericFileRefs, imageFileRefs) => [
      contextFileRefs,
      collectOpenAIRefFileIDs(req) as FileRef[],
      genericFileRefs,
      imageFileRefs,
    ],
  });
}

function mergeUploadInputs(...groups: unknown[]): unknown[] | undefined {
  const out: unknown[] = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (item) out.push(item);
    }
  }
  return out.length ? out : undefined;
}

export async function prepareGoogleGeminiContext(cfg: RuntimeConfig, provider: CompletionProvider, effectiveReq: LooseRequest, hasTools: boolean, toolBundle?: ToolBundle | null, toolChoiceInstructionOverride?: string): Promise<GeminiContextPrepareResult> {
  const toolDefs = (hasTools ? googleToolDefs(toolBundle || effectiveReq) : []) as ToolDef[];
  const toolChoiceInstruction = toolChoiceInstructionOverride ?? googleToolChoiceInstruction(effectiveReq);
  const promptResult = googleContentsToPrompt(effectiveReq, toolDefs, contextFileThreshold(cfg), toolBundle || effectiveReq);
  const [prompt0, images] = promptResult as [string, unknown];
  const files = promptResult.files;
  return preparePromptWithAttachments({
    cfg,
    provider,
    basePrompt: prompt0,
    basePromptPrepared: promptResultToPrepared(promptResult, prompt0),
    basePromptByteCheck: contextFilePromptByteCheckFromBounded(cfg, promptResult.byteCheck),
    hiddenPromptInsertOffset: promptResult.hiddenPromptInsertOffset,
    images,
    files,
    toolDefs,
    toolPromptSource: toolBundle || effectiveReq,
    toolChoiceInstruction,
    basePromptMetadata: promptResultMetadata(promptResult),
    buildHistoryText: () => buildGoogleHistoryTranscript(effectiveReq, cfg.current_input_file_name || "message.txt"),
    getLatestInputText: () => promptResult.latestInputText != null ? promptResult.latestInputText : latestGoogleUserInputText(effectiveReq),
    structured: null,
    buildFileRefGroups: (contextFileRefs, genericFileRefs, imageFileRefs) => [
      imageFileRefs,
      contextFileRefs,
      genericFileRefs,
    ],
  });
}

type PromptWithAttachmentParams = {
  cfg: RuntimeConfig;
  provider: CompletionProvider;
  basePrompt: string;
  basePromptPrepared?: PromptWithTokens | null;
  basePromptByteCheck?: ContextFilePromptByteCheck | null;
  hiddenPromptInsertOffset?: number | undefined;
  images: unknown;
  files: unknown;
  toolDefs: ToolDef[];
  toolPromptSource?: unknown;
  toolChoiceInstruction: string;
  basePromptMetadata?: PromptMetadata;
  buildHistoryText: () => string;
  getLatestInputText: () => unknown;
  structured: unknown;
  buildFileRefGroups: (contextFileRefs: FileRef[] | null, genericFileRefs: FileRef[] | null, imageFileRefs: FileRef[] | null) => Array<FileRef[] | null>;
};

async function preparePromptWithAttachments(params: PromptWithAttachmentParams): Promise<GeminiContextPrepareResult> {
  const fileResolver = (params.provider as Partial<Pick<CompletionProvider, "resolveFiles">>).resolveFiles;
  const fileResult = fileResolver ? await fileResolver.call(params.provider, params.files) : { fileRefs: null, droppedNote: "" };
  const imageResult = await params.provider.resolveImages(params.images);
  const droppedNote = (fileResult.droppedNote || "") + (imageResult.droppedNote || "");
  const basePromptWithDroppedNote = params.basePrompt + droppedNote;
  let basePromptWithDroppedNotePrepared: PromptWithTokens | null = null;
  const getBasePromptWithDroppedNotePrepared = (): PromptWithTokens | null => {
    if (!params.basePromptPrepared) return null;
    if (!basePromptWithDroppedNotePrepared) {
      basePromptWithDroppedNotePrepared = appendTextToPreparedWithTokens(params.basePromptPrepared, [droppedNote]) as PromptWithTokens;
    }
    return basePromptWithDroppedNotePrepared;
  };
  let inlinePreparedPrompt: PromptWithTokens | null = null;
  const getInlinePreparedPrompt = (): PromptWithTokens => {
    if (!inlinePreparedPrompt) {
      const preparedBase = getBasePromptWithDroppedNotePrepared();
      const inlineHiddenToolsPrompt = preparedBase
        ? withGeminiNativeHiddenToolsPromptForPrepared(preparedBase, true, params.hiddenPromptInsertOffset) as PromptWithTokens
        : withGeminiNativeHiddenToolsPromptWithTokens(basePromptWithDroppedNote, true, params.hiddenPromptInsertOffset) as PromptWithTokens;
      inlinePreparedPrompt = prepareStructuredPrompt(inlineHiddenToolsPrompt, params.structured);
    }
    return inlinePreparedPrompt;
  };
  let contextFiles: ContextFileResult | null = null;

  let contextPromptText = basePromptWithDroppedNote;
  let promptCheckSource = "base";
  let promptByteCheck = droppedNote
    ? contextFilePromptByteCheck(params.cfg, contextPromptText)
    : params.basePromptByteCheck || contextFilePromptByteCheck(params.cfg, contextPromptText);
  let considerContextFiles = shouldConsiderContextFiles(params.cfg, contextPromptText, promptByteCheck);
  if (!promptByteCheck.exceeded) {
    const inlineByteCheck = inlinePreparedPromptByteCheck(params.cfg, basePromptWithDroppedNote, params.structured, params.hiddenPromptInsertOffset);
    if (inlineByteCheck.exceeded) {
      promptByteCheck = inlineByteCheck;
      promptCheckSource = "inline_estimate";
    } else {
      contextPromptText = getInlinePreparedPrompt().text;
      promptByteCheck = contextFilePromptByteCheck(params.cfg, contextPromptText);
      promptCheckSource = "inline";
    }
    considerContextFiles = shouldConsiderContextFiles(params.cfg, contextPromptText, promptByteCheck);
  }

  const contextUnavailableReason = promptByteCheck.exceeded
    ? contextFileUploadUnavailableReason(params.cfg, params.provider.uploadTextFile)
    : "";
  if (promptByteCheck.exceeded && contextUnavailableReason) {
    return { error: oversizedInlineContextFailure(params.cfg, contextPromptText, promptByteCheck, contextUnavailableReason) };
  }

  if (considerContextFiles) {
    const historyText = params.buildHistoryText();
    const latestInputText = params.getLatestInputText();
    const prepared = await prepareContextFiles(
      params.cfg,
      historyText,
      params.toolDefs,
      params.toolChoiceInstruction,
      latestInputText,
      contextPromptText,
      params.provider.uploadTextFile,
      promptByteCheck,
      params.toolPromptSource || params.toolDefs,
    );
    if (prepared && hasCompletionError(prepared)) return { error: prepared.error };
    contextFiles = prepared;
  }
  if (params.cfg.log_requests) {
    const contextPrepareStageFields: Record<string, unknown> = {
      promptCheck: promptCheckSource,
      promptBytes: promptByteCheck.exact ? promptByteCheck.bytes : `>${promptByteCheck.thresholdBytes}`,
      threshold: promptByteCheck.thresholdBytes,
      exceeded: promptByteCheck.exceeded,
      contextFiles: !!contextFiles,
      contextRefs: contextFiles ? contextFiles.fileRefs.length : 0,
      genericFileRefs: fileResult.fileRefs ? fileResult.fileRefs.length : 0,
      imageRefs: imageResult.fileRefs ? imageResult.fileRefs.length : 0,
      toolDefs: params.toolDefs.length,
    };
    contextPrepareStageFields.basePromptHasToolBlock = String(params.basePrompt || "").includes("Available tools");
    contextPrepareStageFields.basePromptHasToolNames = promptContainsToolNames(params.basePrompt, params.toolDefs);
    logStage(params.cfg, "context_prepare", contextPrepareStageFields);
  }

  const contextFileRefs = contextFiles ? contextFiles.fileRefs : null;
  const fileRefs = mergeFileRefs(...params.buildFileRefGroups(contextFileRefs, fileResult.fileRefs, imageResult.fileRefs));
  const livePreparedPrompt = contextFiles
    ? prepareStructuredPrompt(buildTextWithTokens([contextFiles.prompt, droppedNote]) as PromptWithTokens, params.structured)
    : getInlinePreparedPrompt();
  const usagePreparedPrompt = contextFiles
    ? prepareStructuredPrompt(
        appendTextToPreparedWithTokens({ text: "", tokens: 0, counts: contextFiles.promptTokenCounts }, [droppedNote], false) as PromptWithTokens,
        params.structured,
        false,
      )
    : livePreparedPrompt;

  return {
    toolDefs: params.toolDefs,
    toolChoiceInstruction: params.toolChoiceInstruction,
    prompt: livePreparedPrompt.text,
    promptTokens: usagePreparedPrompt.tokens,
    fileRefs,
    contextFiles,
    promptMetadata: contextFiles
      ? { hasToolInstructions: true }
      : (params.basePromptMetadata || {}),
  };
}

function prepareStructuredPrompt(prompt: PromptWithTokens, structured: unknown, keepText: boolean = true): PromptWithTokens {
  return structured ? appendStructuredOutputInstructionToPrepared(prompt, structured, keepText) as PromptWithTokens : prompt;
}

function promptResultToPrepared(promptResult: { tokens?: number; counts?: unknown }, text: string): PromptWithTokens | null {
  if (!promptResult || !promptResult.counts) return null;
  return { text, tokens: promptResult.tokens || 0, counts: promptResult.counts };
}

function promptResultMetadata(promptResult: { hasToolPrompt?: boolean; hasToolInstructions?: boolean }): PromptMetadata {
  return {
    hasToolPrompt: !!promptResult.hasToolPrompt,
    hasToolInstructions: !!promptResult.hasToolInstructions,
  };
}

function contextFilePromptByteCheckFromBounded(cfg: RuntimeConfig, check: PromptByteLengthBounded | null | undefined): ContextFilePromptByteCheck | null {
  if (!check) return null;
  const thresholdBytes = contextFileThreshold(cfg);
  if (check.maxBytes !== thresholdBytes) return null;
  return { ...check, thresholdBytes };
}

function inlinePreparedPromptByteCheck(cfg: RuntimeConfig, prompt: string, structured: unknown, hiddenPromptInsertOffset?: number): ContextFilePromptByteCheck {
  const thresholdBytes = contextFileThreshold(cfg);
  const sniffer = createPromptByteLengthSniffer(thresholdBytes);
  const prepared = withGeminiNativeHiddenToolsPromptWithTokens(prompt, true, hiddenPromptInsertOffset).text;
  let hasText = !!prepared;
  if (prepared) sniffer.append(prepared);
  const instruction = structuredInstruction(structured);
  if (instruction) {
    if (hasText) sniffer.append("\n\n");
    sniffer.append(instruction);
  }
  return { ...sniffer.result(), thresholdBytes };
}

function promptContainsToolNames(prompt: unknown, toolDefs: readonly ToolDef[]): boolean {
  const text = String(prompt || "");
  const names = toolDefs.map((tool) => String(tool.name || "").trim()).filter(Boolean);
  return !!names.length && names.every((name) => text.includes(name));
}
