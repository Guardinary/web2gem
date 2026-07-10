import { errorLogSummary } from "../../shared/runtime";
import { isRecord, type UnknownRecord } from "../../shared/types";
import { AccountPoolService } from "./pool";
import { d1BindingFromEnv } from "./runtime";
import { D1GeminiAccountStore, isD1UniqueConstraintError } from "./store-d1";
import { normalizeGeminiCookieHeader, sha256Hex } from "./normalize";
import type {
  D1DatabaseLike,
  GeminiAccountAdminFilter,
  GeminiAccountAdminStats,
  GeminiAccountCategory,
  GeminiAccountCookieRotator,
  GeminiAccountCreateInput,
  GeminiAccountPublic,
  GeminiAccountPublicPage,
  GeminiAccountRefreshResult,
  GeminiAccountStatus,
  GeminiAccountStore,
  GeminiAccountUpdate,
} from "./types";
import type { RuntimeConfig, WorkerEnv } from "../../config";

const DEFAULT_REFRESH_CONCURRENCY = 4;
const MAX_REFRESH_CONCURRENCY = 10;
const SAFE_CREATE_KEYS = new Set([
  "provider",
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "label",
  "user_agent",
  "gemini_origin",
  "source",
  "source_id",
  "source_name",
]);
const UNSAFE_CREATE_KEYS = new Set(["tokens", "access_token", "accessToken", "cookie", "cookies"]);
const COOKIE_NAME_RE = /(?:^|[;\s])__Secure-1PSID(?:TS)?\s*=/i;

export class GeminiAccountAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GeminiAccountAdminError";
  }
}

export type GeminiAccountIdentifier = {
  id?: string;
  account_id?: string;
  row_id?: string;
};

export type GeminiAccountMutationResult = {
  items: GeminiAccountPublic[];
  updated?: number;
  removed?: number;
  skipped?: number;
};

export type GeminiAccountCreateResult = {
  added: number;
  skipped: number;
  items: GeminiAccountPublic[];
  duplicates?: number;
};

export type GeminiAccountDiagnosticItem = {
  id?: string;
  row_id?: string;
  status: "refreshed" | "unchanged" | "failed" | "skipped";
  reason?: string;
  upstreamStatus?: number;
};

export type GeminiAccountDiagnosticError = {
  id?: string;
  row_id?: string;
  error: string;
};

export type GeminiAccountDiagnosticResult = {
  checked: number;
  skipped: number;
  refreshed: number;
  unchanged: number;
  failed: number;
  errors: GeminiAccountDiagnosticError[];
  results: GeminiAccountDiagnosticItem[];
  items: GeminiAccountPublic[];
};

export type GeminiAccountAdminServiceOptions = {
  store: GeminiAccountStore;
  cfg: RuntimeConfig;
  nowMs?: () => number;
  refreshConcurrency?: number;
  rotateCookie?: GeminiAccountCookieRotator;
};

type GeminiAccountAdminFilterInput = Partial<Omit<GeminiAccountAdminFilter, "status" | "category" | "cooldown">> & {
  status?: unknown;
  category?: unknown;
  cooldown?: unknown;
};

export class GeminiAccountAdminService {
  private readonly store: GeminiAccountStore;
  private readonly cfg: RuntimeConfig;
  private readonly nowMs: () => number;
  private readonly refreshConcurrency: number;
  private readonly pool: AccountPoolService;

  constructor(options: GeminiAccountAdminServiceOptions) {
    this.store = options.store;
    this.cfg = options.cfg;
    this.nowMs = options.nowMs || Date.now;
    this.refreshConcurrency = boundedConcurrency(options.refreshConcurrency);
    const poolOptions = {
      nowMs: this.nowMs,
      snapshotTtlMs: 1,
      versionProbeTtlMs: 1,
      selectableLimit: 200,
      ...(options.rotateCookie ? { rotateCookie: options.rotateCookie } : {}),
    };
    this.pool = new AccountPoolService(this.store, poolOptions);
  }

  list(filter: GeminiAccountAdminFilterInput): Promise<GeminiAccountPublicPage> {
    return this.store.listAdminAccounts(normalizeListFilter(filter), this.nowMs());
  }

