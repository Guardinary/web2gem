import type { RuntimeConfig } from "../../config";
import { uuid } from "../../shared/crypto";
import {
	COOKIE_ROTATE_MIN_INTERVAL_MS,
	extractCookieValue,
	mergeSetCookieHeaders,
	parseCookieHeader,
	setCookieHeaders,
} from "../cookies";
import { classifyGeminiAccountOutcome } from "./classify";
import { isDurableGeminiAccountIssue } from "./domain";
import {
	identityHashFromCookie,
	normalizeGeminiCookieHeader,
	sha256Hex,
} from "./normalize";
import { verifyGeminiAccount } from "./probe";
import type {
	GeminiAccountCookieRotator,
	GeminiAccountAcquireOptions,
	GeminiAccountLease,
	GeminiAccountModelCapability,
	GeminiAccountOutcome,
	GeminiAccountRefreshResult,
	GeminiAccountRuntimeOptions,
	GeminiAccountRuntimeStore,
	GeminiAccountSecretRow,
	GeminiAccountSnapshotRow,
	GeminiAccountVerificationLevel,
	GeminiAccountVerifier,
} from "./types";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 1000;
const DEFAULT_VERSION_PROBE_TTL_MS = 1 * 1000;
const DEFAULT_SELECTABLE_LIMIT = 100;
const DEFAULT_REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;
const MAX_OBSERVED_SET_COOKIE_HEADERS = 64;
const MAX_OBSERVED_SET_COOKIE_CHARS = 8192;

