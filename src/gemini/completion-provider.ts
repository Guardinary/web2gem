import type {
	AttachmentFileRef,
	AttachmentPlan,
	AttachmentUploadResult,
} from "../attachments/types";
import type {
	CompletionProvider,
	CompletionProviderOptions,
	CompletionRichOptions,
	CompletionTextInput,
} from "../completion/ports";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import { resolveModel as resolveStaticModel } from "../models";
import { isAbortError } from "../shared/abort";
import { uuid } from "../shared/crypto";
import type { GeminiAuthenticatedSessionReason } from "../shared/errors";
import { promptByteLengthGreaterThan } from "../shared/text-metrics";
import type { GeminiAccountRuntime } from "./accounts/runtime";
import { buildGeminiModelHeaders } from "./client/model-headers";
import {
	generate,
	generateRich as generateGeminiRich,
	generateStream,
} from "./client";
import { upstreamEmptyResponseError } from "./client/errors";
import {
	capabilityFreshAfterMs,
	GeminiAccountAttemptOrchestrator,
} from "./completion-attempts";
import { logGeminiRoute, routeForModelAndLease } from "./completion-routing";
import { resolveAttachments, uploadTextFile } from "./uploads";
import { type GeminiUploadDelegates, UploadReplayState } from "./upload-replay";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;
type GeminiClientDelegates = {
	generate: typeof generate;
	generateRich: typeof generateGeminiRich;
	generateStream: typeof generateStream;
};

export type GeminiCompletionProviderOptions = {
	accountRuntime?: GeminiAccountRuntime | null;
	client?: Partial<GeminiClientDelegates>;
	uploads?: Partial<GeminiUploadDelegates>;
};

