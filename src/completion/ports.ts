import type { ResolvedModel } from "../models";
import type { FileRef, FileResolutionResult, ImageResolutionResult } from "./types";

export type CompletionTextInput = {
  prompt: string;
  rm: ResolvedModel;
  fileRefs?: FileRef[] | null;
};

export type CompletionProviderOptions = {
  signal?: AbortSignal;
};

export type CompletionProvider = {
  generateText(input: CompletionTextInput): Promise<string>;
  streamText(input: CompletionTextInput, options?: CompletionProviderOptions): AsyncIterable<string>;
  resolveImages(images: unknown): Promise<ImageResolutionResult>;
  resolveFiles(files: unknown): Promise<FileResolutionResult>;
  uploadTextFile(text: string, filename: string): Promise<FileRef>;
};