  stats(filter: GeminiAccountAdminFilterInput): Promise<GeminiAccountAdminStats> {
    const nowMs = this.nowMs();
    const normalized = normalizeListFilter({ ...filter, limit: 1 });
    const statsFilter: Omit<GeminiAccountAdminFilter, "cursor" | "limit"> = {};
    if (normalized.status) statsFilter.status = normalized.status;
    if (normalized.enabled !== undefined) statsFilter.enabled = normalized.enabled;
    if (normalized.q) statsFilter.q = normalized.q;
    if (normalized.category) statsFilter.category = normalized.category;
    if (normalized.cooldown) statsFilter.cooldown = normalized.cooldown;
    if (normalized.source) statsFilter.source = normalized.source;
    return this.store.getAdminStats(statsFilter, nowMs);
  }

  async create(body: UnknownRecord): Promise<GeminiAccountCreateResult> {
    const accounts = normalizeCreateAccounts(body);
    let added = 0;
    let skipped = 0;
    let duplicates = 0;
    const items: GeminiAccountPublic[] = [];
    for (const account of accounts) {
      const input = createInputFromAccount(account, this.nowMs());
      const cookieHash = await sha256Hex(normalizeGeminiCookieHeader(input.cookieHeader));
      const existing = await this.store.findAccountByCookieHash(cookieHash);
      if (existing) {
        items.push(existing);
        skipped += 1;
        duplicates += 1;
        continue;
      }
      try {
        const created = await this.store.createAccount(input);
        items.push(created);
        added += 1;
      } catch (error) {
        if (!isD1UniqueConstraintError(error)) throw error;
        const duplicate = await this.store.findAccountByCookieHash(cookieHash);
        if (!duplicate) throw error;
        items.push(duplicate);
        skipped += 1;
        duplicates += 1;
      }
    }
    return { added, skipped, duplicates, items };
  }

  async update(body: UnknownRecord): Promise<GeminiAccountMutationResult> {
    const ids = await this.resolveIdentifiersFromBody(body, true);
    const update = updateFromBody(body, this.nowMs());
    if (!hasAccountUpdate(update)) {
      throw new GeminiAccountAdminError(400, "account_update_required", "no account update fields provided");
    }
    const items: GeminiAccountPublic[] = [];
    for (const id of ids) {
      const item = await this.store.updateAccount(id, update);
      if (item) items.push(item);
    }
    return { updated: items.length, skipped: ids.length - items.length, items };
  }

  async setEnabled(body: UnknownRecord, enabled: boolean): Promise<GeminiAccountMutationResult> {
    const ids = await this.resolveIdentifiersFromBody(body, true);
    const nowMs = this.nowMs();
    const items: GeminiAccountPublic[] = [];
    for (const id of ids) {
      const item = await this.store.updateAccount(id, { enabled, nowMs });
      if (item) items.push(item);
    }
    return { updated: items.length, skipped: ids.length - items.length, items };
  }

  async delete(body: UnknownRecord): Promise<GeminiAccountMutationResult> {
    const ids = await this.resolveIdentifiersFromBody(body, true);
    let removed = 0;
    for (const id of ids) {
      if (await this.store.deleteAccount(id)) removed += 1;
    }
    const page = await this.list({ limit: 50 });
    return { removed, skipped: ids.length - removed, items: page.items };
  }

  async refresh(body: UnknownRecord): Promise<GeminiAccountDiagnosticResult> {
    return this.runDiagnostics(body, "refresh");
  }

  async check(body: UnknownRecord): Promise<GeminiAccountDiagnosticResult> {
    return this.runDiagnostics(body, "check");
  }

  private async runDiagnostics(body: UnknownRecord, mode: "refresh" | "check"): Promise<GeminiAccountDiagnosticResult> {
    const ids = await this.resolveIdentifiersFromBody(body, false);
    const targetIds = ids.length ? ids : (await this.list({ limit: 200 })).items.map((item) => item.id);
    if (!targetIds.length) {
      return emptyDiagnostic(await this.list({ limit: 50 }));
    }

    const results: GeminiAccountDiagnosticItem[] = [];
    const errors: GeminiAccountDiagnosticError[] = [];
    await runBounded(targetIds, this.refreshConcurrency, async (id) => {
      const result = await this.refreshOrCheckOne(id, mode);
      results.push(result.item);
      if (result.error) errors.push(result.error);
    });

    const page = await this.list({ limit: 50 });
    return diagnosticResult(results, errors, page.items);
  }

