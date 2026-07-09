import type { RuntimeConfig } from "../../config";
import { uuid } from "../../shared/runtime";
import { COOKIE_ROTATE_MIN_INTERVAL_MS, mergeSetCookieHeaders, parseCookieHeader, setCookieHeaders } from "../cookies";
import { classifyGeminiAccountOutcome } from "./classify";
import { normalizeGeminiCookieHeader, sha256Hex } from "./normalize";
import type {
  GeminiAccountCookieRotator,
  GeminiAccountLease,
  GeminiAccountPageState,
  GeminiAccountRefreshResult,
  GeminiAccountSecretRow,
  GeminiAccountSnapshotRow,
  GeminiAccountStore,
  GeminiAccountRuntimeOptions,
  GeminiCookieWritebackResult,
} from "./types";

const DEFAULT_SNAPSHOT_TTL_MS = 30 * 1000;
const DEFAULT_VERSION_PROBE_TTL_MS = 1 * 1000;
const DEFAULT_SELECTABLE_LIMIT = 100;
const DEFAULT_REFRESH_LOCK_TTL_MS = 2 * 60 * 1000;

const SELECTABLE_STATUSES = new Set(["active", "transient_failed", "rate_limited", "cooling_down"]);

type AccountRuntimeState = {
  cookieHeader: string;
  cookieHash: string;
  sapisid: string | null;
  lastRotateAtMs: number;
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
  private readonly pendingRefresh = new Map<string, Promise<GeminiAccountRefreshResult>>();
  private snapshotRows: GeminiAccountSnapshotRow[] = [];
  private snapshotVersion = "";
  private snapshotExpiresAtMs = 0;
  private nextVersionProbeAtMs = 0;
  private roundRobinCursor = 0;

  constructor(
    private readonly store: GeminiAccountStore,
    options: GeminiAccountRuntimeOptions = {},
  ) {
    this.nowMs = options.nowMs || Date.now;
    this.snapshotTtlMs = positiveInt(options.snapshotTtlMs, DEFAULT_SNAPSHOT_TTL_MS);
    this.versionProbeTtlMs = positiveInt(options.versionProbeTtlMs, DEFAULT_VERSION_PROBE_TTL_MS);
    this.selectableLimit = positiveInt(options.selectableLimit, DEFAULT_SELECTABLE_LIMIT);
    this.refreshLockTtlMs = positiveInt(options.refreshLockTtlMs, DEFAULT_REFRESH_LOCK_TTL_MS);
    this.rotateCookie = options.rotateCookie || missingRotator;
  }

  async acquireLease(baseConfig: RuntimeConfig): Promise<GeminiAccountLease | null> {
    const nowMs = this.nowMs();
    const rows = await this.selectableSnapshot(nowMs);
    const row = this.chooseRow(rows, nowMs);
    if (!row) return null;
    this.incrementInFlight(row.id);
    return new PoolLease(this, baseConfig, row);
  }

  async refreshAccountForAdmin(baseConfig: RuntimeConfig, account: GeminiAccountSecretRow, reason: string = "admin"): Promise<GeminiAccountRefreshResult> {
    const lease = new PoolLease(this, baseConfig, account);
    try {
      return await this.refreshForRetry(lease, reason);
    } finally {
      lease.release();
    }
  }

  async selectableSnapshot(nowMs: number = this.nowMs()): Promise<GeminiAccountSnapshotRow[]> {
    const hasFreshSnapshot = this.snapshotRows.length > 0 && nowMs < this.snapshotExpiresAtMs;
    if (hasFreshSnapshot && nowMs < this.nextVersionProbeAtMs) return this.snapshotRows;

    const version = await this.store.getPoolVersion();
    this.nextVersionProbeAtMs = nowMs + this.versionProbeTtlMs;
    if (hasFreshSnapshot && version === this.snapshotVersion) return this.snapshotRows;

    const rows = await this.store.listSelectableAccounts(nowMs, this.selectableLimit);
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

  async recordPageState(lease: PoolLease, update: GeminiAccountPageState): Promise<GeminiCookieWritebackResult> {
    const nowMs = update.nowMs ?? this.nowMs();
    const cookieHeader = normalizeGeminiCookieHeader(update.cookieHeader ?? lease.cookieHeader);
    const result = await this.store.writeCookieState(lease.accountId, {
      cookieHeader,
      sapisid: update.sapisid,
      sessionToken: update.sessionToken,
      sessionId: update.sessionId,
      language: update.language,
      pushId: update.pushId,
      nowMs,
    });
    if (result.changed) {
      lease.cookieHeader = cookieHeader;
      lease.cookieHash = await sha256Hex(cookieHeader);
      this.accountStates.set(lease.accountId, {
        cookieHeader,
        cookieHash: lease.cookieHash,
        sapisid: update.sapisid === undefined ? lease.sapisid : update.sapisid,
        lastRotateAtMs: this.accountStates.get(lease.accountId)?.lastRotateAtMs || 0,
      });
    }
    return result;
  }

  async refreshForRetry(lease: PoolLease, _reason: string = "retry"): Promise<GeminiAccountRefreshResult> {
    const pendingKey = `${lease.accountId}\0${lease.cookieHash}`;
    const pending = this.pendingRefresh.get(pendingKey);
    if (pending) return pending;
    const promise = this.refreshForRetryOnce(lease).finally(() => {
      this.pendingRefresh.delete(pendingKey);
    });
    this.pendingRefresh.set(pendingKey, promise);
    return promise;
  }

  private async refreshForRetryOnce(lease: PoolLease): Promise<GeminiAccountRefreshResult> {
    const state = await this.accountState(lease);
    const nowMs = this.nowMs();
    if (!parseCookieHeader(state.cookieHeader).get("__Secure-1PSID")) {
      return { changed: false, reason: "missing_secure_1psid" };
    }
    if (state.lastRotateAtMs > 0 && nowMs - state.lastRotateAtMs < COOKIE_ROTATE_MIN_INTERVAL_MS) {
      return { changed: false, reason: "recent_rotation" };
    }
    return this.refreshAccountOnce(lease, state, nowMs);
  }

  async markSuccess(accountId: string, nowMs: number = this.nowMs()): Promise<void> {
    await this.store.writeAccountOutcome(accountId, { kind: "success", nowMs });
  }

  async markFailure(accountId: string, error: unknown, nowMs: number = this.nowMs()): Promise<void> {
    await this.store.writeAccountOutcome(accountId, classifyGeminiAccountOutcome(error, nowMs));
  }

  private async refreshAccountOnce(
    lease: PoolLease,
    state: AccountRuntimeState,
    nowMs: number,
  ): Promise<GeminiAccountRefreshResult> {
    const owner = `account-refresh:${lease.accountId}:${uuid()}`;
    const locked = await this.store.tryAcquireRefreshLock(lease.accountId, owner, nowMs + this.refreshLockTtlMs, nowMs);
    if (!locked) return { changed: false, reason: "lock_conflict" };
    try {
      const account = await this.store.getAccountForRefresh(lease.accountId);
      if (!account) return { changed: false, reason: "account_missing" };
      const response = await this.rotateCookie({ config: lease.config, account });
      state.lastRotateAtMs = nowMs;
      if (response.status === 401 || response.status === 403) {
        return { changed: false, reason: "rotation_rejected", upstreamStatus: response.status };
      }
      if (!response.ok) {
        return { changed: false, reason: "rotation_failed", upstreamStatus: response.status };
      }
      const nextCookieHeader = normalizeGeminiCookieHeader(mergeSetCookieHeaders(account.cookie_header, setCookieHeaders(response.headers)));
      const nextCookieHash = await sha256Hex(nextCookieHeader);
      if (!nextCookieHeader || nextCookieHash === account.cookie_hash) {
        return { changed: false, reason: "rotation_no_update", upstreamStatus: response.status };
      }
      await this.store.writeCookieState(lease.accountId, {
        cookieHeader: nextCookieHeader,
        sapisid: account.sapisid,
        sessionToken: account.session_token,
        lastRefreshAtMs: nowMs,
        lastRefreshAttemptAtMs: nowMs,
        nowMs,
      });
      lease.cookieHeader = nextCookieHeader;
      lease.cookieHash = nextCookieHash;
      this.accountStates.set(lease.accountId, {
        cookieHeader: nextCookieHeader,
        cookieHash: nextCookieHash,
        sapisid: account.sapisid,
        lastRotateAtMs: nowMs,
      });
      return { changed: true, reason: "rotation_updated", upstreamStatus: response.status };
    } catch (error) {
      await this.store.writeAccountOutcome(lease.accountId, classifyGeminiAccountOutcome(error, nowMs));
      throw error;
    } finally {
      await this.store.releaseRefreshLock(lease.accountId, owner);
    }
  }

  private chooseRow(rows: readonly GeminiAccountSnapshotRow[], nowMs: number): GeminiAccountSnapshotRow | null {
    const selectable = rows.filter((row) => row.enabled !== 0)
      .filter((row) => SELECTABLE_STATUSES.has(row.status))
      .filter((row) => row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs);
    if (!selectable.length) return null;
    const rotated: GeminiAccountSnapshotRow[] = [];
    for (let index = 0; index < selectable.length; index++) {
      const row = selectable[(this.roundRobinCursor + index) % selectable.length];
      if (row) rotated.push(row);
    }
    let best: GeminiAccountSnapshotRow | null = null;
    for (const row of rotated) {
      if (!best || this.localInFlight(row.id) < this.localInFlight(best.id)) best = row;
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
    const state = {
      cookieHeader,
      cookieHash,
      sapisid: lease.sapisid,
      lastRotateAtMs: 0,
    };
    this.accountStates.set(lease.accountId, state);
    return state;
  }
}

class PoolLease implements GeminiAccountLease {
  accountId: string;
  rowId?: string;
  selectedCookieHash: string;
  cookieHeader: string;
  cookieHash: string;
  sapisid: string | null;
  private released = false;

  constructor(
    private readonly pool: AccountPoolService,
    baseConfig: RuntimeConfig,
    row: GeminiAccountSnapshotRow,
  ) {
    this.accountId = row.id;
    this.rowId = row.row_id;
    this.selectedCookieHash = row.cookie_hash;
    this.cookieHeader = row.cookie_header;
    this.cookieHash = row.cookie_hash;
    this.sapisid = row.sapisid;
    this.config = accountConfig(baseConfig, row, (update) => this.recordPageState(update));
  }

  readonly config: RuntimeConfig;

  recordPageState(update: GeminiAccountPageState): Promise<GeminiCookieWritebackResult> {
    return this.pool.recordPageState(this, update);
  }

  refreshForRetry(reason?: string): Promise<GeminiAccountRefreshResult> {
    return this.pool.refreshForRetry(this, reason);
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
  writeback: NonNullable<RuntimeConfig["gemini_account_writeback"]>,
): RuntimeConfig {
  return {
    ...baseConfig,
    cookie: normalizeGeminiCookieHeader(row.cookie_header),
    sapisid: row.sapisid || "",
    gemini_origin: row.gemini_origin || baseConfig.gemini_origin,
    gemini_account: {
      accountId: row.id,
      rowId: row.row_id,
      cookieHash: row.cookie_hash,
    },
    gemini_account_writeback: writeback,
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function missingRotator(): Promise<Response> {
  throw new Error("Gemini account cookie rotator is not configured");
}