type AccountRuntimeState = {
	cookieHeader: string;
	cookieHash: string;
	lastRotateAtMs: number;
};

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
		this.snapshotTtlMs = positiveInt(
			options.snapshotTtlMs,
			DEFAULT_SNAPSHOT_TTL_MS,
		);
		this.versionProbeTtlMs = positiveInt(
			options.versionProbeTtlMs,
			DEFAULT_VERSION_PROBE_TTL_MS,
		);
		this.selectableLimit = positiveInt(
			options.selectableLimit,
			DEFAULT_SELECTABLE_LIMIT,
		);
		this.refreshLockTtlMs = positiveInt(
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
		const selection = this.chooseRow(rows, nowMs, excluded, options);
		if (!selection) return null;
		this.incrementInFlight(selection.row.id);
		return new PoolLease(this, baseConfig, selection.row, selection.capability);
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
		this.capabilitiesByAccount = await this.loadCapabilities(rows);
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
		this.applyOutcomeToSnapshot(accountId, outcome);
		await this.store.writeAccountOutcome(accountId, outcome);
	}

	async markFailure(
		accountId: string,
		error: unknown,
		nowMs: number = this.nowMs(),
	): Promise<void> {
		const outcome = classifyGeminiAccountOutcome(error, nowMs);
		this.applyOutcomeToSnapshot(accountId, outcome);
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
			this.applyRefreshToSnapshot(lease.accountId, cookieHeader, cookieHash);
		} finally {
			await this.store.releaseRefreshLock(lease.accountId, owner);
		}
	}

	private applyOutcomeToSnapshot(
		accountId: string,
		outcome: GeminiAccountOutcome,
	): void {
		this.snapshotRows = this.snapshotRows.map((row) => {
			if (row.id !== accountId) return row;
			if (outcome.kind === "success") {
				return {
					...row,
					issue: null,
					cooldown_until_ms: null,
					last_used_at_ms: outcome.nowMs,
				};
			}
			return {
				...row,
				issue: outcome.issue ?? row.issue,
				cooldown_until_ms:
					outcome.issue === undefined
						? row.cooldown_until_ms
						: (outcome.cooldownUntilMs ?? null),
				last_used_at_ms: outcome.nowMs,
			};
		});
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
					upstreamStatus: response.status,
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
					upstreamStatus: response.status,
				};
			}
			const nextCookieHash = await sha256Hex(nextCookieHeader);
			const nextAccount = {
				...account,
				cookie_header: nextCookieHeader,
				cookie_hash: nextCookieHash,
			};
			const nextConfig = accountConfig(lease.config, nextAccount);
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
					upstreamStatus: response.status,
				};
			}
			lease.updateCookie(nextCookieHeader, nextCookieHash, nowMs, nextConfig);
			this.accountStates.set(lease.accountId, {
				cookieHeader: nextCookieHeader,
				cookieHash: nextCookieHash,
				lastRotateAtMs: nowMs,
			});
			this.applyRefreshToSnapshot(
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
						statusCode: verification.probe.statusCode,
					};
				}
				await this.markSuccess(lease.accountId, nowMs);
			}
			return {
				changed: writeback.changed,
				reason: writeback.changed ? "rotation_updated" : "rotation_no_update",
				upstreamStatus: response.status,
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

	private applyRefreshToSnapshot(
		accountId: string,
		cookieHeader: string,
		cookieHash: string,
	): void {
		this.snapshotRows = this.snapshotRows.map((row) =>
			row.id === accountId
				? {
						...row,
						cookie_header: cookieHeader,
						cookie_hash: cookieHash,
					}
				: row,
		);
	}

	private chooseRow(
		rows: readonly GeminiAccountSnapshotRow[],
		nowMs: number,
		excludedAccountIds: ReadonlySet<string>,
		options: GeminiAccountAcquireOptions,
	): {
		row: GeminiAccountSnapshotRow;
		capability: GeminiAccountModelCapability | null;
	} | null {
		let selectable = rows
			.filter((row) => !excludedAccountIds.has(row.id))
			.filter((row) => row.enabled !== 0)
			.filter((row) => !isDurableGeminiAccountIssue(row.issue))
			.filter(
				(row) =>
					row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs,
			);
		const mode = options.capabilityMode || "off";
		const modelId = options.providerModelId || "";
		if (mode !== "off" && modelId) {
			const freshAfter = Number(options.capabilityFreshAfterMs) || 0;
			const knownCapable: GeminiAccountSnapshotRow[] = [];
			const unknownOrStale: GeminiAccountSnapshotRow[] = [];
			for (const row of selectable) {
				const checkedAt = Number(row.status_checked_at_ms) || 0;
				if (checkedAt < freshAfter) {
					unknownOrStale.push(row);
					continue;
				}
				const capability = this.capabilitiesByAccount.get(row.id)?.get(modelId);
				if (capability?.available && capability.checkedAtMs >= freshAfter)
					knownCapable.push(row);
			}
			selectable =
				knownCapable.length > 0
					? knownCapable
					: mode === "prefer"
						? unknownOrStale
						: [];
		}
		if (!selectable.length) return null;
		const rotated: GeminiAccountSnapshotRow[] = [];
		for (let index = 0; index < selectable.length; index++) {
			const row =
				selectable[(this.roundRobinCursor + index) % selectable.length];
			if (row) rotated.push(row);
		}
		let best: GeminiAccountSnapshotRow | null = null;
		for (const row of rotated) {
			if (!best || this.localInFlight(row.id) < this.localInFlight(best.id))
				best = row;
		}
		if (best) {
			const index = selectable.findIndex((row) => row.id === best?.id);
			this.roundRobinCursor = index < 0 ? 0 : (index + 1) % selectable.length;
		}
		if (!best) return null;
		const capability = modelId
			? this.capabilitiesByAccount.get(best.id)?.get(modelId)
			: undefined;
		const freshAfter = Number(options.capabilityFreshAfterMs) || 0;
		return {
			row: best,
			capability:
				capability?.available && capability.checkedAtMs >= freshAfter
					? capability
					: null,
		};
	}

	private async loadCapabilities(
		rows: readonly GeminiAccountSnapshotRow[],
	): Promise<Map<string, Map<string, GeminiAccountModelCapability>>> {
		const out = new Map<string, Map<string, GeminiAccountModelCapability>>();
		if (!this.store.listAccountCapabilities || !rows.length) return out;
		const capabilities = await this.store.listAccountCapabilities(
			rows.map((row) => row.id),
		);
		for (const capability of capabilities) {
			let account = out.get(capability.account_id);
			if (!account) {
				account = new Map();
				out.set(capability.account_id, account);
			}
			account.set(capability.model_id, {
				modelId: capability.model_id,
				available: capability.available !== 0,
				capacity: capability.capacity,
				capacityField: capability.capacity_field,
				checkedAtMs: capability.checked_at_ms,
			});
		}
		return out;
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

class PoolLease implements GeminiAccountLease {
	readonly accountId: string;
	readonly selectedCookieHash: string;
	readonly modelCapability: GeminiAccountModelCapability | null;
	config: RuntimeConfig;
	cookieHeader: string;
	cookieHash: string;
	private released = false;
	private lastRefreshSuccessAtMs: number;
	private readonly observedSetCookieValues: string[] = [];

	constructor(
		private readonly pool: AccountPoolService,
		baseConfig: RuntimeConfig,
		row: GeminiAccountSnapshotRow,
		modelCapability: GeminiAccountModelCapability | null = null,
	) {
		this.accountId = row.id;
		this.selectedCookieHash = row.cookie_hash;
		this.modelCapability = modelCapability;
		this.cookieHeader = row.cookie_header;
		this.cookieHash = row.cookie_hash;
		this.lastRefreshSuccessAtMs = Number(row.last_refresh_success_at_ms) || 0;
		this.config = accountConfig(baseConfig, row, (values) =>
			this.observeSetCookie(values),
		);
	}

	refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult> {
		return this.pool.refreshForRetry(this, reason !== "auth");
	}

	markSuccess(nowMs?: number): Promise<void> {
		return this.pool.markSuccess(this.accountId, nowMs);
	}

	markFailure(error: unknown, nowMs?: number): Promise<void> {
		return this.pool.markFailure(this.accountId, error, nowMs);
	}

	async flushObservedCookies(): Promise<void> {
		if (!this.observedSetCookieValues.length) return;
		const values = this.observedSetCookieValues.splice(0);
		await this.pool.persistObservedCookies(this, values);
	}

	updateCookie(
		cookieHeader: string,
		cookieHash: string,
		refreshedAtMs: number,
		config?: RuntimeConfig,
	): void {
		this.cookieHeader = cookieHeader;
		this.cookieHash = cookieHash;
		this.lastRefreshSuccessAtMs = refreshedAtMs;
		this.config =
			config ||
			accountConfig(
				this.config,
				{
					id: this.accountId,
					cookie_header: cookieHeader,
					cookie_hash: cookieHash,
				},
				(values) => this.observeSetCookie(values),
			);
	}

	async maintainSessionIfStale(intervalMs: number): Promise<void> {
		const nowMs = Date.now();
		if (
			!Number.isFinite(intervalMs) ||
			intervalMs <= 0 ||
			nowMs - this.lastRefreshSuccessAtMs < intervalMs
		)
			return;
		const result = await this.pool.refreshForRetry(this, false);
		if (
			result.reason === "rotation_updated" ||
			result.reason === "rotation_no_update"
		)
			this.lastRefreshSuccessAtMs = nowMs;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.pool.release(this.accountId);
	}

	private observeSetCookie(values: readonly string[]): void {
		for (const value of values) {
			if (
				this.observedSetCookieValues.length >= MAX_OBSERVED_SET_COOKIE_HEADERS
			)
				break;
			if (value.length > MAX_OBSERVED_SET_COOKIE_CHARS) continue;
			if (value) this.observedSetCookieValues.push(value);
		}
	}
}

function accountConfig(
	baseConfig: RuntimeConfig,
	row: Pick<GeminiAccountSnapshotRow, "id" | "cookie_header" | "cookie_hash">,
	observeSetCookie?: (values: readonly string[]) => void,
): RuntimeConfig {
	const cookie = normalizeGeminiCookieHeader(row.cookie_header);
	const observer =
		observeSetCookie || baseConfig.gemini_account?.observeSetCookie;
	return {
		...baseConfig,
		cookie,
		sapisid: extractCookieValue(cookie, "SAPISID"),
		gemini_account: {
			accountId: row.id,
			cookieHash: row.cookie_hash,
			...(observer ? { observeSetCookie: observer } : {}),
		},
	};
}

function positiveInt(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}
