import { generate, generateRich as generateGeminiRich, generateStream } from "./client";
import { resolveAttachments, uploadTextFile } from "./uploads";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import type { CompletionProvider, CompletionProviderOptions, CompletionRichOptions, CompletionTextInput } from "../completion/ports";
import type { AttachmentPlan } from "../attachments/types";
import { logStage } from "../shared/runtime";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;

export function createGeminiCompletionProvider(cfg: RuntimeConfig): CompletionProvider {
  return {
    generateText(input: CompletionTextInput) {
      const model = requireResolvedModel(input.rm);
      if (cfg.log_requests) logGeminiRoute(cfg, model, false);
      return generate(cfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, model.modelHeaders);
    },
    generateRich(input: CompletionTextInput, options: CompletionRichOptions = {}) {
      const model = requireResolvedModel(input.rm);
      if (cfg.log_requests) logGeminiRoute(cfg, model, false);
      return generateGeminiRich(cfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, model.modelHeaders, options);
    },
    async *streamText(input: CompletionTextInput, options: CompletionProviderOptions = {}) {
      const model = requireResolvedModel(input.rm);
      if (cfg.log_requests) logGeminiRoute(cfg, model, true);
      for await (const delta of generateStream(cfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, options, model.modelHeaders)) {
        const text = String(delta || "");
        if (text) yield text;
      }
    },
    resolveAttachments(plan: AttachmentPlan) {
      return resolveAttachments(cfg, plan);
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

function logGeminiRoute(cfg: RuntimeConfig, model: ResolvedModelOK, stream: boolean): void {
  logStage(cfg, "gemini_route", {
    model: model.name,
    modelFamily: model.modeId,
    thinkingMode: model.thinkMode,
    enhancedMode: model.extra ? model.extra[31] : undefined,
    enhancedRouting: model.extra ? model.extra[80] : undefined,
    webModelHeader: !!model.modelHeaders,
    stream,
  });
}
