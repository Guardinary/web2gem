# Gemini Account Protocol

## Scenario: Stable Identity And Capability Storage

### 1. Scope / Trigger

Use this contract when changing account import, D1 account schema, Cookie refresh writeback, status persistence, or model-capability storage.

### 2. Signatures

- `identityHashFromCookie(cookie)` is SHA-256 of normalized bare `__Secure-1PSID`.
- `cookie_hash` is SHA-256 of the complete normalized stored Cookie header.
- `gemini_accounts.identity_hash` is `NOT NULL UNIQUE`.
- `gemini_account_models` is keyed by `(account_id, model_id)` and stores availability, bounded capacity fields, and `checked_at_ms`.

### 3. Contracts

- This is a pre-release schema: edit `migrations/0001_gemini_accounts.sql` directly and reset older development databases. Do not add backfill, compatibility gates, or nullable legacy identity states.
- Re-importing the same PSID with a changed PSIDTS updates the canonical account ID and credential version.
- Concurrent same-identity imports converge through the unique identity constraint and canonical re-read/upsert behavior.
- Raw Cookies, identity hashes, Cookie hashes, RPC arrays, localized model descriptions, and raw status payloads never enter admin DTOs or logs.
- Replace capability rows only after a complete successful probe. Failed/empty/unknown probes preserve the previous snapshot as stale.

### 4. Validation & Error Matrix

- Missing PSID -> reject before persistence.
- Same identity, same credential version -> unchanged import.
- Same identity, new credential version -> update canonical row and invalidate credential-scoped caches through `cookie_hash`.
- Duplicate full Cookie under another identity -> unique-constraint failure; never merge identities silently.
- Probe decode failure -> no status-health success and no capability replacement.

### 5. Good/Base/Bad Cases

- Good: one PSID row survives repeated PSIDTS rotation imports.
- Base: a new PSID creates one new account and capability rows only after probing.
- Bad: use the full Cookie hash as stable identity or expose identity hashes for conflict diagnostics.

### 6. Tests Required

- Fresh-schema initialization and required unique identity.
- Same-identity re-import and concurrent uniqueness convergence.
- Cookie-version change without account-ID change.
- Atomic bounded capability replacement, failed-probe preservation, Worker/Docker query parity, and bind redaction.
- Run account, Docker, static, type, architecture, Worker-type, and full unit gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
const identityHash = await sha256Hex(normalizedCookieHeader);
```

#### Correct

```typescript
const identityHash = await identityHashFromCookie(normalizedCookieHeader);
const cookieHash = await sha256Hex(normalizedCookieHeader);
```

## Scenario: Capability-aware Selection And Session Freshness

### 1. Scope / Trigger

Use this contract when changing account lease selection, model-header resolution, cross-account attempt budgets, or post-success session maintenance.

### 2. Signatures

- `GEMINI_ACCOUNT_CAPABILITY_MODE`: `off|prefer|strict`, default `prefer`.
- `GEMINI_ACCOUNT_CAPABILITY_TTL_SEC`: `60..604800`, default `3600`.
- `GEMINI_ACCOUNT_MAX_ATTEMPTS`: any positive safe integer, default `10`.
- `GEMINI_ACCOUNT_REFRESH_INTERVAL_SEC`: `0` or `60..604800`, default `600`.
- Lease requirements carry provider model ID and freshness cutoff.

### 3. Contracts

- Resolve provider model ID from the selected static Gemini model header before account acquisition.
- `prefer`: choose fresh known-capable accounts first; use unknown/stale accounts only when no known-capable account exists. Fresh known-incapable accounts are skipped.
- `strict`: return no account unless a fresh known-capable account exists. `off`: preserve ordinary pool selection.
- Preserve least-local-in-flight and round-robin ordering within a capability tier.
- Cross-account budget counts distinct account IDs, not same-account transport retries. Never retry one ID solely to spend the budget; eligible pool size is the natural ceiling.
- Semantic recovery scope, abort, stream output, and attachment replay safety remain stronger gates than numeric budget.
- Successful Worker requests may schedule session-only maintenance through the bound `execution_ctx.waitUntil(promise)`. It must not block/change the response or run the full status/capability probe.

### 4. Validation & Error Matrix

- Prefer + known capable -> select known capable.
- Prefer + only unknown/stale -> compatibility fallback.
- Strict + no fresh known capable -> `no_available_gemini_account`.
- Static/global `1052`, StreamGenerate `1060`, abort, post-delta failure, or opaque refs -> no blind pool traversal.
- Refresh interval `0` or fresh session -> no background refresh.
- `waitUntil` registration/background failure -> safe log only; completed response remains successful.

### 5. Good/Base/Bad Cases

- Good: Pro request selects the account whose fresh probe contains the provider model ID.
- Base: an unprobed pool remains usable in `prefer` mode.
- Bad: query capability rows once per candidate on every request or destructure `waitUntil` from the execution context.

### 6. Tests Required

- Off/prefer/strict tier selection, fresh/stale/unknown/incapable snapshots, and bounded D1 reads.
- Default ten attempts, configured large value, natural pool exhaustion, and transport-retry separation.
- Abort/post-delta/attachment/static-error guards.
- `waitUntil` registration, interval disable/freshness, lock/dedupe reuse, and background failure isolation.
- Run focused HTTP/runtime tests, full unit, benchmark, size, Worker types, static, type, and architecture gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
const { waitUntil } = cfg.execution_ctx;
waitUntil(refreshPromise);
```

#### Correct

```typescript
cfg.execution_ctx.waitUntil(refreshPromise);
```
