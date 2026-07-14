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
import { normalizeGeminiCookieHeader, sha256Hex } from "./normalize";
import type {
	GeminiAccountCookieRotator,
	GeminiAccountLease,
	GeminiAccountOutcome,
	GeminiAccountRefreshResult,
	GeminiAccountRuntimeOptions,
	GeminiAccountRuntimeStore,
	GeminiAccountSecretRow,
	GeminiAccountSnapshotRow,
} from "./types";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 1000;
const DEFAULT_VERSION_PROBE_TTL_MS = 1 * 1000;
const DEFAULT_SELECTABLE_LIMIT = 100;
const DEFAULT_REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;

type AccountRuntimeState = {
	cookieHeader: string;
	cookieHash: string;
	lastRotateAtMs: number;
};

type AccountPoolServiceOptions = Omit<
	GeminiAccountRuntimeOptions,
	"rotateCookie"
> & {
	rotateCookie: GeminiAccountCookieRotator;
};

export class AccountPoolService {
	private readonly nowMs: () => number;
	private readonly snapshotTtlMs: number;
	private readonly versionProbeTtlMs: number;
	private readonly selectableLimit: number;
	private readonly refreshLockTtlMs: number;
	private readonly rotateCookie: GeminiAccountCookieRotator;
	private readonly inFlight = new Map<string, number>();
	private readonly accountStates = new Map<string, AccountRuntimeState>();
	private readonly pendingRefresh = new Map<
		string,
		Promise<GeminiAccountRefreshResult>
	>();
	private snapshotRows: GeminiAccountSnapshotRow[] = [];
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
	}

	async acquireLease(
		baseConfig: RuntimeConfig,
	): Promise<GeminiAccountLease | null> {
		const nowMs = this.nowMs();
		const rows = await this.selectableSnapshot(nowMs);
		const row = this.chooseRow(rows, nowMs);
		if (!row) return null;
		this.incrementInFlight(row.id);
		return new PoolLease(this, baseConfig, row);
	}

	async refreshAccountForAdmin(
		baseConfig: RuntimeConfig,
		account: GeminiAccountSecretRow,
		_reason = "admin",
	): Promise<GeminiAccountRefreshResult> {
		const lease = new PoolLease(this, baseConfig, account);
		try {
			return await this.refreshForRetry(lease);
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

	async refreshForRetry(lease: PoolLease): Promise<GeminiAccountRefreshResult> {
		const pendingKey = `${lease.accountId}\0${lease.cookieHash}`;
		const pending = this.pendingRefresh.get(pendingKey);
		if (pending) return pending;
		const promise = this.refreshForRetryOnce(lease).finally(() => {
			this.pendingRefresh.delete(pendingKey);
		});
		this.pendingRefresh.set(pendingKey, promise);
		return promise;
	}

	private async refreshForRetryOnce(
		lease: PoolLease,
	): Promise<GeminiAccountRefreshResult> {
		const state = await this.accountState(lease);
		const nowMs = this.nowMs();
		if (!parseCookieHeader(state.cookieHeader).get("__Secure-1PSID")) {
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
		return this.refreshAccountOnce(lease, state, nowMs);
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
			lease.cookieHeader = nextCookieHeader;
			lease.cookieHash = nextCookieHash;
			lease.config = accountConfig(lease.config, {
				...account,
				cookie_header: nextCookieHeader,
				cookie_hash: nextCookieHash,
			});
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
			return {
				changed: writeback.changed,
				reason: writeback.changed ? "rotation_updated" : "rotation_no_update",
				upstreamStatus: response.status,
			};
		} catch (error) {
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
						issue: null,
						cooldown_until_ms: null,
					}
				: row,
		);
	}

	private chooseRow(
		rows: readonly GeminiAccountSnapshotRow[],
		nowMs: number,
	): GeminiAccountSnapshotRow | null {
		const selectable = rows
			.filter((row) => row.enabled !== 0)
			.filter((row) => !isDurableGeminiAccountIssue(row.issue))
			.filter(
				(row) =>
					row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs,
			);
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
		return best;
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
	config: RuntimeConfig;
	cookieHeader: string;
	cookieHash: string;
	private released = false;

	constructor(
		private readonly pool: AccountPoolService,
		baseConfig: RuntimeConfig,
		row: GeminiAccountSnapshotRow,
	) {
		this.accountId = row.id;
		this.selectedCookieHash = row.cookie_hash;
		this.cookieHeader = row.cookie_header;
		this.cookieHash = row.cookie_hash;
		this.config = accountConfig(baseConfig, row);
	}

	refreshForRetry(): Promise<GeminiAccountRefreshResult> {
		return this.pool.refreshForRetry(this);
	}

	markSuccess(nowMs?: number): Promise<void> {
		return this.pool.markSuccess(this.accountId, nowMs);
	}

	markFailure(error: unknown, nowMs?: number): Promise<void> {
		return this.pool.markFailure(this.accountId, error, nowMs);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.pool.release(this.accountId);
	}
}

function accountConfig(
	baseConfig: RuntimeConfig,
	row: GeminiAccountSnapshotRow,
): RuntimeConfig {
	const cookie = normalizeGeminiCookieHeader(row.cookie_header);
	return {
		...baseConfig,
		cookie,
		sapisid: extractCookieValue(cookie, "SAPISID"),
		gemini_account: {
			accountId: row.id,
			cookieHash: row.cookie_hash,
		},
	};
}

function positiveInt(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}
