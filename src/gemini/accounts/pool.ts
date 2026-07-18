import type { RuntimeConfig } from "../../config";
import {
	buildGeminiModelCatalog,
	type GeminiModelCatalog,
	type GeminiPublicFamily,
	type ResolvedModel,
	resolveModelFromCatalog,
} from "../../models";
import { uuid } from "../../shared/crypto";
import {
	COOKIE_ROTATE_MIN_INTERVAL_MS,
	mergeSetCookieHeaders,
	parseCookieHeader,
	setCookieHeaders,
} from "../cookies";
import type { GeminiModelRoutingOverview } from "./admin-types";
import { classifyGeminiAccountOutcome } from "./classify";
import { createAccountRuntimeConfig, PoolLease } from "./lease";
import type {
	GeminiAccountCookieRotator,
	GeminiAccountLease,
	GeminiAccountRefreshResult,
} from "./lease-types";
import {
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./normalize";
import { choosePoolAccount } from "./pool-selection";
import {
	buildModelRoutingOverview,
	freshSelectableCatalogRoutes,
	loadSelectedCapabilityRows,
	persistedCatalogRoutes,
} from "./pool-catalog";
import {
	type AccountRuntimeState,
	applyOutcomeToSnapshot,
	applyRefreshToSnapshot,
	positiveIntOption,
} from "./pool-state";
import { verifyGeminiAccount } from "./probe";
import type {
	GeminiAccountVerificationLevel,
	GeminiAccountVerifier,
} from "./probe-types";
import type {
	GeminiAccountCapabilityRow,
	GeminiAccountModelCapability,
	GeminiRouteTuple,
} from "./route-types";
import {
	capabilitiesByAccount,
	reconcileRoutePriority,
	routePrioritiesByFamily,
	uniqueRouteTuples,
} from "./routes";
import type {
	GeminiAccountAcquireOptions,
	GeminiAccountOutcome,
	GeminiAccountRuntimeOptions,
	GeminiAccountRuntimeStore,
	GeminiAccountSnapshotRow,
} from "./runtime-types";
import type { GeminiAccountSecretRow } from "./storage-types";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 1000;
const DEFAULT_VERSION_PROBE_TTL_MS = 1 * 1000;
const DEFAULT_SELECTABLE_LIMIT = 100;
const DEFAULT_REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;

type AccountPoolServiceOptions = Omit<
	GeminiAccountRuntimeOptions,
	"rotateCookie" | "verifyAccount"
> & {
	rotateCookie: GeminiAccountCookieRotator;
	verifyAccount?: GeminiAccountVerifier;
};

export class AccountPoolService {
	private readonly nowMs: () => number;
	private readonly snapshotTtlMs: number;
	private readonly versionProbeTtlMs: number;
	private readonly selectableLimit: number;
	private readonly refreshLockTtlMs: number;
	private readonly rotateCookie: GeminiAccountCookieRotator;
	private readonly verifyAccount: GeminiAccountVerifier;
	private readonly inFlight = new Map<string, number>();
	private readonly accountStates = new Map<string, AccountRuntimeState>();
	private readonly pendingRefresh = new Map<
		string,
		Promise<GeminiAccountRefreshResult>
	>();
	private snapshotRows: GeminiAccountSnapshotRow[] = [];
	private capabilitiesByAccount = new Map<
		string,
		Map<string, GeminiAccountModelCapability>
	>();
	private persistedCapabilities: GeminiAccountCapabilityRow[] = [];
	private routePriorities = new Map<GeminiPublicFamily, GeminiRouteTuple[]>();
	private snapshotVersion = "";
	private snapshotExpiresAtMs = 0;
	private nextVersionProbeAtMs = 0;
	private pendingSnapshotLoad: Promise<GeminiAccountSnapshotRow[]> | null =
		null;
	private roundRobinCursor = 0;

	constructor(
		private readonly store: GeminiAccountRuntimeStore,
		options: AccountPoolServiceOptions,
	) {
		this.nowMs = options.nowMs || Date.now;
		this.snapshotTtlMs = positiveIntOption(
			options.snapshotTtlMs,
			DEFAULT_SNAPSHOT_TTL_MS,
		);
		this.versionProbeTtlMs = positiveIntOption(
			options.versionProbeTtlMs,
			DEFAULT_VERSION_PROBE_TTL_MS,
		);
		this.selectableLimit = positiveIntOption(
			options.selectableLimit,
			DEFAULT_SELECTABLE_LIMIT,
		);
		this.refreshLockTtlMs = positiveIntOption(
			options.refreshLockTtlMs,
			DEFAULT_REFRESH_LOCK_TTL_MS,
		);
		this.rotateCookie = options.rotateCookie;
		this.verifyAccount = options.verifyAccount || verifyGeminiAccount;
	}

	async acquireLease(
		baseConfig: RuntimeConfig,
		options: GeminiAccountAcquireOptions = {},
	): Promise<GeminiAccountLease | null> {
		const nowMs = this.nowMs();
		const rows = await this.selectableSnapshot(nowMs);
		const excluded = new Set(options.excludeAccountIds || []);
		const result = choosePoolAccount({
			rows,
			nowMs,
			excludedAccountIds: excluded,
			options,
			capabilitiesByAccount: this.capabilitiesByAccount,
			inFlight: this.inFlight,
			roundRobinCursor: this.roundRobinCursor,
		});
		this.roundRobinCursor = result.nextRoundRobinCursor;
		const selection = result.selection;
		if (!selection) return null;
		this.incrementInFlight(selection.row.id);
		return new PoolLease(
			this,
			baseConfig,
			selection.row,
			selection.capability,
			selection.route,
		);
	}

	async modelCatalog(
		capabilityFreshAfterMs: number,
	): Promise<GeminiModelCatalog> {
		await this.selectableSnapshot(this.nowMs());
		const freshRoutes = freshSelectableCatalogRoutes(
			this.snapshotRows,
			this.capabilitiesByAccount,
			capabilityFreshAfterMs,
		);
		const routes = freshRoutes.length
			? freshRoutes
			: persistedCatalogRoutes(this.persistedCapabilities);
		return buildGeminiModelCatalog(routes, this.nowMs());
	}

	async resolveModel(
		modelName: unknown,
		defaultName: unknown,
		capabilityFreshAfterMs: number,
	): Promise<ResolvedModel> {
		return resolveModelFromCatalog(
			modelName,
			defaultName,
			await this.modelCatalog(capabilityFreshAfterMs),
		);
	}

	async modelRoutingOverview(
		capabilityFreshAfterMs: number,
	): Promise<GeminiModelRoutingOverview> {
		await this.selectableSnapshot(this.nowMs());
		return buildModelRoutingOverview(
			this.snapshotVersion,
			this.routePriorities,
			persistedCatalogRoutes(this.persistedCapabilities),
			freshSelectableCatalogRoutes(
				this.snapshotRows,
				this.capabilitiesByAccount,
				capabilityFreshAfterMs,
			),
		);
	}

	invalidateSnapshot(): void {
		this.snapshotExpiresAtMs = 0;
		this.nextVersionProbeAtMs = 0;
	}

	async routeCandidatesForModel(
		model: Extract<ResolvedModel, { name: string }>,
		capabilityFreshAfterMs: number,
	): Promise<GeminiRouteTuple[]> {
		await this.selectableSnapshot(this.nowMs());
		const fresh = freshSelectableCatalogRoutes(
			this.snapshotRows,
			this.capabilitiesByAccount,
			capabilityFreshAfterMs,
		);
		const persisted = persistedCatalogRoutes(this.persistedCapabilities);
		const relevant = (fresh.length ? fresh : persisted).filter((route) =>
			model.family
				? route.family === model.family
				: route.providerModelId === model.dynamicProviderId,
		);
		const discovered = uniqueRouteTuples(relevant);
		if (!model.family) return discovered;
		const reconciled = reconcileRoutePriority(
			this.routePriorities.get(model.family) || [],
			discovered,
		);
		return reconciled;
	}

	async refreshAccountForAdmin(
		baseConfig: RuntimeConfig,
		account: GeminiAccountSecretRow,
		_reason = "admin",
	): Promise<GeminiAccountRefreshResult> {
		const lease = new PoolLease(this, baseConfig, account);
		try {
			return await this.refreshAccount(lease, "status", true);
		} finally {
			lease.release();
		}
	}

	async selectableSnapshot(
		nowMs: number = this.nowMs(),
	): Promise<GeminiAccountSnapshotRow[]> {
		const hasFreshSnapshot = nowMs < this.snapshotExpiresAtMs;
		if (hasFreshSnapshot && nowMs < this.nextVersionProbeAtMs)
			return this.snapshotRows;
		if (this.pendingSnapshotLoad) return this.pendingSnapshotLoad;

		const load = this.loadSelectableSnapshot(nowMs, hasFreshSnapshot);
		this.pendingSnapshotLoad = load;
		try {
			return await load;
		} finally {
			if (this.pendingSnapshotLoad === load) this.pendingSnapshotLoad = null;
		}
	}

	private async loadSelectableSnapshot(
		nowMs: number,
		hasFreshSnapshot: boolean,
	): Promise<GeminiAccountSnapshotRow[]> {
		const version = await this.store.getPoolVersion();
		this.nextVersionProbeAtMs = nowMs + this.versionProbeTtlMs;
		if (hasFreshSnapshot && version === this.snapshotVersion)
			return this.snapshotRows;

		const rows = await this.store.listSelectableAccounts(
			nowMs,
			this.selectableLimit,
		);
		this.snapshotRows = rows;
		const globalCapabilityRowsPromise = this.store.listAllAccountCapabilities
			? this.store.listAllAccountCapabilities(
					Math.min(this.selectableLimit * 128, 12800),
				)
			: null;
		const selectedCapabilityRowsPromise = loadSelectedCapabilityRows(
			this.store,
			rows,
			globalCapabilityRowsPromise,
		);
		const [selectedCapabilityRows, persistedCapabilityRows, priorities] =
			await Promise.all([
				selectedCapabilityRowsPromise,
				globalCapabilityRowsPromise || selectedCapabilityRowsPromise,
				this.store.listModelRoutePriorities?.() || Promise.resolve([]),
			]);
		this.persistedCapabilities = persistedCapabilityRows;
		this.capabilitiesByAccount = capabilitiesByAccount(selectedCapabilityRows);
		this.routePriorities = routePrioritiesByFamily(priorities);
		this.snapshotVersion = version;
		this.snapshotExpiresAtMs = nowMs + this.snapshotTtlMs;
		return rows;
	}

	localInFlight(accountId: string): number {
		return this.inFlight.get(accountId) || 0;
	}

	release(accountId: string): void {
		const current = this.localInFlight(accountId);
		if (current <= 1) this.inFlight.delete(accountId);
		else this.inFlight.set(accountId, current - 1);
	}

	async refreshForRetry(
		lease: PoolLease,
		recordFailure = true,
	): Promise<GeminiAccountRefreshResult> {
		return this.refreshAccount(lease, "session", recordFailure);
	}

	private async refreshAccount(
		lease: PoolLease,
		verificationLevel: GeminiAccountVerificationLevel,
		recordFailure: boolean,
	): Promise<GeminiAccountRefreshResult> {
		const pendingKey = `${lease.accountId}\0${lease.cookieHash}\0${verificationLevel}`;
		const pending = this.pendingRefresh.get(pendingKey);
		if (pending) return pending;
		const promise = this.refreshForRetryOnce(
			lease,
			verificationLevel,
			recordFailure,
		).finally(() => {
			this.pendingRefresh.delete(pendingKey);
		});
		this.pendingRefresh.set(pendingKey, promise);
		return promise;
	}

	private async refreshForRetryOnce(
		lease: PoolLease,
		verificationLevel: GeminiAccountVerificationLevel,
		recordFailure: boolean,
	): Promise<GeminiAccountRefreshResult> {
		const state = await this.accountState(lease);
		const nowMs = this.nowMs();
		if (!parseCookieHeader(state.cookieHeader).get("__Secure-1PSID")) {
			if (recordFailure)
				await this.markFailure(
					lease.accountId,
					{ code: "invalid_gemini_cookie" },
					nowMs,
				);
			return { changed: false, reason: "missing_secure_1psid" };
		}
		if (
			state.lastRotateAtMs > 0 &&
			nowMs - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS
		) {
			return { changed: false, reason: "recent_rotation" };
		}
		return this.refreshAccountOnce(
			lease,
			state,
			nowMs,
			verificationLevel,
			recordFailure,
		);
	}

	async markSuccess(
		accountId: string,
		nowMs: number = this.nowMs(),
	): Promise<void> {
		const outcome: GeminiAccountOutcome = { kind: "success", nowMs };
		this.snapshotRows = applyOutcomeToSnapshot(
			this.snapshotRows,
			accountId,
			outcome,
		);
		await this.store.writeAccountOutcome(accountId, outcome);
	}

	async markFailure(
		accountId: string,
		error: unknown,
		nowMs: number = this.nowMs(),
	): Promise<void> {
		const outcome = classifyGeminiAccountOutcome(error, nowMs);
		this.snapshotRows = applyOutcomeToSnapshot(
			this.snapshotRows,
			accountId,
			outcome,
		);
		await this.store.writeAccountOutcome(accountId, outcome);
	}

	async persistObservedCookies(
		lease: PoolLease,
		setCookieValues: readonly string[],
	): Promise<void> {
		if (!setCookieValues.length) return;
		const nowMs = this.nowMs();
		const owner = `account-response-cookie:${lease.accountId}:${uuid()}`;
		const locked = await this.store.tryAcquireRefreshLock(
			lease.accountId,
			owner,
			nowMs + this.refreshLockTtlMs,
			nowMs,
		);
		if (!locked) return;
		try {
			const account = await this.store.getAccountForRefresh(lease.accountId);
			if (!account) return;
			const cookieHeader = normalizeGeminiCookieHeader(
				mergeSetCookieHeaders(account.cookie_header, setCookieValues),
			);
			if (!cookieHeader) return;
			let identityHash = "";
			try {
				identityHash = await identityHashFromCookie(cookieHeader);
			} catch (_) {
				return;
			}
			if (identityHash !== account.identity_hash) return;
			const cookieHash = await sha256Hex(cookieHeader);
			if (cookieHash === account.cookie_hash) return;
			const writeback = await this.store.writeRefreshedCookie(lease.accountId, {
				cookieHeader,
				refreshedAtMs: nowMs,
				nowMs,
			});
			if (!writeback.changed) return;
			lease.updateCookie(cookieHeader, cookieHash, nowMs);
			this.accountStates.set(lease.accountId, {
				cookieHeader,
				cookieHash,
				lastRotateAtMs: 0,
			});
			this.snapshotRows = applyRefreshToSnapshot(
				this.snapshotRows,
				lease.accountId,
				cookieHeader,
				cookieHash,
			);
		} finally {
			await this.store.releaseRefreshLock(lease.accountId, owner);
		}
	}

	private async refreshAccountOnce(
		lease: PoolLease,
		state: AccountRuntimeState,
		nowMs: number,
		verificationLevel: GeminiAccountVerificationLevel,
		recordFailure: boolean,
	): Promise<GeminiAccountRefreshResult> {
		const owner = `account-refresh:${lease.accountId}:${uuid()}`;
		const locked = await this.store.tryAcquireRefreshLock(
			lease.accountId,
			owner,
			nowMs + this.refreshLockTtlMs,
			nowMs,
		);
		if (!locked) return { changed: false, reason: "lock_conflict" };
		try {
			const account = await this.store.getAccountForRefresh(lease.accountId);
			if (!account) return { changed: false, reason: "account_missing" };
			const response = await this.rotateCookie({
				config: lease.config,
				account,
			});
			state.lastRotateAtMs = nowMs;
			if (!response.ok) {
				if (recordFailure)
					await this.markFailure(
						lease.accountId,
						{ status: response.status },
						nowMs,
					);
				return {
					changed: false,
					reason:
						response.status === 401 || response.status === 403
							? "rotation_rejected"
							: "rotation_failed",
				};
			}
			const nextCookieHeader = normalizeGeminiCookieHeader(
				mergeSetCookieHeaders(
					account.cookie_header,
					setCookieHeaders(response.headers),
				),
			);
			if (!nextCookieHeader) {
				if (recordFailure)
					await this.markFailure(
						lease.accountId,
						{ code: "invalid_gemini_cookie" },
						nowMs,
					);
				return {
					changed: false,
					reason: "rotation_failed",
				};
			}
			const nextCookieHash = await sha256Hex(nextCookieHeader);
			const nextAccount = {
				...account,
				cookie_header: nextCookieHeader,
				cookie_hash: nextCookieHash,
			};
			const nextConfig = createAccountRuntimeConfig(lease.config, nextAccount);
			const verification = await this.verifyAccount({
				config: nextConfig,
				level: verificationLevel,
			});
			if (!verification.ok) {
				if (recordFailure && verification.reason === "missing_page_at_token")
					await this.markFailure(
						lease.accountId,
						{ code: "missing_page_at_token" },
						nowMs,
					);
				return { changed: false, reason: verification.reason };
			}
			const writeback = await this.store.writeRefreshedCookie(lease.accountId, {
				cookieHeader: nextCookieHeader,
				refreshedAtMs: nowMs,
				nowMs,
			});
			if (!writeback.changed && writeback.reason === "duplicate_cookie") {
				return {
					changed: false,
					reason: "rotation_duplicate",
				};
			}
			lease.updateCookie(nextCookieHeader, nextCookieHash, nowMs, nextConfig);
			this.accountStates.set(lease.accountId, {
				cookieHeader: nextCookieHeader,
				cookieHash: nextCookieHash,
				lastRotateAtMs: nowMs,
			});
			this.snapshotRows = applyRefreshToSnapshot(
				this.snapshotRows,
				lease.accountId,
				nextCookieHeader,
				nextCookieHash,
			);
			if (verification.probe) {
				await this.store.writeAccountProbe?.(
					lease.accountId,
					verification.probe,
					nowMs,
				);
				if (verification.probe.issue) {
					await this.markFailure(
						lease.accountId,
						{
							geminiSource: "account_status",
							geminiCode: String(verification.probe.statusCode),
						},
						nowMs,
					);
					return {
						changed: writeback.changed,
						reason: "status_restricted",
					};
				}
				await this.markSuccess(lease.accountId, nowMs);
			}
			return {
				changed: writeback.changed,
				reason: writeback.changed ? "rotation_updated" : "rotation_no_update",
			};
		} catch (error) {
			if (recordFailure)
				await this.markFailure(lease.accountId, error, nowMs).catch(
					() => undefined,
				);
			throw error;
		} finally {
			await this.store.releaseRefreshLock(lease.accountId, owner);
		}
	}

	private incrementInFlight(accountId: string): void {
		this.inFlight.set(accountId, this.localInFlight(accountId) + 1);
	}

	private async accountState(lease: PoolLease): Promise<AccountRuntimeState> {
		const existing = this.accountStates.get(lease.accountId);
		if (existing && existing.cookieHash === lease.cookieHash) return existing;
		const cookieHeader = normalizeGeminiCookieHeader(lease.cookieHeader);
		const cookieHash = await sha256Hex(cookieHeader);
		const state = { cookieHeader, cookieHash, lastRotateAtMs: 0 };
		this.accountStates.set(lease.accountId, state);
		return state;
	}
}
