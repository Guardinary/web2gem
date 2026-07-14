CREATE TABLE IF NOT EXISTS gemini_accounts (
  id TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  cookie_header TEXT NOT NULL,
  cookie_hash TEXT NOT NULL UNIQUE,
  issue TEXT CHECK (
    issue IS NULL OR issue IN (
      'auth', 'rate_limit', 'user_action', 'location', 'transient'
    )
  ),
  cooldown_until_ms INTEGER,
  last_issue_at_ms INTEGER,
  last_used_at_ms INTEGER,
  last_refresh_at_ms INTEGER,
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
  ON gemini_accounts (enabled, issue, cooldown_until_ms, last_used_at_ms);

INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
VALUES ('schema_version', '1', unixepoch() * 1000)
ON CONFLICT(key) DO NOTHING;

INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
VALUES ('pool_version', '0', unixepoch() * 1000)
ON CONFLICT(key) DO NOTHING;
