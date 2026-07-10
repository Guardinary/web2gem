CREATE TABLE IF NOT EXISTS gemini_accounts (
  id TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  state_reason TEXT,
  row_id TEXT NOT NULL UNIQUE,
  cookie_header TEXT NOT NULL,
  cookie_hash TEXT NOT NULL,
  sapisid TEXT,
  session_token TEXT,
  session_token_hash TEXT,
  session_id TEXT,
  language TEXT,
  push_id TEXT,
  last_token_bootstrap_at_ms INTEGER,
  secure_1psid_hash TEXT NOT NULL,
  secure_1psidts_hash TEXT,
  account_category TEXT,
  account_status_code INTEGER,
  account_status_description TEXT,
  user_agent TEXT,
  gemini_origin TEXT,
  source TEXT,
  source_id TEXT,
  source_name TEXT,
  imported_at_ms INTEGER,
  cooldown_until_ms INTEGER,
  last_used_at_ms INTEGER,
  last_success_at_ms INTEGER,
  last_failure_at_ms INTEGER,
  last_refresh_at_ms INTEGER,
  last_refresh_attempt_at_ms INTEGER,
  last_error_code TEXT,
  last_error_message_redacted TEXT,
  last_upstream_status INTEGER,
  last_capability_probe_at_ms INTEGER,
  capability_summary_json TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gemini_pool_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS gemini_account_locks (
  account_id TEXT PRIMARY KEY,
  lock_owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_select
  ON gemini_accounts (enabled, status, cooldown_until_ms, last_used_at_ms);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_psid
  ON gemini_accounts (secure_1psid_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gemini_accounts_cookie_hash
  ON gemini_accounts (cookie_hash);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_category
  ON gemini_accounts (account_category);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_row_id
  ON gemini_accounts (row_id);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_source
  ON gemini_accounts (source_id);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_updated
  ON gemini_accounts (updated_at_ms);

INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
VALUES ('schema_version', '1', unixepoch() * 1000)
ON CONFLICT(key) DO NOTHING;

INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
VALUES ('pool_version', '0', unixepoch() * 1000)
ON CONFLICT(key) DO NOTHING;