export function createGeminiCompletionProvider(
	cfg: RuntimeConfig,
	providerOptions: GeminiCompletionProviderOptions = {},
): CompletionProvider {
	const runtime = providerOptions.accountRuntime || null;
	const anonymousCfg: RuntimeConfig = { ...cfg, cookie: "", sapisid: "" };
	const providerSessionId = uuid().toUpperCase();
	const client: GeminiClientDelegates = {
		generate: providerOptions.client?.generate || generate,
		generateRich: providerOptions.client?.generateRich || generateGeminiRich,
		generateStream: providerOptions.client?.generateStream || generateStream,
	};
	const uploadDelegates: GeminiUploadDelegates = {
		resolveAttachments:
			providerOptions.uploads?.resolveAttachments || resolveAttachments,
		uploadTextFile: providerOptions.uploads?.uploadTextFile || uploadTextFile,
	};
	const uploads = new UploadReplayState(uploadDelegates);
	const attempts = new GeminiAccountAttemptOrchestrator(cfg, runtime, uploads);

	const withAnonymousFallback = async <T>(
		anonymousCall: (activeCfg: RuntimeConfig) => Promise<T>,
		accountCall: (
			activeCfg: RuntimeConfig,
			activeInput: CompletionTextInput,
		) => Promise<T>,
		input: CompletionTextInput,
	): Promise<T> => {
		let anonymousError: unknown;
		try {
			return await anonymousCall(anonymousCfg);
		} catch (error) {
			if (isAbortError(error)) throw error;
			anonymousError = error;
		}
		let acquiredAccount = false;
		try {
			await attempts.acquireAccountConfig("attachment");
			acquiredAccount = true;
			return await attempts.withGeneration(accountCall, "attachment", input);
		} catch (error) {
			if (!acquiredAccount) throw anonymousError;
			throw error;
		}
	};

	return {
		supportsAuthenticatedSession: !!(
			runtime || cfg.supports_authenticated_session
		),
		async resolveModel(name: unknown, defaultName: unknown) {
			const staticResolved = resolveStaticModel(name, defaultName);
			const resolved =
				staticResolved.name !== undefined || !runtime
					? staticResolved
					: await runtime.resolveModel(
							name,
							defaultName,
							capabilityFreshAfterMs(cfg),
						);
			if (resolved.name !== undefined) attempts.setResolvedModel(resolved);
			return resolved;
		},
		async generateText(input: CompletionTextInput) {
			const model = requireResolvedModel(input.rm);
			attempts.activateResolvedModel(model);
			if (cfg.log_requests) logGeminiRoute(cfg, model, false);
			const call = async (
				activeCfg: RuntimeConfig,
				activeInput: CompletionTextInput,
			): Promise<string> => {
				const route = routeForModelAndLease(model, attempts.currentLease);
				const text = await client.generate(
					activeCfg,
					activeInput.prompt,
					route.modelNumber,
					model.extended,
					activeInput.fileRefs,
					activeCfg.gemini_account
						? buildGeminiModelHeaders(route, model.extended, providerSessionId)
						: null,
				);
				if (!text) throw upstreamEmptyResponseError(502, 0, "provider");
				return text;
			};
			const reason = accountRequiredReason(
				cfg,
				model,
				input,
				attempts.hasLeasePromise,
			);
			if (reason) return attempts.withGeneration(call, reason, input);
			return withAnonymousFallback(
				(activeCfg) => call(activeCfg, input),
				call,
				input,
			);
		},
		async generateRich(
			input: CompletionTextInput,
			richOptions: CompletionRichOptions = {},
		) {
			const model = requireResolvedModel(input.rm);
			attempts.activateResolvedModel(model);
			if (cfg.log_requests) logGeminiRoute(cfg, model, false);
			return attempts.withGeneration(
				(activeCfg, activeInput) => {
					const route = routeForModelAndLease(model, attempts.currentLease);
					return client.generateRich(
						activeCfg,
						activeInput.prompt,
						route.modelNumber,
						model.extended,
						activeInput.fileRefs,
						buildGeminiModelHeaders(route, model.extended, providerSessionId),
						richOptions,
					);
				},
				"image",
				input,
			);
		},
		async *streamText(
			input: CompletionTextInput,
			streamOptions: CompletionProviderOptions = {},
		) {
			const model = requireResolvedModel(input.rm);
			attempts.activateResolvedModel(model);
			if (cfg.log_requests) logGeminiRoute(cfg, model, true);
			const stream = (
				streamCfg: RuntimeConfig,
				activeInput: CompletionTextInput,
			) => {
				const route = routeForModelAndLease(model, attempts.currentLease);
				return client.generateStream(
					streamCfg,
					activeInput.prompt,
					route.modelNumber,
					model.extended,
					activeInput.fileRefs,
					streamOptions,
					streamCfg.gemini_account
						? buildGeminiModelHeaders(route, model.extended, providerSessionId)
						: null,
				);
			};
			const reason = accountRequiredReason(
				cfg,
				model,
				input,
				attempts.hasLeasePromise,
			);
			if (reason) {
				yield* attempts.streamGeneration(stream, reason, input);
				return;
			}

			let emitted = false;
			let anonymousError: unknown;
			try {
				for await (const delta of stream(anonymousCfg, input)) {
					const text = String(delta || "");
					if (!text) continue;
					emitted = true;
					yield text;
				}
				if (!emitted)
					throw upstreamEmptyResponseError(502, 0, "provider stream");
				return;
			} catch (error) {
				if (isAbortError(error) || emitted) throw error;
				anonymousError = error;
			}
			try {
				await attempts.acquireAccountConfig("attachment");
			} catch (_) {
				throw anonymousError;
			}
			yield* attempts.streamGeneration(stream, "attachment", input, true);
		},
		resolveAttachments(plan: AttachmentPlan) {
			if (
				!attempts.hasLeasePromise &&
				!plan.candidates.length &&
				!plan.existingFileRefs?.length
			)
				return uploadDelegates.resolveAttachments(anonymousCfg, plan);
			return attempts.withUpload(
				(activeCfg) => uploadDelegates.resolveAttachments(activeCfg, plan),
				"attachment",
				(result: AttachmentUploadResult) =>
					uploads.recordAttachments(plan, result),
			);
		},
		uploadTextFile(text: string, filename: string) {
			return attempts.withUpload(
				(activeCfg) =>
					uploadDelegates.uploadTextFile(activeCfg, text, filename),
				"large_context",
				(ref: AttachmentFileRef) => uploads.recordText(text, filename, ref),
			);
		},
		dispose: () => attempts.dispose(),
	};
}

function requireResolvedModel(rm: ResolvedModel): ResolvedModelOK {
	if (rm.name === undefined)
		throw new Error(rm.error || "model is not resolved");
	return rm;
}

function accountRequiredReason(
	cfg: RuntimeConfig,
	model: ResolvedModelOK,
	input: CompletionTextInput,
	hasLease: boolean,
): GeminiAuthenticatedSessionReason | null {
	if (hasLease || input.fileRefs?.length) return "attachment";
	if (model.family !== "flash") return "pro_model";
	if (
		promptByteLengthGreaterThan(input.prompt, cfg.current_input_file_min_bytes)
	)
		return "large_context";
	return null;
}
