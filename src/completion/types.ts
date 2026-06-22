import type { ErrorWithMetadata, UnknownRecord } from "../shared/types";
import type { TokenCharCounts } from "../shared/tokens";

export type FileRef = string | {
  ref?: string;
  fileRef?: string;
  id?: string;
  name?: string;
  filename?: string;
};

export type ToolDef = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type PromptWithTokens = {
  text: string;
  tokens: number;
  counts?: unknown;
};

export type PromptMetadata = {
  hasToolPrompt?: boolean;
  hasToolInstructions?: boolean;
};

export type AttachmentResolutionResult = {
  fileRefs: FileRef[] | null;
  droppedNote: string;
};

export type ImageResolutionResult = AttachmentResolutionResult;

export type FileResolutionResult = AttachmentResolutionResult;

export type ContextFileResult = {
  fileRefs: FileRef[];
  prompt: string;
  promptTokenCounts: TokenCharCounts & { hasText: boolean };
  promptTokenText: string;
};

export type ContextFileFailure = {
  error: ErrorWithMetadata;
};

export type PreparedGeminiContext = {
  toolDefs: ToolDef[];
  toolChoiceInstruction: string;
  prompt: string;
  promptTokens: number;
  fileRefs: FileRef[] | null;
  contextFiles: ContextFileResult | null;
  promptMetadata?: PromptMetadata;
};

export type GeminiContextPrepareResult = PreparedGeminiContext | ContextFileFailure;

export type LooseRequest = UnknownRecord;

export function hasCompletionError<T>(value: T | ContextFileFailure): value is ContextFileFailure {
  return !!value && typeof value === "object" && "error" in value;
}
