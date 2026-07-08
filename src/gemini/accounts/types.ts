export type D1Result<T = unknown> = {
  results?: T[];
  success?: boolean;
  meta?: D1ResultMeta;
};

export type D1ResultMeta = {
  changes?: number;
  changedRows?: number;
  rows_written?: number;
  rowsWritten?: number;
  last_row_id?: number;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatementLike;
  batch?<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1Result<T>[]>;
};

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(columnName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
};

export type GeminiAccountStatus =
  | "active"
  | "disabled"
  | "auth_failed"
  | "needs_cookie_update"
  | "rate_limited"
  | "cooling_down"
  | "transient_failed"
  | "hard_blocked"
  | "needs_user_action"
  | "missing_cookie"
  | "capability_mismatch";

export type GeminiAccountFailureKind =
  | "auth"
  | "rate_limit"
  | "usage_limit"
  | "transient"
  | "hard_block"
  | "needs_user_action"
  | "capability_mismatch"
  | "unknown";

export type GeminiAccountCategory =
  | "full_session"
  | "psid_psidts"
  | "psid_only"
  | "session_token_only"
  | "missing_session";

export type GeminiAccountRow = {
  id: string;
  label: string | null;
  enabled: number;
  status: GeminiAccountStatus;
  state_reason: string | null;
  row_id: string;
  cookie_header: string;
  cookie_hash: string;
  sapisid: string | null;
  session_token: string | null;
  session_token_hash: string | null;
  session_id: string | null;
  language: string | null;
  push_id: string | null;
  last_token_bootstrap_at_ms: number | null;
  secure_1psid_hash: string;
  secure_1psidts_hash: string | null;
  account_category: GeminiAccountCategory | null;
  account_status_code: number | null;
  account_status_description: string | null;
  user_agent: string | null;
  gemini_origin: string | null;
  source: string | null;
  source_id: string | null;
  source_name: string | null;
  imported_at_ms: number | null;
  cooldown_until_ms: number | null;
  last_used_at_ms: number | null;
  last_success_at_ms: number | null;
  last_failure_at_ms: number | null;
  last_refresh_at_ms: number | null;
  last_refresh_attempt_at_ms: number | null;
  last_error_code: string | null;
  last_error_message_redacted: string | null;
  last_upstream_status: number | null;
  last_capability_probe_at_ms: number | null;
  capability_summary_json: string | null;
  success_count: number;
  failure_count: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type GeminiAccountSnapshotRow = Pick<
  GeminiAccountRow,
  | "id"
  | "label"
  | "status"
  | "cookie_header"
  | "cookie_hash"
  | "sapisid"
  | "session_token"
  | "session_token_hash"
  | "user_agent"
  | "gemini_origin"
  | "cooldown_until_ms"
  | "last_used_at_ms"
  | "last_success_at_ms"
  | "last_failure_at_ms"
>;

export type GeminiAccountSecretRow = GeminiAccountRow;

export type GeminiAccountPublic = Omit<GeminiAccountRow, "cookie_header" | "sapisid" | "session_token"> & {
  has_cookie: boolean;
  has_sapisid: boolean;
  has_session_token: boolean;
  cookie_preview: string;
};

export type GeminiAccountAdminFilter = {
  limit: number;
  cursor?: string;
  status?: GeminiAccountStatus;
  enabled?: boolean;
};

export type GeminiAccountPublicPage = {
  items: GeminiAccountPublic[];
  nextCursor: string | null;
  limit: number;
};

export type GeminiAccountCreateInput = {
  id?: string;
  label?: string;
  cookieHeader: string;
  sapisid?: string;
  sessionToken?: string;
  sessionId?: string;
  language?: string;
  pushId?: string;
  userAgent?: string;
  geminiOrigin?: string;
  source?: string;
  sourceId?: string;
  sourceName?: string;
  nowMs: number;
};

export type GeminiAccountUpdate = {
  label?: string | null;
  enabled?: boolean;
  status?: GeminiAccountStatus;
  stateReason?: string | null;
  cooldownUntilMs?: number | null;
  accountStatusCode?: number | null;
  accountStatusDescription?: string | null;
  userAgent?: string | null;
  geminiOrigin?: string | null;
  source?: string | null;
  sourceId?: string | null;
  sourceName?: string | null;
  nowMs: number;
};

export type GeminiCookieWriteback = {
  cookieHeader: string;
  sapisid?: string | null;
  sessionToken?: string | null;
  sessionId?: string | null;
  language?: string | null;
  pushId?: string | null;
  lastRefreshAtMs?: number | null;
  lastRefreshAttemptAtMs?: number | null;
  status?: GeminiAccountStatus;
  stateReason?: string | null;
  nowMs: number;
};

export type GeminiCookieWritebackResult = {
  changed: boolean;
};

export type GeminiAccountOutcome = {
  kind: "success" | "failure";
  failureKind?: GeminiAccountFailureKind;
  status?: GeminiAccountStatus;
  stateReason?: string | null;
  cooldownUntilMs?: number | null;
  upstreamStatus?: number | null;
  errorCode?: string | null;
  errorMessageRedacted?: string | null;
  nowMs: number;
};

export type GeminiAccountStore = {
  getPoolVersion(): Promise<string>;
  listSelectableAccounts(nowMs: number, limit: number): Promise<GeminiAccountSnapshotRow[]>;
  listAdminAccounts(filter: GeminiAccountAdminFilter): Promise<GeminiAccountPublicPage>;
  getAccountForRefresh(accountId: string): Promise<GeminiAccountSecretRow | null>;
  resolveAccountIdentifier(input: { id?: string; rowId?: string }): Promise<string | null>;
  createAccount(input: GeminiAccountCreateInput): Promise<GeminiAccountPublic>;
  updateAccount(accountId: string, update: GeminiAccountUpdate): Promise<GeminiAccountPublic | null>;
  deleteAccount(accountId: string): Promise<boolean>;
  tryAcquireRefreshLock(accountId: string, owner: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  releaseRefreshLock(accountId: string, owner: string): Promise<void>;
  writeCookieState(accountId: string, update: GeminiCookieWriteback): Promise<GeminiCookieWritebackResult>;
  writeAccountOutcome(accountId: string, outcome: GeminiAccountOutcome): Promise<void>;
};
