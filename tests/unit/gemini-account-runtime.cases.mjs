import assert from "./assertions.js";
import { baseConfig, mod, withFetch } from "./helpers.js";

export const suiteName = "gemini account runtime";
export const cases = [
  ["resolves optional runtime only when a D1 binding exists", async () => {
    assert.equal(mod.createGeminiAccountRuntimeFromEnv({}, {}), null);
    const runtime = mod.createGeminiAccountRuntimeFromEnv({ GEMINI_DB: { prepare() {} } }, {
      rotateCookie: async () => new Response("", { status: 204 }),
    });
    assert.equal(runtime instanceof mod.GeminiAccountRuntime, true);
  }],
  ["caches selectable snapshots and probes pool version without row reads every request", async () => {
    let now = 1000;
    const store = new FakeStore([accountRow("a"), accountRow("b")]);
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => now,
      snapshotTtlMs: 10_000,
      versionProbeTtlMs: 1_000,
      rotateCookie: async () => new Response("", { status: 204 }),
    });

    const first = await pool.acquireLease(baseConfig());
    assert.equal(first.accountId, "a");
    first.release();
    assert.equal(store.getPoolVersionCalls, 1);
    assert.equal(store.listSelectableCalls, 1);
    assert.equal(store.writeCalls, 0);

    now = 1100;
    const second = await pool.acquireLease(baseConfig());
    assert.equal(second.accountId, "b");
    second.release();
    assert.equal(store.getPoolVersionCalls, 1);
    assert.equal(store.listSelectableCalls, 1);
    assert.equal(store.writeCalls, 0);

    now = 2500;
    const third = await pool.acquireLease(baseConfig());
    third.release();
    assert.equal(store.getPoolVersionCalls, 2);
    assert.equal(store.listSelectableCalls, 1);

    store.poolVersion = "changed";
    now = 4000;
    const fourth = await pool.acquireLease(baseConfig());
    fourth.release();
    assert.equal(store.getPoolVersionCalls, 3);
    assert.equal(store.listSelectableCalls, 2);
  }],
  ["uses local in-flight counts and idempotent release for selection", async () => {
    const store = new FakeStore([accountRow("a"), accountRow("b")]);
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => 1000,
      rotateCookie: async () => new Response("", { status: 204 }),
    });
    const first = await pool.acquireLease(baseConfig());
    const second = await pool.acquireLease(baseConfig());
    assert.equal(first.accountId, "a");
    assert.equal(second.accountId, "b");
    assert.equal(pool.localInFlight("a"), 1);
    first.release();
    first.release();
    assert.equal(pool.localInFlight("a"), 0);
    second.release();
    assert.equal(store.writeCalls, 0);
  }],
  ["deduplicates account refresh with D1 lock and changed-only cookie writeback", async () => {
    let now = 10_000;
    let rotateCalls = 0;
    const store = new FakeStore([accountRow("a", {
      cookie_header: "__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a",
      cookie_hash: await mod.sha256Hex("__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a"),
    })]);
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => now,
      rotateCookie: async () => {
        rotateCalls++;
        await Promise.resolve();
        return new Response("", { status: 200, headers: { "set-cookie": "__Secure-1PSIDTS=ts-b; Path=/; Secure" } });
      },
    });
    const lease = await pool.acquireLease(baseConfig());
    const [first, second] = await Promise.all([
      lease.refreshForRetry("auth"),
      lease.refreshForRetry("auth"),
    ]);
    assert.deepEqual(first, { changed: true, reason: "rotation_updated", upstreamStatus: 200 });
    assert.deepEqual(second, first);
    assert.equal(rotateCalls, 1);
    assert.equal(store.lockAttempts, 1);
    assert.equal(store.releaseLockCalls, 1);
    assert.equal(store.writeCookieCalls, 1);
    assert.doesNotMatch(store.lastCookieWrite.cookieHeader, /SNlM0e|at=/);

    now += 1000;
    const recent = await lease.refreshForRetry("auth");
    assert.deepEqual(recent, { changed: false, reason: "recent_rotation" });
    assert.equal(rotateCalls, 1);
    lease.release();
  }],
  ["propagates refresh failure to all waiters and clears the pending entry", async () => {
    let rotateCalls = 0;
    const store = new FakeStore([accountRow("a")]);
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => 20_000,
      rotateCookie: async () => {
        rotateCalls++;
        throw new Error("network failed with __Secure-1PSID=secret");
      },
    });
    const lease = await pool.acquireLease(baseConfig());
    const p1 = lease.refreshForRetry("auth");
    const p2 = lease.refreshForRetry("auth");
    await assert.rejects(() => p1, /network failed/);
    await assert.rejects(() => p2, /network failed/);
    assert.equal(rotateCalls, 1);
    assert.equal(store.releaseLockCalls, 1);
    assert.equal(store.outcomeCalls, 1);

    await assert.rejects(() => lease.refreshForRetry("auth"), /network failed/);
    assert.equal(rotateCalls, 2);
    lease.release();
  }],
  ["returns typed refresh conflict when another instance owns the D1 lock", async () => {
    let rotateCalls = 0;
    const store = new FakeStore([accountRow("a")]);
    store.lockAvailable = false;
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => 30_000,
      rotateCookie: async () => {
        rotateCalls++;
        return new Response("", { status: 204 });
      },
    });
    const lease = await pool.acquireLease(baseConfig());
    assert.deepEqual(await lease.refreshForRetry("auth"), { changed: false, reason: "lock_conflict" });
    assert.equal(rotateCalls, 0);
    assert.equal(store.releaseLockCalls, 0);
    lease.release();
  }],
  ["records session tokens separately from outbound cookie headers", async () => {
    const store = new FakeStore([accountRow("a")]);
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => 40_000,
      rotateCookie: async () => new Response("", { status: 204 }),
    });
    const lease = await pool.acquireLease(baseConfig());
    await lease.recordPageState({
      cookieHeader: "__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a; SNlM0e=secret-at; at=secret-at",
      sessionToken: "secret-at",
      pushId: "push-a",
    });
    assert.equal(store.writeCookieCalls, 1);
    assert.doesNotMatch(store.lastCookieWrite.cookieHeader, /SNlM0e|at=|secret-at/);
    assert.equal(store.lastCookieWrite.sessionToken, "secret-at");
    lease.release();
  }],
  ["writes account page tokens back through the selected lease config", async () => {
    const store = new FakeStore([accountRow("a")]);
    const pool = new mod.AccountPoolService(store, {
      nowMs: () => 45_000,
      rotateCookie: async () => new Response("", { status: 204 }),
    });
    const lease = await pool.acquireLease(baseConfig({
      gemini_origin: "https://gemini.example",
      request_timeout_sec: 180,
      upstream_socket: false,
    }));
    await withFetch(async (url, init = {}) => {
      assert.equal(String(url), "https://gemini.example/app");
      assert.equal(init.headers.Cookie, "__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a");
      return new Response('{"SNlM0e":"page-at","qKIAYe":"page-push"}', { status: 200 });
    }, async () => {
      assert.deepEqual(await mod.getPageTokens(lease.config), { at: "page-at", push_id: "page-push" });
    });
    assert.equal(store.writeCookieCalls, 1);
    assert.equal(store.lastCookieWrite.sessionToken, "page-at");
    assert.equal(store.lastCookieWrite.pushId, "page-push");
    assert.doesNotMatch(store.lastCookieWrite.cookieHeader, /SNlM0e|page-at|page-push/);
    lease.release();
  }],
  ["does not classify generic token budget wording as auth failure", async () => {
    const outcome = mod.classifyGeminiAccountOutcome(new Error("token budget exceeded for this request"), 50_000);
    assert.equal(outcome.failureKind === "auth", false);
    assert.equal(outcome.status, "transient_failed");
  }],
];

