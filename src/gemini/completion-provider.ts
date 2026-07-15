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
import {
	basicRouteForFamily,
	buildGeminiModelHeaders,
	type GeminiRouteTuple,
	type ResolvedModel,
	resolveModel as resolveStaticModel,
} from "../models";
import { isAbortError } from "../shared/abort";
import { uuid } from "../shared/crypto";
import {
	errorLogSummary,
	type GeminiAuthenticatedSessionReason,
	geminiAuthenticatedSessionRequiredError,
} from "../shared/errors";
import { log, logStage } from "../shared/logging";
import { promptByteLengthGreaterThan } from "../shared/tokens";
import type { ErrorWithMetadata } from "../shared/types";
import { classifyGeminiAccountOutcome } from "./accounts/classify";
import type { GeminiAccountRuntime } from "./accounts/runtime";
import type { GeminiAccountLease } from "./accounts/types";
import {
	generate,
	generateRich as generateGeminiRich,
	generateStream,
} from "./client";
import { upstreamEmptyResponseError } from "./client/errors";
import { resolveAttachments, uploadTextFile } from "./uploads";

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

type UploadRecipe =
	| {
			kind: "attachments";
			plan: AttachmentPlan;
			currentRefs: AttachmentFileRef[];
	  }
	| {
			kind: "text";
			text: string;
			filename: string;
			currentRef: AttachmentFileRef;
	  };