  private async refreshOrCheckOne(id: string, mode: "refresh" | "check"): Promise<{
    item: GeminiAccountDiagnosticItem;
    error?: GeminiAccountDiagnosticError;
  }> {
    const account = await this.store.getAccountForRefresh(id);
    const identity = account ? { id: account.id, row_id: account.row_id } : { id };
    if (!account) {
      return { item: { ...identity, status: "skipped", reason: "account_missing" } };
    }
    if (account.enabled === 0) {
      return { item: { ...identity, status: "skipped", reason: "account_disabled" } };
    }
    if (account.account_category !== "full_session" && account.account_category !== "psid_psidts") {
      return { item: { ...identity, status: "skipped", reason: "not_refreshable" } };
    }
    try {
      const refresh = await this.pool.refreshAccountForAdmin(this.cfg, account, mode);
      return { item: diagnosticItemFromRefresh(identity, refresh) };
    } catch (error) {
      return {
        item: { ...identity, status: "failed", reason: "refresh_error" },
        error: { ...identity, error: safeAdminError(error) },
      };
    }
  }

  private async resolveIdentifiersFromBody(body: UnknownRecord, required: boolean): Promise<string[]> {
    const identifiers = normalizeIdentifiers(body);
    if (!identifiers.length) {
      if (required) throw new GeminiAccountAdminError(400, "account_identifier_required", "id or row_id is required");
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const identifier of identifiers) {
      const lookup: { id?: string; rowId?: string } = {};
      const idCandidate = identifier.id || identifier.account_id;
      if (idCandidate) lookup.id = idCandidate;
      if (identifier.row_id) lookup.rowId = identifier.row_id;
      const id = await this.store.resolveAccountIdentifier(lookup);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (required && !out.length) throw new GeminiAccountAdminError(404, "account_not_found", "account not found");
    return out;
  }
}

export function createGeminiAccountAdminServiceFromEnv(
  env: WorkerEnv | null | undefined,
  cfg: RuntimeConfig,
  options: Partial<Omit<GeminiAccountAdminServiceOptions, "store" | "cfg">> = {},
): GeminiAccountAdminService {
  const db = d1BindingFromEnv(env);
  if (!db) throw new GeminiAccountAdminError(503, "gemini_account_store_unavailable", "Gemini account D1 binding is not configured");
  return createGeminiAccountAdminServiceFromD1(db, cfg, options);
}

export function createGeminiAccountAdminServiceFromD1(
  db: D1DatabaseLike,
  cfg: RuntimeConfig,
  options: Partial<Omit<GeminiAccountAdminServiceOptions, "store" | "cfg">> = {},
): GeminiAccountAdminService {
  return new GeminiAccountAdminService({
    ...options,
    cfg,
    store: new D1GeminiAccountStore(db),
  });
}

function normalizeCreateAccounts(body: UnknownRecord): UnknownRecord[] {
  if (Array.isArray(body.tokens) && body.tokens.some((token) => cleanOptionalString(token))) {
    throw new GeminiAccountAdminError(400, "gemini_import_dual_cookie_only", "Gemini import accepts only __Secure-1PSID and __Secure-1PSIDTS fields");
  }
  const topProvider = cleanOptionalString(body.provider);
  const accountsRaw = Array.isArray(body.accounts) ? body.accounts : [body];
  const accounts = accountsRaw.filter(isRecord);
  if (!accounts.length) throw new GeminiAccountAdminError(400, "gemini_import_account_required", "Gemini account payload is required");
  const topLevelGemini = !topProvider || topProvider === "gemini";
  if (topProvider && topProvider !== "gemini") {
    throw new GeminiAccountAdminError(400, "gemini_provider_mismatch", "Gemini admin endpoints accept only provider=gemini");
  }
  for (const item of accounts) validateCreateAccount(item, topLevelGemini);
  return accounts;
}

function validateCreateAccount(item: UnknownRecord, topLevelGemini: boolean): void {
  const provider = cleanOptionalString(item.provider);
  if (provider && provider !== "gemini") {
    throw new GeminiAccountAdminError(400, "gemini_provider_mismatch", "Gemini import cannot mix other providers");
  }
  if (topLevelGemini && provider && provider !== "gemini") {
    throw new GeminiAccountAdminError(400, "gemini_provider_mismatch", "Gemini import cannot mix other providers");
  }
  for (const key of Object.keys(item)) {
    const value = item[key];
    if (value == null) continue;
    if (UNSAFE_CREATE_KEYS.has(key) || !SAFE_CREATE_KEYS.has(key)) {
      throw new GeminiAccountAdminError(400, "gemini_import_dual_cookie_only", "Gemini import accepts only safe dual cookie fields and metadata");
    }
  }
  const psid = cleanRequiredString(item["__Secure-1PSID"], "__Secure-1PSID");
  const psidts = cleanRequiredString(item["__Secure-1PSIDTS"], "__Secure-1PSIDTS");
  validateBareCookieValue(psid);
  validateBareCookieValue(psidts);
}

function createInputFromAccount(item: UnknownRecord, nowMs: number): GeminiAccountCreateInput {
  const psid = cleanRequiredString(item["__Secure-1PSID"], "__Secure-1PSID");
  const psidts = cleanRequiredString(item["__Secure-1PSIDTS"], "__Secure-1PSIDTS");
  const input: GeminiAccountCreateInput = {
    cookieHeader: `__Secure-1PSID=${psid}; __Secure-1PSIDTS=${psidts}`,
    nowMs,
  };
  const label = cleanOptionalString(item.label);
  const userAgent = cleanOptionalString(item.user_agent);
  const geminiOrigin = cleanOptionalString(item.gemini_origin);
  const source = cleanOptionalString(item.source);
  const sourceId = cleanOptionalString(item.source_id);
  const sourceName = cleanOptionalString(item.source_name);
  if (label) input.label = label;
  if (userAgent) input.userAgent = userAgent;
  if (geminiOrigin) input.geminiOrigin = geminiOrigin;
  if (source) input.source = source;
  if (sourceId) input.sourceId = sourceId;
  if (sourceName) input.sourceName = sourceName;
  return input;
}

function updateFromBody(body: UnknownRecord, nowMs: number): GeminiAccountUpdate {
  const update: GeminiAccountUpdate = { nowMs };
  if ("label" in body) update.label = nullableString(body.label);
  if ("enabled" in body) update.enabled = Boolean(body.enabled);
  if ("status" in body) {
    const status = normalizeStatus(body.status);
    if (status) update.status = status;
  }
  if ("state_reason" in body) update.stateReason = nullableString(body.state_reason);
  if ("cooldown_until_ms" in body) update.cooldownUntilMs = nullableNumber(body.cooldown_until_ms);
  if ("account_status_code" in body) update.accountStatusCode = nullableNumber(body.account_status_code);
  if ("account_status_description" in body) update.accountStatusDescription = nullableString(body.account_status_description);
  if ("user_agent" in body) update.userAgent = nullableString(body.user_agent);
  if ("gemini_origin" in body) update.geminiOrigin = nullableString(body.gemini_origin);
  if ("source" in body) update.source = nullableString(body.source);
  if ("source_id" in body) update.sourceId = nullableString(body.source_id);
  if ("source_name" in body) update.sourceName = nullableString(body.source_name);
  return update;
}

function hasAccountUpdate(update: GeminiAccountUpdate): boolean {
  return Object.keys(update).some((key) => key !== "nowMs");
}

function normalizeIdentifiers(body: UnknownRecord): GeminiAccountIdentifier[] {
  const rawItems = Array.isArray(body.identifiers) ? body.identifiers : [body];
  const out: GeminiAccountIdentifier[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (!isRecord(raw)) continue;
    const id = cleanOptionalString(raw.id) || cleanOptionalString(raw.account_id);
    const rowId = cleanOptionalString(raw.row_id);
    if (!id && !rowId) continue;
    const key = `${id}\0${rowId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const identifier: GeminiAccountIdentifier = {};
    if (id) {
      identifier.id = id;
      identifier.account_id = id;
    }
    if (rowId) identifier.row_id = rowId;
    out.push(identifier);
  }
  return out;
}

function diagnosticItemFromRefresh(
  identity: { id: string; row_id?: string },
  refresh: GeminiAccountRefreshResult,
): GeminiAccountDiagnosticItem {
  const item: GeminiAccountDiagnosticItem = {
    ...identity,
    status: refresh.changed ? "refreshed" : "unchanged",
    reason: refresh.reason,
  };
  if (refresh.upstreamStatus !== undefined) item.upstreamStatus = refresh.upstreamStatus;
  return item;
}

function diagnosticResult(
  results: GeminiAccountDiagnosticItem[],
  errors: GeminiAccountDiagnosticError[],
  items: GeminiAccountPublic[],
): GeminiAccountDiagnosticResult {
  let skipped = 0;
  let refreshed = 0;
  let unchanged = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "skipped") skipped++;
    else if (result.status === "refreshed") refreshed++;
    else if (result.status === "unchanged") unchanged++;
    else if (result.status === "failed") failed++;
  }
  return {
    checked: results.length,
    skipped,
    refreshed,
    unchanged,
    failed,
    errors,
    results: results.sort((a, b) => String(a.id || "").localeCompare(String(b.id || ""))),
    items,
  };
}

function emptyDiagnostic(page: GeminiAccountPublicPage): GeminiAccountDiagnosticResult {
  return { checked: 0, skipped: 0, refreshed: 0, unchanged: 0, failed: 0, errors: [], results: [], items: page.items };
}

function cleanRequiredString(value: unknown, name: string): string {
  const text = cleanOptionalString(value);
  if (!text) throw new GeminiAccountAdminError(400, "gemini_import_missing_cookie_field", `${name} is required`);
  return text;
}

function cleanOptionalString(value: unknown): string {
  return String(value ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/;+$/g, "").trim();
}

function nullableString(value: unknown): string | null {
  const text = cleanOptionalString(value);
  return text || null;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validateBareCookieValue(value: string): void {
  const lowered = value.toLowerCase();
  if (
    value.includes("=")
    || value.includes(";")
    || value.startsWith("{")
    || value.startsWith("[")
    || lowered.includes("__secure-1psid")
    || COOKIE_NAME_RE.test(value)
  ) {
    throw new GeminiAccountAdminError(400, "gemini_import_bare_cookie_value_required", "Gemini cookie fields must contain only the value, not cookie names, equals signs, or semicolons");
  }
}

function normalizeStatus(value: unknown): GeminiAccountStatus | undefined {
  const text = cleanOptionalString(value);
  if (!text) return undefined;
  if (!isGeminiAccountStatus(text)) throw new GeminiAccountAdminError(400, "invalid_account_status", "invalid account status");
  return text;
}

function isGeminiAccountStatus(value: string): value is GeminiAccountStatus {
  return [
    "active",
    "disabled",
    "auth_failed",
    "needs_cookie_update",
    "rate_limited",
    "cooling_down",
    "transient_failed",
    "hard_blocked",
    "needs_user_action",
    "missing_cookie",
    "capability_mismatch",
  ].includes(value);
}

function normalizeCategory(value: unknown): GeminiAccountCategory | undefined {
  const text = cleanOptionalString(value);
  if (!text) return undefined;
  if (!isGeminiAccountCategory(text)) throw new GeminiAccountAdminError(400, "invalid_account_category", "invalid account category");
  return text;
}

function isGeminiAccountCategory(value: string): value is GeminiAccountCategory {
  return ["full_session", "psid_psidts", "psid_only", "session_token_only", "missing_session"].includes(value);
}

function normalizeCooldown(value: unknown): "active" | "cooling" | undefined {
  const text = cleanOptionalString(value);
  if (!text) return undefined;
  if (text === "active" || text === "cooling") return text;
  throw new GeminiAccountAdminError(400, "invalid_cooldown_filter", "invalid cooldown filter");
}

function normalizeListFilter(filter: GeminiAccountAdminFilterInput): GeminiAccountAdminFilter {
  const normalized: GeminiAccountAdminFilter = {
    limit: boundedPageLimit(filter.limit),
  };
  const cursor = cleanOptionalString(filter.cursor);
  if (cursor) normalized.cursor = cursor;
  const status = normalizeStatus(filter.status);
  if (status) normalized.status = status;
  if (typeof filter.enabled === "boolean") normalized.enabled = filter.enabled;
  const q = cleanOptionalString(filter.q);
  if (q) normalized.q = q.slice(0, 200);
  const category = normalizeCategory(filter.category);
  if (category) normalized.category = category;
  const cooldown = normalizeCooldown(filter.cooldown);
  if (cooldown) normalized.cooldown = cooldown;
  const source = cleanOptionalString(filter.source);
  if (source) normalized.source = source.slice(0, 200);
  return normalized;
}

function boundedPageLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isInteger(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}

function boundedConcurrency(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n)) return DEFAULT_REFRESH_CONCURRENCY;
  return Math.min(Math.max(n, 1), MAX_REFRESH_CONCURRENCY);
}

async function runBounded<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index++;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}

function safeAdminError(error: unknown): string {
  if (error instanceof GeminiAccountAdminError) return error.code;
  return errorLogSummary(error);
}
