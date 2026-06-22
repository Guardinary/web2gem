import { generate, generateStream } from "./client";
import { resolveFiles, resolveImages, uploadTextFile } from "./uploads";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import type { CompletionProvider, CompletionProviderOptions, CompletionTextInput } from "../completion/ports";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;

export function createGeminiCompletionProvider(cfg: RuntimeConfig): CompletionProvider {
  return {
    generateText(input: CompletionTextInput) {
      const model = requireResolvedModel(input.rm);
      return generate(cfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs);
    },
    async *streamText(input: CompletionTextInput, options: CompletionProviderOptions = {}) {
      const model = requireResolvedModel(input.rm);
      for await (const delta of generateStream(cfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, options)) {
        const text = String(delta || "");
        if (text) yield text;
      }
    },
    resolveImages(images: unknown) {
      return resolveImages(cfg, images);
    },
    resolveFiles(files: unknown) {
      return resolveFiles(cfg, files);
    },
    uploadTextFile(text: string, filename: string) {
      return uploadTextFile(cfg, text, filename);
    },
  };
}

function requireResolvedModel(rm: ResolvedModel): ResolvedModelOK {
  if (rm.name === undefined) throw new Error(rm.error || "model is not resolved");
  return rm;
}
