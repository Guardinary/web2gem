import type { ResolvedModel } from "../models";
import type { AttachmentPlan } from "../attachments/types";
import type { AttachmentResolutionResult, FileRef } from "./types";

export type CompletionTextInput = {
	prompt: string;
	rm: ResolvedModel;
	fileRefs?: FileRef[] | null;
};

export type GeneratedImage = {
	url: string;
	source: "generated" | "web";
	title?: string;
	alt?: string;
	imageId?: string;
	cid?: string;
	rid?: string;
	rcid?: string;
	base64?: string;
	outputFormat?: "png" | "jpeg" | "gif" | "webp";
};

export type CompletionRichOutput = {
	text: string;
	images: GeneratedImage[];
};

export type CompletionProviderOptions = {
	signal?: AbortSignal;
};

export type CompletionRichOptions = {
	hydrateGeneratedImageBytes?: boolean;
};

export type CompletionProvider = {
	supportsAuthenticatedSession?: boolean;
	generateText(input: CompletionTextInput): Promise<string>;
	generateRich?(
		input: CompletionTextInput,
		options?: CompletionRichOptions,
	): Promise<CompletionRichOutput>;
	streamText(
		input: CompletionTextInput,
		options?: CompletionProviderOptions,
	): AsyncIterable<string>;
	resolveAttachments(plan: AttachmentPlan): Promise<AttachmentResolutionResult>;
	uploadTextFile(text: string, filename: string): Promise<FileRef>;
	dispose?(): void | Promise<void>;
};