function accountRow(id, overrides = {}) {
  const cookie = overrides.cookie_header || `__Secure-1PSID=psid-${id}; __Secure-1PSIDTS=ts-${id}`;
  return {
    id,
    row_id: `row-${id}`,
    label: id.toUpperCase(),
    enabled: 1,
    status: "active",
    state_reason: null,
    cookie_header: cookie,
    cookie_hash: overrides.cookie_hash || `hash-${id}`,
    sapisid: null,
    session_token: null,
    session_token_hash: null,
    session_id: null,
    language: null,
    push_id: null,
    last_token_bootstrap_at_ms: null,
    secure_1psid_hash: `psid-hash-${id}`,
    secure_1psidts_hash: `psidts-hash-${id}`,
    account_category: "psid_psidts",
    account_status_code: null,
    account_status_description: null,
    user_agent: null,
    gemini_origin: null,
    source: null,
    source_id: null,
    source_name: null,
    imported_at_ms: 0,
    cooldown_until_ms: null,
    last_used_at_ms: null,
    last_success_at_ms: null,
    last_failure_at_ms: null,
    last_refresh_at_ms: null,
    last_refresh_attempt_at_ms: null,
    last_error_code: null,
    last_error_message_redacted: null,
    last_upstream_status: null,
    last_capability_probe_at_ms: null,
    capability_summary_json: null,
    success_count: 0,
    failure_count: 0,
    created_at_ms: 0,
    updated_at_ms: 0,
    ...overrides,
  };
}

