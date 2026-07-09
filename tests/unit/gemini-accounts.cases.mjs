import assert from "./assertions.js";
import { baseConfig, mod } from "./helpers.js";

export const suiteName = "gemini accounts";
export const cases = [
  ["lists selectable accounts with bounded indexed query shape and sanitized admin rows", async () => {
    const db = new FakeD1();
    const store = new mod.D1GeminiAccountStore(db);
    await seedAccount(store, "a", {
      label: "A",
      cookieHeader: "__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a; SNlM0e=secret",
      sessionToken: "at-a",
      nowMs: 1000,
    });
    await seedAccount(store, "b", {
      cookieHeader: "__Secure-1PSID=psid-b; __Secure-1PSIDTS=ts-b",
      nowMs: 1100,
    });
    db.rows.get("b").cooldown_until_ms = 5000;
    await seedAccount(store, "c", {
      cookieHeader: "__Secure-1PSID=psid-c; __Secure-1PSIDTS=ts-c",
      nowMs: 1200,
    });
    db.rows.get("c").enabled = 0;

    const rows = await store.listSelectableAccounts(2000, 5000);
    assert.deepEqual(rows.map((row) => row.id), ["a"]);
    assert.equal(db.lastBindValue(), 200);
    const sql = db.lastSql();
    assert.match(sql, /WHERE enabled = 1/);
    assert.match(sql, /status IN \(\?, \?, \?, \?\)/);
    assert.match(sql, /cooldown_until_ms IS NULL OR cooldown_until_ms <= \?/);
    assert.match(sql, /LIMIT \?/);

    const page = await store.listAdminAccounts({ limit: 10 });
    const account = page.items.find((item) => item.id === "a");
    assert.equal(account.has_cookie, true);
    assert.equal(account.has_session_token, true);
    assert.equal(Object.prototype.hasOwnProperty.call(account, "cookie_header"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(account, "session_token"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(account, "sapisid"), false);
    assert.doesNotMatch(JSON.stringify(account), /psid-a|at-a|SNlM0e/);
  }],
  ["skips unchanged cookie writeback and increments pool version only for durable state changes", async () => {
    const db = new FakeD1();
    const store = new mod.D1GeminiAccountStore(db);
    await seedAccount(store, "acct", {
      cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts",
      sessionToken: "at-1",
      nowMs: 1000,
    });
    assert.equal(await store.getPoolVersion(), "1000");

    const noChange = await store.writeCookieState("acct", {
      cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts",
      nowMs: 2000,
    });
    assert.deepEqual(noChange, { changed: false });
    assert.equal(await store.getPoolVersion(), "1000");
    assert.equal(db.rows.get("acct").session_token_hash, await mod.hashNullable("at-1"));

    const changed = await store.writeCookieState("acct", {
      cookieHeader: "__Secure-1PSID=psid; __Secure-1PSIDTS=ts2; SNlM0e=must-not-enter-cookie",
      sessionToken: "at-2",
      nowMs: 3000,
    });
    assert.deepEqual(changed, { changed: true });
    assert.equal(await store.getPoolVersion(), "3000");
    assert.doesNotMatch(db.rows.get("acct").cookie_header, /SNlM0e|must-not-enter-cookie/);

    await store.writeAccountOutcome("acct", { kind: "success", nowMs: 4000 });
    assert.equal(await store.getPoolVersion(), "3000");
    assert.equal(db.rows.get("acct").success_count, 1);

    await store.writeAccountOutcome("acct", {
      kind: "failure",
      status: "rate_limited",
      cooldownUntilMs: 9000,
      failureKind: "rate_limit",
      nowMs: 5000,
    });
    assert.equal(await store.getPoolVersion(), "5000");
    assert.equal(db.rows.get("acct").status, "rate_limited");
    assert.equal(db.rows.get("acct").failure_count, 1);
  }],
  ["acquires refresh locks with conflict, expiry replacement, and owner release", async () => {
    const db = new FakeD1();
    const store = new mod.D1GeminiAccountStore(db);
    assert.equal(await store.tryAcquireRefreshLock("acct", "owner-a", 2000, 1000), true);
    assert.equal(await store.tryAcquireRefreshLock("acct", "owner-b", 3000, 1500), false);
    assert.equal(db.locks.get("acct").lock_owner, "owner-a");
    assert.equal(await store.tryAcquireRefreshLock("acct", "owner-b", 4000, 2500), true);
    assert.equal(db.locks.get("acct").lock_owner, "owner-b");
    await store.releaseRefreshLock("acct", "owner-a");
    assert.equal(db.locks.has("acct"), true);
    await store.releaseRefreshLock("acct", "owner-b");
    assert.equal(db.locks.has("acct"), false);
  }],
  ["admin service accepts only safe Gemini dual-cookie imports and sanitizes create output", async () => {
    const db = new FakeD1();
    const service = mod.createGeminiAccountAdminServiceFromD1(db, baseConfig(), { nowMs: () => 1000 });
    const created = await service.create({
      provider: "gemini",
      accounts: [{
        provider: "gemini",
        "__Secure-1PSID": "psid-secret",
        "__Secure-1PSIDTS": "ts-secret",
        label: "primary",
      }],
    });
    assert.equal(created.added, 1);
    assert.equal(created.items[0].label, "primary");
    assert.equal(created.items[0].has_cookie, true);
    assert.equal(Object.prototype.hasOwnProperty.call(created.items[0], "cookie_header"), false);
    assert.doesNotMatch(JSON.stringify(created), /psid-secret|ts-secret|SAPISID|SNlM0e/);

    const invalidPayloads = [
      { provider: "gemini", tokens: ["raw-token"] },
      { provider: "gpt", accounts: [{ provider: "gemini", "__Secure-1PSID": "a", "__Secure-1PSIDTS": "b" }] },
      { provider: "gemini", accounts: [{ provider: "gpt", "__Secure-1PSID": "a", "__Secure-1PSIDTS": "b" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "a", "__Secure-1PSIDTS": "b", access_token: "secret" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "__Secure-1PSID=a", "__Secure-1PSIDTS": "b" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "a;b", "__Secure-1PSIDTS": "c" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "a", "__Secure-1PSIDTS": "c=d" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "{\"__Secure-1PSID\":\"a\"}", "__Secure-1PSIDTS": "b" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "__Secure-1PSID", "__Secure-1PSIDTS": "b" }] },
      { provider: "gemini", accounts: [{ "__Secure-1PSID": "a", "__Secure-1PSIDTS": "b", cookies: { x: "y" } }] },
    ];
    for (const payload of invalidPayloads) {
      await assert.rejects(() => service.create(payload), /Gemini|provider|cookie/i);
    }
  }],
  ["admin service bounds list pagination and deduplicates identifier mutations", async () => {
    const db = new FakeD1();
    const store = new mod.D1GeminiAccountStore(db);
    await seedAccount(store, "a", {
      cookieHeader: "__Secure-1PSID=psid-a; __Secure-1PSIDTS=ts-a",
      nowMs: 1000,
    });
    await seedAccount(store, "b", {
      cookieHeader: "__Secure-1PSID=psid-b; __Secure-1PSIDTS=ts-b",
      nowMs: 1100,
    });
    const service = mod.createGeminiAccountAdminServiceFromD1(db, baseConfig(), { nowMs: () => 2000 });
    const page = await service.list({ limit: 500, enabled: true });
    assert.equal(page.limit, 200);
    assert.deepEqual(page.items.map((item) => item.id), ["a", "b"]);

    const disabled = await service.setEnabled({
      identifiers: [
        { id: "a" },
        { account_id: "a" },
        { row_id: db.rows.get("a").row_id },
      ],
    }, false);
    assert.equal(disabled.updated, 1);
    assert.equal(db.rows.get("a").enabled, 0);

    const removed = await service.delete({
      identifiers: [
        { row_id: db.rows.get("b").row_id },
        { id: "b" },
      ],
    });
    assert.equal(removed.removed, 1);
    assert.equal(db.rows.has("b"), false);
  }],
  ["admin refresh and check return countable sanitized deduped diagnostics", async () => {
    const db = new FakeD1();
    const store = new mod.D1GeminiAccountStore(db);
    await seedAccount(store, "refreshable", {
      cookieHeader: "__Secure-1PSID=psid-refresh; __Secure-1PSIDTS=ts-old",
      nowMs: 1000,
    });
    await seedAccount(store, "skipped", {
      cookieHeader: "__Secure-1PSID=psid-skip; __Secure-1PSIDTS=ts-skip",
      nowMs: 1000,
    });
    db.rows.get("skipped").account_category = "psid_only";

    let rotateCalls = 0;
    const service = mod.createGeminiAccountAdminServiceFromD1(db, baseConfig({
      request_timeout_sec: 10,
      upstream_socket: false,
    }), {
      nowMs: () => 120_000,
      rotateCookie: async () => {
        rotateCalls++;
        return new Response("", { status: 200, headers: { "set-cookie": "__Secure-1PSIDTS=ts-new; Path=/; Secure" } });
      },
    });
    const result = await service.refresh({
      identifiers: [
        { id: "refreshable" },
        { account_id: "refreshable" },
        { row_id: db.rows.get("skipped").row_id },
      ],
    });
    assert.equal(result.checked, 2);
    assert.equal(result.refreshed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    assert.equal(rotateCalls, 1);
    assert.doesNotMatch(JSON.stringify(result), /psid-refresh|ts-old|ts-new|SNlM0e|SAPISID/);

    const check = await service.check({ identifiers: [{ id: "refreshable" }, { id: "refreshable" }] });
    assert.equal(check.checked, 1);
    assert.equal(check.unchanged + check.refreshed, 1);
  }],
  ["worker admin route uses admin auth separately from public API keys and avoids unauthenticated D1 reads", async () => {
    const db = new FakeD1();
    let prepareCalls = 0;
    const env = {
      API_KEYS: "public-key",
      ADMIN_KEY: "admin-secret",
      GEMINI_DB: {
        prepare(sql) {
          prepareCalls++;
          return db.prepare(sql);
        },
      },
    };

    const publicKey = await mod.default.fetch(new Request("https://worker.example/admin/gemini/accounts", {
      headers: { Authorization: "Bearer public-key" },
    }), env, {});
    assert.equal(publicKey.status, 401);
    assert.equal(prepareCalls, 0);

    const missingD1 = await mod.default.fetch(new Request("https://worker.example/admin/gemini/accounts", {
      headers: { Authorization: "Bearer admin-secret" },
    }), { ADMIN_KEY: "admin-secret" }, {});
    assert.equal(missingD1.status, 503);
    assert.equal((await missingD1.json()).error.code, "gemini_account_store_unavailable");

    const created = await mod.default.fetch(new Request("https://worker.example/admin/gemini/accounts", {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "gemini",
        accounts: [{ "__Secure-1PSID": "route-psid", "__Secure-1PSIDTS": "route-ts" }],
      }),
    }), env, {});
    assert.equal(created.status, 200);
    assert.doesNotMatch(JSON.stringify(await created.json()), /route-psid|route-ts/);

    const listed = await mod.default.fetch(new Request("https://worker.example/admin/gemini/accounts?limit=999", {
      headers: { "X-Admin-Key": "admin-secret" },
    }), env, {});
    assert.equal(listed.status, 200);
    const body = await listed.json();
    assert.equal(body.limit, 200);
    assert.equal(body.items.length, 1);
  }],
  ["worker serves Gemini account admin WebUI without D1 reads or legacy cookie fallback text", async () => {
    const db = new FakeD1();
    let prepareCalls = 0;
    const env = {
      API_KEYS: "public-key",
      ADMIN_KEY: "admin-secret",
      GEMINI_DB: {
        prepare(sql) {
          prepareCalls++;
          return db.prepare(sql);
        },
      },
    };

    const response = await mod.default.fetch(new Request("https://worker.example/admin/gemini/accounts/ui"), env, {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.equal(prepareCalls, 0);
    const html = await response.text();
    assert.match(html, /Gemini Account Pool/);
    assert.match(html, /\/admin\/gemini\/accounts/);
    assert.match(html, /Authorization: "Bearer "/);
    assert.match(html, /__Secure-1PSID/);
    assert.match(html, /__Secure-1PSIDTS/);
    assert.doesNotMatch(html, /GEMINI_COOKIE|SAPISID=|SNlM0e=|psid-secret|ts-secret|Cookie:\s*__Secure/i);

    const post = await mod.default.fetch(new Request("https://worker.example/admin/gemini/accounts/ui", { method: "POST" }), env, {});
    assert.equal(post.status, 404);
    assert.equal(prepareCalls, 0);
  }],
];

async function seedAccount(store, id, input) {
  return store.createAccount({
    id,
    label: null,
    ...input,
  });
}

const ACCOUNT_COLUMNS = [
  "id", "label", "enabled", "status", "state_reason", "row_id", "cookie_header", "cookie_hash",
  "sapisid", "session_token", "session_token_hash", "session_id", "language", "push_id",
  "last_token_bootstrap_at_ms", "secure_1psid_hash", "secure_1psidts_hash", "account_category",
  "account_status_code", "account_status_description", "user_agent", "gemini_origin", "source",
  "source_id", "source_name", "imported_at_ms", "cooldown_until_ms", "last_used_at_ms",
  "last_success_at_ms", "last_failure_at_ms", "last_refresh_at_ms", "last_refresh_attempt_at_ms",
  "last_error_code", "last_error_message_redacted", "last_upstream_status",
  "last_capability_probe_at_ms", "capability_summary_json", "success_count", "failure_count",
  "created_at_ms", "updated_at_ms",
];

class FakeD1 {
  constructor() {
    this.rows = new Map();
    this.meta = new Map([["pool_version", { value: "0", updated_at_ms: 0 }]]);
    this.locks = new Map();
    this.statements = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  lastSql() {
    return this.statements.at(-1)?.sql || "";
  }

  lastBindValue() {
    return this.statements.at(-1)?.values.at(-1);
  }
}

class FakeStatement {
  constructor(db, sql, values = []) {
    this.db = db;
    this.sql = String(sql || "");
    this.values = values;
  }

  bind(...values) {
    return new FakeStatement(this.db, this.sql, values);
  }

  async first(columnName) {
    const result = await this.all();
    const row = result.results[0] || null;
    if (!row || columnName === undefined) return row;
    return Object.prototype.hasOwnProperty.call(row, columnName) ? row[columnName] : null;
  }

  async all() {
    this.record();
    if (this.sql.includes("FROM gemini_pool_meta")) {
      return { results: [this.db.meta.get(this.values[0]) || null].filter(Boolean), meta: { changes: 0 } };
    }
    if (this.sql.includes("SELECT *") && this.sql.includes("WHERE id = ?")) {
      const row = this.db.rows.get(this.values[0]);
      return { results: row ? [clone(row)] : [], meta: { changes: 0 } };
    }
    if (this.sql.includes("SELECT id") && this.sql.includes("WHERE id = ?")) {
      return this.idLookup((row) => row.id === this.values[0]);
    }
    if (this.sql.includes("SELECT id") && this.sql.includes("WHERE row_id = ?")) {
      return this.idLookup((row) => row.row_id === this.values[0]);
    }
    if (this.sql.includes("FROM gemini_accounts") && this.sql.includes("status IN")) {
      const statuses = new Set(this.values.slice(0, 4));
      const nowMs = this.values[4];
      const limit = this.values[5];
      const rows = Array.from(this.db.rows.values())
        .filter((row) => row.enabled === 1)
        .filter((row) => statuses.has(row.status))
        .filter((row) => row.cooldown_until_ms == null || row.cooldown_until_ms <= nowMs)
        .sort((a, b) => (a.last_used_at_ms || 0) - (b.last_used_at_ms || 0))
        .slice(0, limit)
        .map(clone);
      return { results: rows, meta: { changes: 0 } };
    }
    if (this.sql.includes("FROM gemini_accounts")) {
      const limit = this.values.at(-1);
      let index = 0;
      let rows = Array.from(this.db.rows.values()).sort((a, b) => a.id.localeCompare(b.id));
      if (this.sql.includes("id > ?")) {
        const cursor = this.values[index];
        index++;
        rows = rows.filter((row) => row.id > cursor);
      }
      if (this.sql.includes("status = ?")) {
        const status = this.values[index];
        index++;
        rows = rows.filter((row) => row.status === status);
      }
      if (this.sql.includes("enabled = ?")) {
        const enabled = this.values[index];
        rows = rows.filter((row) => row.enabled === enabled);
      }
      rows = rows.slice(0, limit).map(clone);
      return { results: rows, meta: { changes: 0 } };
    }
    throw new Error(`unhandled fake all SQL: ${this.sql}`);
  }

  async run() {
    this.record();
    if (this.sql.includes("INSERT INTO gemini_accounts")) {
      const row = {};
      ACCOUNT_COLUMNS.forEach((name, index) => {
        row[name] = this.values[index];
      });
      this.db.rows.set(row.id, row);
      return changed(1);
    }
    if (this.sql.includes("INSERT INTO gemini_pool_meta")) {
      this.db.meta.set(this.values[0], { value: this.values[1], updated_at_ms: this.values[2] });
      return changed(1);
    }
    if (this.sql.includes("INSERT INTO gemini_account_locks")) {
      const [accountId, lockOwner, expiresAtMs, createdAtMs, nowMs] = this.values;
      const existing = this.db.locks.get(accountId);
      if (!existing || existing.expires_at_ms < nowMs) {
        this.db.locks.set(accountId, { account_id: accountId, lock_owner: lockOwner, expires_at_ms: expiresAtMs, created_at_ms: createdAtMs });
        return changed(1);
      }
      return changed(0);
    }
    if (this.sql.includes("DELETE FROM gemini_account_locks")) {
      const [accountId, owner] = this.values;
      const existing = this.db.locks.get(accountId);
      if (existing?.lock_owner === owner) {
        this.db.locks.delete(accountId);
        return changed(1);
      }
      return changed(0);
    }
    if (this.sql.includes("UPDATE gemini_accounts") && this.sql.includes("cookie_header = ?")) {
      const accountId = this.values[16];
      const row = this.db.rows.get(accountId);
      if (!row) return changed(0);
      [
        "cookie_header", "cookie_hash", "sapisid", "session_token", "session_token_hash", "session_id",
        "language", "push_id", "secure_1psid_hash", "secure_1psidts_hash", "account_category",
        "status", "state_reason", "last_refresh_at_ms", "last_refresh_attempt_at_ms", "updated_at_ms",
      ].forEach((name, index) => {
        row[name] = this.values[index];
      });
      return changed(1);
    }
    if (this.sql.includes("UPDATE gemini_accounts") && this.sql.includes("success_count = success_count")) {
      const accountId = this.values[13];
      const row = this.db.rows.get(accountId);
      if (!row) return changed(0);
      row.status = this.values[0] || row.status;
      row.state_reason = this.values[1];
      row.cooldown_until_ms = this.values[2];
      if (this.values[3]) row.last_success_at_ms = this.values[4];
      if (this.values[5]) row.last_failure_at_ms = this.values[6];
      row.last_error_code = this.values[7];
      row.last_error_message_redacted = this.values[8];
      row.last_upstream_status = this.values[9];
      row.success_count += this.values[10];
      row.failure_count += this.values[11];
      row.updated_at_ms = this.values[12];
      return changed(1);
    }
    if (this.sql.includes("UPDATE gemini_accounts") && this.sql.includes("SET label = ?")) {
      const accountId = this.values[13];
      const row = this.db.rows.get(accountId);
      if (!row) return changed(0);
      [
        "label", "enabled", "status", "state_reason", "cooldown_until_ms",
        "account_status_code", "account_status_description", "user_agent",
        "gemini_origin", "source", "source_id", "source_name", "updated_at_ms",
      ].forEach((name, index) => {
        row[name] = this.values[index];
      });
      return changed(1);
    }
    if (this.sql.includes("DELETE FROM gemini_accounts")) {
      return changed(this.db.rows.delete(this.values[0]) ? 1 : 0);
    }
    throw new Error(`unhandled fake run SQL: ${this.sql}`);
  }

  idLookup(match) {
    const row = Array.from(this.db.rows.values()).find(match);
    return { results: row ? [{ id: row.id }] : [], meta: { changes: 0 } };
  }

  record() {
    this.db.statements.push({ sql: compactSql(this.sql), values: this.values });
  }
}

function changed(count) {
  return { success: true, meta: { changes: count } };
}

function compactSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

function clone(value) {
  return { ...value };
}
