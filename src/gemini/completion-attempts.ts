import type { CompletionTextInput } from "../completion/ports";
import type { RuntimeConfig } from "../config";
import type { ResolvedModel } from "../models";
import { isAbortError } from "../shared/abort";
import {
	errorLogSummary,
	type GeminiAuthenticatedSessionReason,
	geminiAuthenticatedSessionRequiredError,
} from "../shared/errors";
import { log } from "../shared/logging";
import type { ErrorWithMetadata } from "../shared/types";
import { classifyGeminiAccountOutcome } from "./accounts/classify";
import { capabilityFreshAfterMs } from "./accounts/freshness";
import type { GeminiAccountLease } from "./accounts/lease-types";
import { basicRouteForFamily } from "./accounts/routes";
import type { GeminiAccountRuntime } from "./accounts/runtime";
import type { GeminiAccountRouteRequirement } from "./accounts/runtime-types";
import type { UploadReplayState } from "./upload-replay";

type ResolvedModelOK = Extract<ResolvedModel, { name: string }>;
export type RecoveryResult = { retry: true } | { retry: false; error: unknown };

export class GeminiAccountAttemptOrchestrator {
	private leasePromise: Promise<GeminiAccountLease | null> | null = null;
	private lease: GeminiAccountLease | null = null;
	private accountAttempts = 0;
	private disposed = false;
	private activeRouteRequirement: GeminiAccountRouteRequirement | null = null;
	private activeResolvedModelName = "";
	private activeResolvedModel: ResolvedModelOK | null = null;
	private activeRoutingPrepared = false;
	private readonly attemptedAccountIds = new Set<string>();
	private readonly refreshedAccountIds = new Set<string>();

	constructor(
		private readonly cfg: RuntimeConfig,
		private readonly runtime: GeminiAccountRuntime | null,
		private readonly uploads: UploadReplayState,
	) {}

	get currentLease(): GeminiAccountLease | null {
		return this.lease;
	}

	get hasLeasePromise(): boolean {
		return this.leasePromise !== null;
	}

	setResolvedModel(model: ResolvedModelOK): void {
		this.activeResolvedModel = model;
		this.activeResolvedModelName = model.name;
		this.activeRoutingPrepared = false;
		this.activeRouteRequirement = null;
	}

	activateResolvedModel(model: ResolvedModelOK): void {
		this.activeResolvedModel = model;
		this.activeResolvedModelName = model.name;
	}

	async acquireAccountConfig(
		reason: GeminiAuthenticatedSessionReason,
	): Promise<RuntimeConfig> {
		if (!this.runtime) throw geminiAuthenticatedSessionRequiredError(reason);
		if (this.disposed)
			throw new Error("Gemini completion provider is disposed");
		if (this.activeResolvedModel && !this.activeRoutingPrepared)
			await this.ensureModelRouting(this.activeResolvedModel, this.runtime);
		if (!this.leasePromise) {
			if (this.accountAttempts >= accountAttemptLimit(this.cfg))
				throw noAvailableAccountError();
			this.leasePromise = this.runtime
				.acquireLease(this.cfg, {
					excludeAccountIds: this.attemptedAccountIds,
					...(this.activeRouteRequirement
						? { routeRequirement: this.activeRouteRequirement }
						: {}),
					capabilityMode: this.cfg.gemini_account_capability_mode || "prefer",
					capabilityFreshAfterMs: capabilityFreshAfterMs(
						this.cfg.gemini_account_capability_ttl_sec,
						Date.now(),
					),
				})
				.then((acquiredLease) => {
					if (!acquiredLease) throw noAvailableAccountError();
					if (this.attemptedAccountIds.has(acquiredLease.accountId)) {
						acquiredLease.release();
						throw noAvailableAccountError();
					}
					this.accountAttempts += 1;
					this.lease = acquiredLease;
					return acquiredLease;
				});
		}
		let selected: GeminiAccountLease | null;
		try {
			selected = await this.leasePromise;
		} catch (error) {
			this.leasePromise = null;
			throw error;
		}
		if (!selected) throw noAvailableAccountError();
		return selected.config;
	}

	async prepareAuthenticatedGeneration(
		reason: GeminiAuthenticatedSessionReason,
	): Promise<void> {
		await this.uploads.waitForPending();
		await this.acquireAccountConfig(reason);
	}

