import {
	generate,
	generateRich as generateGeminiRich,
	generateStream,
} from "./client";
import { resolveAttachments, uploadTextFile } from "./uploads";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import type {
	CompletionProvider,
	CompletionProviderOptions,
	CompletionRichOptions,
	CompletionTextInput,
} from "../completion/ports";
import {
	geminiAuthenticatedSessionRequiredError,
	type GeminiAuthenticatedSessionReason,
} from "../shared/errors";
import type { AttachmentPlan } from "../attachments/types";
import { errorLogSummary } from "../shared/errors";
import { isAbortError } from "../shared/abort";
import { log, logStage } from "../shared/logging";
import { promptByteLengthGreaterThan } from "../shared/tokens";
import type { ErrorWithMetadata } from "../shared/types";
import type { GeminiAccountLease } from "./accounts/types";
import type { GeminiAccountRuntime } from "./accounts/runtime";
import { upstreamEmptyResponseError } from "./client/errors";

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

export function createGeminiCompletionProvider(
	cfg: RuntimeConfig,
	providerOptions: GeminiCompletionProviderOptions = {},
): CompletionProvider {
	const runtime = providerOptions.accountRuntime || null;
	const anonymousCfg: RuntimeConfig = { ...cfg, cookie: "", sapisid: "" };
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
	let leasePromise: Promise<GeminiAccountLease | null> | null = null;
	let lease: GeminiAccountLease | null = null;
	let terminal = false;

	const acquireAccountConfig = async (
		reason: GeminiAuthenticatedSessionReason,
	): Promise<RuntimeConfig> => {
		if (!runtime) throw geminiAuthenticatedSessionRequiredError(reason);
		if (!leasePromise) {
			leasePromise = runtime.acquireLease(cfg).then((acquiredLease) => {
				if (!acquiredLease) throw noAvailableAccountError();
				lease = acquiredLease;
				return acquiredLease;
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

	const finalizeOutcome = async (
		kind: "success" | "failure",
		error?: unknown,
	): Promise<void> => {
		const selected = lease;
		const persistence = selected
			? kind === "success"
				? selected.markSuccess()
				: error !== undefined && !isAbortError(error)
					? selected.markFailure(error)
					: null
			: null;
		releaseLease();
		terminal = true;
		if (!persistence) return;
		const guarded = persistence.catch((persistenceError: unknown) => {
			log(
				cfg,
				`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
			);
		});
		if (cfg.execution_ctx) {
			try {
				cfg.execution_ctx.waitUntil(guarded);
			} catch (registrationError) {
				log(
					cfg,
					`account outcome waitUntil registration failed: ${errorLogSummary(registrationError)}`,
				);
			}
			return;
		}
		await guarded;
	};

	const withGenerationLease = async <T>(
		fn: (activeCfg: RuntimeConfig) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
	): Promise<T> => {
		const activeCfg = await acquireAccountConfig(reason);
		try {
			const result = await fn(activeCfg);
			await finalizeOutcome("success");
			return result;
		} catch (error) {
			await finalizeOutcome("failure", error);
			throw error;
		}
	};

	const withUploadLease = async <T>(
		fn: (activeCfg: RuntimeConfig) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
	): Promise<T> => {
		const activeCfg = await acquireAccountConfig(reason);
		try {
			return await fn(activeCfg);
		} catch (error) {
			await finalizeOutcome("failure", error);
			throw error;
		}
	};

	const withAnonymousFallback = async <T>(
		anonymousCall: (activeCfg: RuntimeConfig) => Promise<T>,
		accountCall: (activeCfg: RuntimeConfig) => Promise<T>,
	): Promise<T> => {
		let anonymousError: unknown;
		try {
			const result = await anonymousCall(anonymousCfg);
			terminal = true;
			return result;
		} catch (error) {
			if (isAbortError(error)) {
				terminal = true;
				throw error;
			}
			anonymousError = error;
		}

		let activeCfg: RuntimeConfig;
		try {
			activeCfg = await acquireAccountConfig("attachment");
		} catch (_) {
			releaseLease();
			terminal = true;
			throw anonymousError;
		}
		try {
			const result = await accountCall(activeCfg);
			await finalizeOutcome("success");
			return result;
		} catch (error) {
			await finalizeOutcome("failure", error);
			throw error;
		}
	};

	return {
		supportsAuthenticatedSession: !!(
			runtime || cfg.supports_authenticated_session
		),
		generateText(input: CompletionTextInput) {
			const model = requireResolvedModel(input.rm);
			if (cfg.log_requests) logGeminiRoute(cfg, model, false);
			const call = async (activeCfg: RuntimeConfig): Promise<string> => {
				const text = await client.generate(
					activeCfg,
					input.prompt,
					model.modeId,
					model.thinkMode,
					model.extra,
					input.fileRefs,
					model.modelHeaders,
				);
				if (!text) throw upstreamEmptyResponseError(502, 0, "provider");
				return text;
			};
			const requiredReason = accountRequiredReason(
				cfg,
				model,
				input,
				leasePromise !== null,
			);
			if (requiredReason) return withGenerationLease(call, requiredReason);
			return withAnonymousFallback(call, call);
		},
		generateRich(
			input: CompletionTextInput,
			richOptions: CompletionRichOptions = {},
		) {
			const model = requireResolvedModel(input.rm);
			if (cfg.log_requests) logGeminiRoute(cfg, model, false);
			return withGenerationLease(
				(activeCfg) =>
					client.generateRich(
						activeCfg,
						input.prompt,
						model.modeId,
						model.thinkMode,
						model.extra,
						input.fileRefs,
						model.modelHeaders,
						richOptions,
					),
				"image",
			);
		},
		async *streamText(
			input: CompletionTextInput,
			streamOptions: CompletionProviderOptions = {},
		) {
			const model = requireResolvedModel(input.rm);
			if (cfg.log_requests) logGeminiRoute(cfg, model, true);
			const stream = (streamCfg: RuntimeConfig) =>
				client.generateStream(
					streamCfg,
					input.prompt,
					model.modeId,
					model.thinkMode,
					model.extra,
					input.fileRefs,
					streamOptions,
					model.modelHeaders,
				);
			const requiredReason = accountRequiredReason(
				cfg,
				model,
				input,
				leasePromise !== null,
			);
			if (requiredReason) {
				const activeCfg = await acquireAccountConfig(requiredReason);
				try {
					for await (const delta of stream(activeCfg)) {
						const text = String(delta || "");
						if (text) yield text;
					}
					await finalizeOutcome("success");
				} catch (error) {
					await finalizeOutcome("failure", error);
					throw error;
				}
				return;
			}

			let emitted = false;
			let anonymousError: unknown;
			try {
				for await (const delta of stream(anonymousCfg)) {
					const text = String(delta || "");
					if (!text) continue;
					emitted = true;
					yield text;
				}
				if (!emitted)
					throw upstreamEmptyResponseError(502, 0, "provider stream");
				terminal = true;
				return;
			} catch (error) {
				if (isAbortError(error) || emitted) {
					terminal = true;
					throw error;
				}
				anonymousError = error;
			}

			let activeCfg: RuntimeConfig;
			try {
				activeCfg = await acquireAccountConfig("attachment");
			} catch (_) {
				releaseLease();
				terminal = true;
				throw anonymousError;
			}
			try {
				for await (const delta of stream(activeCfg)) {
					const text = String(delta || "");
					if (text) yield text;
				}
				await finalizeOutcome("success");
			} catch (error) {
				await finalizeOutcome("failure", error);
				throw error;
			}
		},
		resolveAttachments(plan: AttachmentPlan) {
			if (
				!leasePromise &&
				!plan.candidates.length &&
				!plan.existingFileRefs?.length
			)
				return uploadDelegates.resolveAttachments(anonymousCfg, plan);
			return withUploadLease(
				(activeCfg) => uploadDelegates.resolveAttachments(activeCfg, plan),
				"attachment",
			);
		},
		uploadTextFile(text: string, filename: string) {
			return withUploadLease(
				(activeCfg) =>
					uploadDelegates.uploadTextFile(activeCfg, text, filename),
				"large_context",
			);
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
	if (model.modeId === 3) return "pro_model";
	if (
		promptByteLengthGreaterThan(input.prompt, cfg.current_input_file_min_bytes)
	)
		return "large_context";
	return null;
}

function logGeminiRoute(
	cfg: RuntimeConfig,
	model: ResolvedModelOK,
	stream: boolean,
): void {
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