class FakeStore {
  constructor(rows) {
    this.rows = new Map(rows.map((row) => [row.id, { ...row }]));
    this.poolVersion = "v1";
    this.getPoolVersionCalls = 0;
    this.listSelectableCalls = 0;
    this.writeCalls = 0;
    this.writeCookieCalls = 0;
    this.outcomeCalls = 0;
    this.lockAttempts = 0;
    this.releaseLockCalls = 0;
    this.lockAvailable = true;
    this.lastCookieWrite = null;
  }

  async getPoolVersion() {
    this.getPoolVersionCalls++;
    return this.poolVersion;
  }

  async listSelectableAccounts(nowMs, limit) {
    this.listSelectableCalls++;
    return Array.from(this.rows.values())
      .filter((row) => row.enabled === 1)
      .filter((row) => row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async listAdminAccounts() {
    return { items: [], nextCursor: null, limit: 0 };
  }

  async getAccountForRefresh(accountId) {
    const row = this.rows.get(accountId);
    return row ? { ...row } : null;
  }

  async resolveAccountIdentifier(input) {
    return input.id || null;
  }

  async createAccount() {
    throw new Error("not implemented");
  }

  async updateAccount() {
    throw new Error("not implemented");
  }

  async deleteAccount() {
    throw new Error("not implemented");
  }

  async tryAcquireRefreshLock() {
    this.lockAttempts++;
    return this.lockAvailable;
  }

  async releaseRefreshLock() {
    this.releaseLockCalls++;
  }

  async writeCookieState(accountId, update) {
    this.writeCalls++;
    this.writeCookieCalls++;
    this.lastCookieWrite = update;
    const row = this.rows.get(accountId);
    if (row) {
      row.cookie_header = update.cookieHeader;
      row.cookie_hash = await mod.sha256Hex(update.cookieHeader);
      if (update.sessionToken !== undefined) row.session_token = update.sessionToken;
      if (update.pushId !== undefined) row.push_id = update.pushId;
    }
    return { changed: true };
  }

  async writeAccountOutcome(accountId, outcome) {
    this.writeCalls++;
    this.outcomeCalls++;
    const row = this.rows.get(accountId);
    if (row && outcome.status) row.status = outcome.status;
  }
}