	async finalizeOutcome(
		kind: "success" | "failure",
		error?: unknown,
	): Promise<void> {
		const selected = this.lease;
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
					this.cfg,
					`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
				);
			}
		}
		const maintenance =
			kind === "success" && selected
				? (persistence
						? this.guardOutcome(persistence)
						: Promise.resolve()
					).then(async () => {
						try {
							await selected.flushObservedCookies();
						} catch (cookieError) {
							log(
								this.cfg,
								`account response cookie writeback failed: ${errorLogSummary(cookieError)}`,
							);
						}
						const intervalSec = Number(
							this.cfg.gemini_account_refresh_interval_sec,
						);
						if (intervalSec > 0)
							await selected.maintainSessionIfStale(intervalSec * 1000);
					})
				: null;
		this.releaseLease();
		this.resetAttemptState();
		if (maintenance) {
			const guardedMaintenance = maintenance.catch((maintenanceError) => {
				log(
					this.cfg,
					`opportunistic account refresh failed: ${errorLogSummary(maintenanceError)}`,
				);
			});
			if (this.cfg.execution_ctx) {
				try {
					this.cfg.execution_ctx.waitUntil(guardedMaintenance);
				} catch (registrationError) {
					log(
						this.cfg,
						`account maintenance waitUntil registration failed: ${errorLogSummary(registrationError)}`,
					);
				}
				return;
			}
			await guardedMaintenance;
			return;
		}
		if (!persistence) return;
		const guarded = this.guardOutcome(persistence);
		if (this.cfg.execution_ctx) {
			try {
				this.cfg.execution_ctx.waitUntil(guarded);
			} catch (registrationError) {
				log(
					this.cfg,
					`account outcome waitUntil registration failed: ${errorLogSummary(registrationError)}`,
				);
			}
			return;
		}
		await guarded;
	}

	async recoverAccount(
		initialError: unknown,
		allowAccountSwitch: boolean,
	): Promise<RecoveryResult> {
		let error = initialError;
		while (this.lease) {
			if (isAbortError(error)) return { retry: false, error };
			const outcome = classifyGeminiAccountOutcome(error, Date.now());
			const recoveryScope =
				outcome.recoveryScope ?? (outcome.issue ? "try_next_account" : "none");
			if (recoveryScope === "none") return { retry: false, error };

			const selected = this.lease;
			if (
				outcome.issue === "auth" &&
				!this.refreshedAccountIds.has(selected.accountId)
			) {
				this.refreshedAccountIds.add(selected.accountId);
				try {
					const refreshed = await selected.refreshForRetry("auth");
					if (refreshed.changed) return { retry: true };
				} catch (refreshError) {
					log(
						this.cfg,
						`account credential refresh failed: ${errorLogSummary(refreshError)}`,
					);
				}
			}

			if (
				recoveryScope !== "try_next_account" ||
				!allowAccountSwitch ||
				this.accountAttempts >= accountAttemptLimit(this.cfg)
			)
				return { retry: false, error };

			await this.retireLease(error);
			try {
				await this.acquireAccountConfig("attachment");
			} catch (_) {
				return { retry: false, error };
			}
			try {
				const activeCfg = this.lease?.config;
				if (!activeCfg) throw noAvailableAccountError();
				await this.uploads.replay(activeCfg);
				return { retry: true };
			} catch (replayError) {
				error = replayError;
			}
		}
		return { retry: false, error };
	}

	async withGeneration<T>(
		fn: (
			activeCfg: RuntimeConfig,
			activeInput: CompletionTextInput,
		) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
		input: CompletionTextInput,
	): Promise<T> {
		await this.prepareAuthenticatedGeneration(reason);
		while (this.lease) {
			try {
				const result = await fn(
					this.lease.config,
					this.uploads.remapInput(input),
				);
				await this.finalizeOutcome("success");
				return result;
			} catch (error) {
				const recovery = await this.recoverAccount(
					error,
					!this.uploads.hasOpaqueRefs(input),
				);
				if (recovery.retry) continue;
				await this.finalizeOutcome("failure", recovery.error);
				throw recovery.error;
			}
		}
		throw noAvailableAccountError();
	}

	async *streamGeneration(
		fn: (
			activeCfg: RuntimeConfig,
			activeInput: CompletionTextInput,
		) => AsyncIterable<string>,
		reason: GeminiAuthenticatedSessionReason,
		input: CompletionTextInput,
		prepared = false,
	): AsyncGenerator<string> {
		let finalized = false;
		try {
			if (!prepared) await this.prepareAuthenticatedGeneration(reason);
			while (this.lease) {
				let emitted = false;
				try {
					for await (const delta of fn(
						this.lease.config,
						this.uploads.remapInput(input),
					)) {
						const text = String(delta || "");
						if (!text) continue;
						emitted = true;
						yield text;
					}
					await this.finalizeOutcome("success");
					finalized = true;
					return;
				} catch (error) {
					if (emitted) {
						await this.finalizeOutcome("failure", error);
						finalized = true;
						throw error;
					}
					const recovery = await this.recoverAccount(
						error,
						!this.uploads.hasOpaqueRefs(input),
					);
					if (recovery.retry) continue;
					await this.finalizeOutcome("failure", recovery.error);
					finalized = true;
					throw recovery.error;
				}
			}
			throw noAvailableAccountError();
		} finally {
			if (!finalized && this.lease) {
				this.releaseLease();
				this.resetAttemptState();
			}
		}
	}

	withUpload<T>(
		fn: (activeCfg: RuntimeConfig) => Promise<T>,
		reason: GeminiAuthenticatedSessionReason,
		record: (result: T) => void,
	): Promise<T> {
		return this.uploads.serialize(async () => {
			await this.acquireAccountConfig(reason);
			while (this.lease) {
				try {
					const result = await fn(this.lease.config);
					record(result);
					return result;
				} catch (error) {
					const recovery = await this.recoverAccount(error, true);
					if (recovery.retry) continue;
					await this.finalizeOutcome("failure", recovery.error);
					throw recovery.error;
				}
			}
			throw noAvailableAccountError();
		});
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		try {
			await this.leasePromise;
		} catch (_) {
			// Acquisition failure has no lease to release.
		}
		this.releaseLease();
		this.resetAttemptState();
	}

	private async ensureModelRouting(
		model: ResolvedModelOK,
		accountRuntime: GeminiAccountRuntime,
	): Promise<void> {
		if (
			this.activeRoutingPrepared &&
			this.activeResolvedModelName === model.name
		)
			return;
		const candidates = await accountRuntime.routeCandidatesForModel(
			model,
			capabilityFreshAfterMs(
				this.cfg.gemini_account_capability_ttl_sec,
				Date.now(),
			),
		);
		this.activeRouteRequirement = {
			candidates,
			fallbackRoute: model.family ? basicRouteForFamily(model.family) : null,
		};
		this.activeResolvedModelName = model.name;
		this.activeResolvedModel = model;
		this.activeRoutingPrepared = true;
	}

	private guardOutcome(persistence: Promise<void>): Promise<void> {
		return persistence.catch((persistenceError: unknown) => {
			log(
				this.cfg,
				`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
			);
		});
	}

	private async retireLease(error: unknown): Promise<void> {
		const selected = this.lease;
		if (!selected) return;
		this.attemptedAccountIds.add(selected.accountId);
		try {
			await this.guardOutcome(selected.markFailure(error));
		} catch (persistenceError) {
			log(
				this.cfg,
				`account outcome persistence failed: ${errorLogSummary(persistenceError)}`,
			);
		}
		this.releaseLease();
	}

	private releaseLease(): void {
		if (this.lease) this.lease.release();
		this.lease = null;
		this.leasePromise = null;
	}

	private resetAttemptState(): void {
		this.accountAttempts = 0;
		this.attemptedAccountIds.clear();
		this.refreshedAccountIds.clear();
		this.uploads.reset();
		this.activeRouteRequirement = null;
		this.activeResolvedModelName = "";
		this.activeResolvedModel = null;
		this.activeRoutingPrepared = false;
	}
}

export function noAvailableAccountError(): ErrorWithMetadata {
	const error: ErrorWithMetadata = new Error("no available Gemini account");
	error.code = "no_available_gemini_account";
	error.status = 503;
	return error;
}

function accountAttemptLimit(cfg: RuntimeConfig): number {
	const value = Number(cfg.gemini_account_max_attempts);
	return Number.isSafeInteger(value) && value > 0 ? value : 10;
}