type RecoveryResult = { retry: true } | { retry: false; error: unknown };

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
	let leasePromise: Promise<GeminiAccountLease | null> | null = null;
	let lease: GeminiAccountLease | null = null;
	let accountAttempts = 0;
	let disposed = false;
	let uploadQueue: Promise<void> = Promise.resolve();
	let activeRouteCandidates: GeminiRouteTuple[] = [];
	let activeResolvedModelName = "";
	let activeResolvedModel: ResolvedModelOK | null = null;
	let activeRoutingPrepared = false;
	const attemptedAccountIds = new Set<string>();
	const refreshedAccountIds = new Set<string>();
	const uploadRecipes: UploadRecipe[] = [];
	const refAliases = new Map<string, AttachmentFileRef>();

	const acquireAccountConfig = async (
		reason: GeminiAuthenticatedSessionReason,
	): Promise<RuntimeConfig> => {
		if (!runtime) throw geminiAuthenticatedSessionRequiredError(reason);
		if (disposed) throw new Error("Gemini completion provider is disposed");
		if (activeResolvedModel && !activeRoutingPrepared)
			await ensureModelRouting(activeResolvedModel);
		if (!leasePromise) {
			if (accountAttempts >= accountAttemptLimit(cfg))
				throw noAvailableAccountError();
			leasePromise = runtime
				.acquireLease(cfg, {
					excludeAccountIds: attemptedAccountIds,
					...(activeRoutingPrepared
						? { routeCandidates: activeRouteCandidates }
						: {}),
					capabilityMode: cfg.gemini_account_capability_mode || "prefer",
					capabilityFreshAfterMs: capabilityFreshAfterMs(cfg),
				})
				.then((acquiredLease) => {
					if (!acquiredLease) throw noAvailableAccountError();
					if (attemptedAccountIds.has(acquiredLease.accountId)) {
						acquiredLease.release();
						throw noAvailableAccountError();
					}
					accountAttempts += 1;
					lease = acquiredLease;
					return acquiredLease;
				});
		}
		let selected: GeminiAccountLease | null;
		try {
			selected = await leasePromise;
		} catch (error) {
			leasePromise = null;
			throw error;
		}
		if (!selected) throw noAvailableAccountError();
		return selected.config;
	};

	const releaseLease = (): void => {
		if (lease) lease.release();
		lease = null;
		leasePromise = null;
	};

	const resetAttemptState = (): void => {
		accountAttempts = 0;
		attemptedAccountIds.clear();
		refreshedAccountIds.clear();
		uploadRecipes.length = 0;
		refAliases.clear();
		activeRouteCandidates = [];
		activeResolvedModelName = "";
		activeResolvedModel = null;
		activeRoutingPrepared = false;
	};

	const guardOutcome = (persistence: Promise<void>): Promise<void> =>
		persistence.catch((persistenceError: unknown) => {
			log(
				cfg,
				`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
			);
		});

	const ensureModelRouting = async (model: ResolvedModelOK): Promise<void> => {
		if (activeRoutingPrepared && activeResolvedModelName === model.name) return;
		const mode = cfg.gemini_account_capability_mode || "prefer";
		activeRouteCandidates = runtime
			? await runtime.routeCandidatesForModel(
					model,
					capabilityFreshAfterMs(cfg),
					mode,
				)
			: [routeForModel(model)];
		activeResolvedModelName = model.name;
		activeResolvedModel = model;
		activeRoutingPrepared = true;
	};

	const finalizeOutcome = async (
		kind: "success" | "failure",
		error?: unknown,
	): Promise<void> => {
		const selected = lease;
		let persistence: Promise<void> | null = null;
		if (selected) {
			try {
				persistence =
					kind === "success"
						? selected.markSuccess()
						: error !== undefined && !isAbortError(error)
							? selected.markFailure(error)
							: null;
			} catch (persistenceError) {
				log(
					cfg,
					`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
				);
			}
		}
		const maintenance =
			kind === "success" && selected
				? (persistence ? guardOutcome(persistence) : Promise.resolve()).then(
						async () => {
							try {
								await selected.flushObservedCookies();
							} catch (cookieError) {
								log(
									cfg,
									`account response cookie writeback failed: ${errorLogSummary(cookieError)}`,
								);
							}
							const intervalSec = Number(
								cfg.gemini_account_refresh_interval_sec,
							);
							if (intervalSec > 0)
								await selected.maintainSessionIfStale(intervalSec * 1000);
						},
					)
				: null;
		releaseLease();
		resetAttemptState();
		if (maintenance) {
			const guardedMaintenance = maintenance.catch((maintenanceError) => {
				log(
					cfg,
					`opportunistic account refresh failed: ${errorLogSummary(maintenanceError)}`,
				);
			});
			if (cfg.execution_ctx) {
				try {
					cfg.execution_ctx.waitUntil(guardedMaintenance);
				} catch (registrationError) {
					log(
						cfg,
						`account maintenance waitUntil registration failed: ${errorLogSummary(registrationError)}`,
					);
				}
				return;
			}
			await guardedMaintenance;
			return;
		}
		if (!persistence) return;
		const guarded = guardOutcome(persistence);
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

	const retireLease = async (error: unknown): Promise<void> => {
		const selected = lease;
		if (!selected) return;
		attemptedAccountIds.add(selected.accountId);
		try {
			await guardOutcome(selected.markFailure(error));
		} catch (persistenceError) {
			log(
				cfg,
				`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
			);
		}
		releaseLease();
	};

	const replaceAliases = (
		previous: readonly AttachmentFileRef[],
		next: readonly AttachmentFileRef[],
	) => {
		if (previous.length !== next.length)
			throw uploadReplayError(
				"uploaded file reference count changed during account failover",
			);
		for (let index = 0; index < previous.length; index++) {
			const previousRef = previous[index];
			const nextRef = next[index];
			if (previousRef === undefined || nextRef === undefined)
				throw uploadReplayError(
					"uploaded file reference is missing during account failover",
				);
			const previousKey = fileRefKey(previousRef);
			const nextKey = fileRefKey(nextRef);
			if (!previousKey || !nextKey)
				throw uploadReplayError(
					"uploaded file reference is invalid during account failover",
				);
			for (const [alias, current] of refAliases) {
				if (fileRefKey(current) === previousKey) refAliases.set(alias, nextRef);
			}
			refAliases.set(previousKey, nextRef);
			refAliases.set(nextKey, nextRef);
		}
	};

	const replayUploads = async (): Promise<void> => {
		const activeCfg = lease?.config;
		if (!activeCfg) throw noAvailableAccountError();
		for (const recipe of uploadRecipes) {
			if (recipe.kind === "text") {
				const nextRef = await uploadDelegates.uploadTextFile(
					activeCfg,
					recipe.text,
					recipe.filename,
				);
				replaceAliases([recipe.currentRef], [nextRef]);
				recipe.currentRef = nextRef;
				continue;
			}
			const nextResult = await uploadDelegates.resolveAttachments(
				activeCfg,
				recipe.plan,
			);
			const nextRefs = nextResult.fileRefs || [];
			replaceAliases(recipe.currentRefs, nextRefs);
			recipe.currentRefs = [...nextRefs];
		}
	};

	const recoverAccount = async (
		initialError: unknown,
		allowAccountSwitch: boolean,
	): Promise<RecoveryResult> => {
		let error = initialError;
		while (lease) {
			if (isAbortError(error)) return { retry: false, error };
			const outcome = classifyGeminiAccountOutcome(error, Date.now());
			const recoveryScope =
				outcome.recoveryScope ?? (outcome.issue ? "try_next_account" : "none");
			if (recoveryScope === "none") return { retry: false, error };

			const selected = lease;
			if (
				outcome.issue === "auth" &&
				!refreshedAccountIds.has(selected.accountId)
			) {
				refreshedAccountIds.add(selected.accountId);
				try {
					const refreshed = await selected.refreshForRetry("auth");
					if (refreshed.changed) return { retry: true };
				} catch (refreshError) {
					log(
						cfg,
						`account credential refresh failed: ${errorLogSummary(refreshError)}`,
					);
				}
			}

			if (
				recoveryScope !== "try_next_account" ||
				!allowAccountSwitch ||
				accountAttempts >= accountAttemptLimit(cfg)
			)
				return { retry: false, error };

			await retireLease(error);
			try {
				await acquireAccountConfig("attachment");
			} catch (_) {
				return { retry: false, error };
			}
			try {
				await replayUploads();
				return { retry: true };
			} catch (replayError) {
				error = replayError;
			}
		}
		return { retry: false, error };
	};

	const remapInput = (input: CompletionTextInput): CompletionTextInput => {
		if (!input.fileRefs?.length) return input;
		return {
			...input,
			fileRefs: input.fileRefs.map((fileRef) => {
				const key = fileRefKey(fileRef);
				return (key && refAliases.get(key)) || fileRef;
			}),
		};
	};

	const hasOpaqueRefs = (input: CompletionTextInput): boolean =>
		!!input.fileRefs?.some((fileRef) => {
			const key = fileRefKey(fileRef);
			return !key || !refAliases.has(key);
		});

	const withGenerationLease = async <T>(
		fn: (
			activeCfg: RuntimeConfig,
			activeInput: CompletionTextInput,
		) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
		input: CompletionTextInput,
	): Promise<T> => {
		await uploadQueue;
		await acquireAccountConfig(reason);
		while (lease) {
			try {
				const result = await fn(lease.config, remapInput(input));
				await finalizeOutcome("success");
				return result;
			} catch (error) {
				const recovery = await recoverAccount(error, !hasOpaqueRefs(input));
				if (recovery.retry) continue;
				await finalizeOutcome("failure", recovery.error);
				throw recovery.error;
			}
		}
		throw noAvailableAccountError();
	};

	const serializeUpload = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = uploadQueue.then(operation, operation);
		uploadQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const withUploadLease = <T>(
		fn: (activeCfg: RuntimeConfig) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
		record: (result: T) => void,
	): Promise<T> =>
		serializeUpload(async () => {
			await acquireAccountConfig(reason);
			while (lease) {
				try {
					const result = await fn(lease.config);
					record(result);
					return result;
				} catch (error) {
					const recovery = await recoverAccount(error, true);
					if (recovery.retry) continue;
					await finalizeOutcome("failure", recovery.error);
					throw recovery.error;
				}
			}
			throw noAvailableAccountError();
		});

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
			const result = await anonymousCall(anonymousCfg);
			return result;
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			anonymousError = error;
		}

		let acquiredAccount = false;
		try {
			await acquireAccountConfig("attachment");
			acquiredAccount = true;
			return await withGenerationLease(accountCall, "attachment", input);
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
			if (resolved.name !== undefined) {
				activeResolvedModel = resolved;
				activeResolvedModelName = resolved.name;
				activeRoutingPrepared = false;
				activeRouteCandidates = [];
			}
			return resolved;
		},
		async generateText(input: CompletionTextInput) {
			const model = requireResolvedModel(input.rm);
			activeResolvedModel = model;
			activeResolvedModelName = model.name;
			if (cfg.log_requests) logGeminiRoute(cfg, model, false);
			const call = async (
				activeCfg: RuntimeConfig,
				activeInput: CompletionTextInput,
			): Promise<string> => {
				const route = routeForModelAndLease(model, lease);
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
			const requiredReason = accountRequiredReason(
				cfg,
				model,
				input,
				leasePromise !== null,
			);
			if (requiredReason)
				return withGenerationLease(call, requiredReason, input);
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
			activeResolvedModel = model;
			activeResolvedModelName = model.name;
			if (cfg.log_requests) logGeminiRoute(cfg, model, false);
			return withGenerationLease(
				(activeCfg, activeInput) => {
					const route = routeForModelAndLease(model, lease);
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
			activeResolvedModel = model;
			activeResolvedModelName = model.name;
			if (cfg.log_requests) logGeminiRoute(cfg, model, true);
			const stream = (
				streamCfg: RuntimeConfig,
				activeInput: CompletionTextInput,
			) => {
				const route = routeForModelAndLease(model, lease);
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
			const requiredReason = accountRequiredReason(
				cfg,
				model,
				input,
				leasePromise !== null,
			);
			if (requiredReason) {
				await uploadQueue;
				await acquireAccountConfig(requiredReason);
				while (lease) {
					let emitted = false;
					try {
						for await (const delta of stream(lease.config, remapInput(input))) {
							const text = String(delta || "");
							if (!text) continue;
							emitted = true;
							yield text;
						}
						await finalizeOutcome("success");
						return;
					} catch (error) {
						if (emitted) {
							await finalizeOutcome("failure", error);
							throw error;
						}
						const recovery = await recoverAccount(error, !hasOpaqueRefs(input));
						if (recovery.retry) continue;
						await finalizeOutcome("failure", recovery.error);
						throw recovery.error;
					}
				}
				throw noAvailableAccountError();
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
				if (isAbortError(error) || emitted) {
					throw error;
				}
				anonymousError = error;
			}

			try {
				await acquireAccountConfig("attachment");
			} catch (_) {
				throw anonymousError;
			}
			while (lease) {
				let accountEmitted = false;
				try {
					for await (const delta of stream(lease.config, remapInput(input))) {
						const text = String(delta || "");
						if (!text) continue;
						accountEmitted = true;
						yield text;
					}
					await finalizeOutcome("success");
					return;
				} catch (error) {
					if (accountEmitted) {
						await finalizeOutcome("failure", error);
						throw error;
					}
					const recovery = await recoverAccount(error, !hasOpaqueRefs(input));
					if (recovery.retry) continue;
					await finalizeOutcome("failure", recovery.error);
					throw recovery.error;
				}
			}
			throw noAvailableAccountError();
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
				(result: AttachmentUploadResult) => {
					const currentRefs = [...(result.fileRefs || [])];
					for (const ref of currentRefs) {
						const key = fileRefKey(ref);
						if (key) refAliases.set(key, ref);
					}
					uploadRecipes.push({ kind: "attachments", plan, currentRefs });
				},
			);
		},
		uploadTextFile(text: string, filename: string) {
			return withUploadLease(
				(activeCfg) =>
					uploadDelegates.uploadTextFile(activeCfg, text, filename),
				"large_context",
				(ref: AttachmentFileRef) => {
					const key = fileRefKey(ref);
					if (key) refAliases.set(key, ref);
					uploadRecipes.push({ kind: "text", text, filename, currentRef: ref });
				},
			);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			try {
				await leasePromise;
			} catch (_) {
				// Acquisition failure has no lease to release.
			}
			releaseLease();
			resetAttemptState();
		},
	};
}

function fileRefKey(fileRef: AttachmentFileRef): string | null {
	if (typeof fileRef === "string") return fileRef || null;
	const value = fileRef.ref || fileRef.fileRef || fileRef.id;
	return value ? String(value) : null;
}

function uploadReplayError(message: string): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error(message);
	error.code = "gemini_upload_replay_failed";
	error.status = 502;
	return error;
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
	if (model.family !== "flash") return "pro_model";
	if (
		promptByteLengthGreaterThan(input.prompt, cfg.current_input_file_min_bytes)
	)
		return "large_context";
	return null;
}

function accountAttemptLimit(cfg: RuntimeConfig): number {
	const value = Number(cfg.gemini_account_max_attempts);
	return Number.isSafeInteger(value) && value > 0 ? value : 10;
}

function capabilityFreshAfterMs(cfg: RuntimeConfig): number {
	return (
		Date.now() -
		Math.max(Number(cfg.gemini_account_capability_ttl_sec) || 3600, 60) * 1000
	);
}

function logGeminiRoute(
	cfg: RuntimeConfig,
	model: ResolvedModelOK,
	stream: boolean,
): void {
	logStage(cfg, "gemini_route", {
		model: model.name,
		modelFamily: model.family || "dynamic",
		extendedThinking: model.extended,
		dynamicProvider: !!model.dynamicProviderId,
		stream,
	});
}

function routeForModel(model: ResolvedModelOK): GeminiRouteTuple {
	if (model.family) return basicRouteForFamily(model.family);
	throw new Error("model has no Gemini route");
}

function routeForModelAndLease(
	model: ResolvedModelOK,
	lease: GeminiAccountLease | null,
): GeminiRouteTuple {
	if (lease?.selectedRoute) return lease.selectedRoute;
	if (model.dynamicProviderId)
		throw new Error("dynamic Gemini model route was not selected");
	const route = routeForModel(model);
	const capability = lease?.modelCapability;
	if (
		!capability?.available ||
		capability.modelId !== route.providerModelId ||
		(capability.capacityField !== 12 && capability.capacityField !== 13) ||
		(capability.capacity !== 1 &&
			capability.capacity !== 2 &&
			capability.capacity !== 3 &&
			capability.capacity !== 4)
	)
		return route;
	return {
		...route,
		capacity: capability.capacity,
		capacityField: capability.capacityField,
	};
}
