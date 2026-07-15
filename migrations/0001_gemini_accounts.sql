CREATE TABLE IF NOT EXISTS gemini_accounts (
  id TEXT PRIMARY KEY,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  cookie_header TEXT NOT NULL,
  cookie_hash TEXT NOT NULL UNIQUE,
  identity_hash TEXT NOT NULL UNIQUE,
  issue TEXT CHECK (
    issue IS NULL OR issue IN (
      'auth', 'rate_limit', 'user_action', 'location', 'transient'
    )
  ),
  cooldown_until_ms INTEGER,
  last_issue_at_ms INTEGER,
  last_used_at_ms INTEGER,
  last_refresh_at_ms INTEGER,
  account_status_code INTEGER,
  status_checked_at_ms INTEGER,
  last_refresh_attempt_at_ms INTEGER,
  last_refresh_success_at_ms INTEGER,
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

CREATE TABLE IF NOT EXISTS gemini_account_models (
  account_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  available INTEGER NOT NULL CHECK (available IN (0, 1)),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 4),
  capacity_field INTEGER NOT NULL CHECK (capacity_field IN (12, 13)),
  model_number INTEGER NOT NULL CHECK (model_number BETWEEN 1 AND 64),
  discovery_order INTEGER NOT NULL CHECK (discovery_order BETWEEN 0 AND 127),
  checked_at_ms INTEGER NOT NULL,
  PRIMARY KEY (account_id, model_id),
  FOREIGN KEY (account_id) REFERENCES gemini_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gemini_model_route_priority (
  family TEXT NOT NULL CHECK (family IN ('pro', 'flash', 'flash_lite')),
  provider_model_id TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 4),
  capacity_field INTEGER NOT NULL CHECK (capacity_field IN (12, 13)),
  model_number INTEGER NOT NULL CHECK (model_number BETWEEN 1 AND 64),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 127),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (
    family, provider_model_id, capacity, capacity_field, model_number
  ),
  UNIQUE (family, priority)
);

CREATE INDEX IF NOT EXISTS idx_gemini_accounts_select
  ON gemini_accounts (enabled, issue, cooldown_until_ms, last_used_at_ms);

CREATE INDEX IF NOT EXISTS idx_gemini_account_models_select
  ON gemini_account_models (model_id, available, checked_at_ms, account_id);

CREATE INDEX IF NOT EXISTS idx_gemini_account_models_discovery
  ON gemini_account_models (account_id, discovery_order);

INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
VALUES ('schema_version', '3', unixepoch() * 1000)
ON CONFLICT(key) DO NOTHING;

INSERT INTO gemini_pool_meta (key, value, updated_at_ms)
VALUES ('pool_version', '0', unixepoch() * 1000)
ON CONFLICT(key) DO NOTHING;
