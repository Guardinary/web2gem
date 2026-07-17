import type {
	AttachmentFileRef,
	AttachmentUploadResult,
} from "../attachments/types";
import type { TokenCharCounts } from "../promptcompat/token-accounting";
import type { ErrorWithMetadata, UnknownRecord } from "../shared/types";

export type FileRef = AttachmentFileRef;

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
	hasToolPrompt: boolean;
	hasToolInstructions: boolean;
};

export type AttachmentResolutionResult = AttachmentUploadResult;

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
	toolDefs: readonly ToolDef[];
	toolChoiceInstruction: string;
	prompt: string;
	promptTokens: number;
	fileRefs: FileRef[] | null;
	contextFiles: ContextFileResult | null;
	promptMetadata: PromptMetadata;
};

export type GeminiContextPrepareResult =
	| PreparedGeminiContext
	| ContextFileFailure;

export type LooseRequest = UnknownRecord;

export function hasCompletionError<T>(
	value: T | ContextFileFailure,
): value is ContextFileFailure {
	return !!value && typeof value === "object" && "error" in value;
}
