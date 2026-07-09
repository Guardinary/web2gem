import { generate, generateRich as generateGeminiRich, generateStream } from "./client";
import { resolveAttachments, uploadTextFile } from "./uploads";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import type { CompletionProvider, CompletionProviderOptions, CompletionRichOptions, CompletionTextInput } from "../completion/ports";
import type { AttachmentPlan } from "../attachments/types";
import { isAbortError, logStage } from "../shared/runtime";
import type { ErrorWithMetadata } from "../shared/types";
import type { GeminiAccountLease } from "./accounts/types";
import type { GeminiAccountRuntime } from "./accounts/runtime";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;

type GeminiClientDelegates = {
  generate: typeof generate;
  generateRich: typeof generateGeminiRich;
  generateStream: typeof generateStream;
};

type GeminiUploadDelegates = {
  resolveAttachments: typeof resolveAttachments;
  uploadTextFile: typeof uploadTextFile;
};

export type GeminiCompletionProviderOptions = {
  accountRuntime?: GeminiAccountRuntime | null;
  client?: Partial<GeminiClientDelegates>;
  uploads?: Partial<GeminiUploadDelegates>;
};

export function createGeminiCompletionProvider(cfg: RuntimeConfig, options: GeminiCompletionProviderOptions = {}): CompletionProvider {
  const runtime = options.accountRuntime || null;
  const client: GeminiClientDelegates = {
    generate: options.client?.generate || generate,
    generateRich: options.client?.generateRich || generateGeminiRich,
    generateStream: options.client?.generateStream || generateStream,
  };
  const uploadDelegates: GeminiUploadDelegates = {
    resolveAttachments: options.uploads?.resolveAttachments || resolveAttachments,
    uploadTextFile: options.uploads?.uploadTextFile || uploadTextFile,
  };
  let leasePromise: Promise<GeminiAccountLease | null> | null = null;
  let lease: GeminiAccountLease | null = null;
  let terminal = false;

  const acquireConfig = async (): Promise<RuntimeConfig> => {
    if (!runtime) return cfg;
    if (!leasePromise) {
      leasePromise = runtime.acquireLease(cfg).then((selected) => {
        if (!selected) throw noAvailableAccountError();
        lease = selected;
        return selected;
      });
    }
    const selected = await leasePromise;
    if (!selected) throw noAvailableAccountError();
    return selected.config;
  };

  const releaseLease = (): void => {
    if (lease) lease.release();
    lease = null;
    leasePromise = null;
  };

  const markFailureAndRelease = async (error: unknown): Promise<void> => {
    const selected = lease;
    try {
      if (selected && !isAbortError(error)) await selected.markFailure(error);
    } finally {
      releaseLease();
      terminal = true;
    }
  };

  const markSuccessAndRelease = async (): Promise<void> => {
    const selected = lease;
    try {
      if (selected) await selected.markSuccess();
    } finally {
      releaseLease();
      terminal = true;
    }
  };

  const withGenerationLease = async <T>(fn: (activeCfg: RuntimeConfig) => Promise<T>): Promise<T> => {
    const activeCfg = await acquireConfig();
    try {
      const result = await fn(activeCfg);
      await markSuccessAndRelease();
      return result;
    } catch (error) {
      await markFailureAndRelease(error);
      throw error;
    }
  };

  const withUploadLease = async <T>(fn: (activeCfg: RuntimeConfig) => Promise<T>): Promise<T> => {
    const activeCfg = await acquireConfig();
    try {
      return await fn(activeCfg);
    } catch (error) {
      await markFailureAndRelease(error);
      throw error;
    }
  };

  return {
    supportsAuthenticatedSession: !!(cfg.cookie || runtime),
    generateText(input: CompletionTextInput) {
      const model = requireResolvedModel(input.rm);
      if (cfg.log_requests) logGeminiRoute(cfg, model, false);
      return withGenerationLease((activeCfg) => client.generate(activeCfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, model.modelHeaders));
    },
    generateRich(input: CompletionTextInput, options: CompletionRichOptions = {}) {
      const model = requireResolvedModel(input.rm);
      if (cfg.log_requests) logGeminiRoute(cfg, model, false);
      return withGenerationLease((activeCfg) => client.generateRich(activeCfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, model.modelHeaders, options));
    },
    async *streamText(input: CompletionTextInput, options: CompletionProviderOptions = {}) {
      const model = requireResolvedModel(input.rm);
      if (cfg.log_requests) logGeminiRoute(cfg, model, true);
      const activeCfg = await acquireConfig();
      try {
        for await (const delta of client.generateStream(activeCfg, input.prompt, model.modeId, model.thinkMode, model.extra, input.fileRefs, options, model.modelHeaders)) {
          const text = String(delta || "");
          if (text) yield text;
        }
        await markSuccessAndRelease();
      } catch (error) {
        await markFailureAndRelease(error);
        throw error;
      }
    },
    resolveAttachments(plan: AttachmentPlan) {
      return withUploadLease((activeCfg) => uploadDelegates.resolveAttachments(activeCfg, plan));
    },
    uploadTextFile(text: string, filename: string) {
      return withUploadLease((activeCfg) => uploadDelegates.uploadTextFile(activeCfg, text, filename));
    },
    dispose() {
      if (terminal) return;
      releaseLease();
      terminal = true;
    },
  };
}

function noAvailableAccountError(): ErrorWithMetadata {
  const err: ErrorWithMetadata = new Error("no available Gemini account");
  err.code = "no_available_gemini_account";
  err.status = 503;
  return err;
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
