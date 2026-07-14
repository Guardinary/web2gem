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

## Scenario: Account-derived Headers And Passive Session Maintenance

### 1. Scope / Trigger

Use this contract when changing GetUserStatus capacity decoding, selected
account model headers, Gemini response Cookie handling, or account import
initialization.

### 2. Signatures

- Probe models carry `{ modelId, available, capacity, capacityField }`.
- Known capacity precedence returns `(1,13)` for tier `21`, `(2,13)` for tier
  `22`, `(4,12)` for capability `115`, `(3,12)` for tier `16` or capability
  `106`, `(2,12)` for tier `8` or capability `19`, and `(1,12)` otherwise.
- A lease exposes `modelCapability` and `flushObservedCookies()`.
- `RuntimeConfig.gemini_account.observeSetCookie(values)` is an internal
  in-memory response observer.
- Account import schedules one full `refreshAccountForAdmin` for each newly
  created canonical account ID with concurrency `4`.

### 3. Contracts

- Narrow and bound unknown flag arrays in `probe.ts`; never persist raw flags.
- Keep the public model catalog static. Apply account capacity only when the
  stored capability is fresh, available, matches the requested provider model
  ID, and uses field `12` or `13`; otherwise preserve the static header.
- Invoke the Cookie observer only from successful Gemini `/app` and
  `StreamGenerate` responses. The client stages header values and performs no
  D1 write.
- Flush staged Cookies only after logical request success. Re-read the current
  account under the existing distributed refresh lock, merge response Cookies,
  remove `SNlM0e`, `at`, and `session_token`, verify stable PSID identity, skip
  unchanged hashes, and use the duplicate-safe Cookie writer.
- Failed, aborted, or retired leases discard staged response Cookies.
- Worker success maintenance uses the bound `execution_ctx.waitUntil`; Docker
  awaits it. Cookie persistence failure never changes model output.
- Import probing applies only to newly created identities. Worker imports
  register the bounded batch with `waitUntil`; Docker imports await the batch.
  Probe failures never change the compact import mutation counts.

### 4. Validation & Error Matrix

- Unknown/malformed flags -> bounded default capacity `(1,12)`.
- Stale, unavailable, mismatched, or invalid stored capability -> static model
  header.
- Non-success response, anonymous config, or no `Set-Cookie` -> no observation.
- Missing/changed PSID, unchanged normalized hash, duplicate Cookie, or lock
  conflict -> no passive lease mutation.
- Successful Cookie write -> update lease Cookie, hash, config, local snapshot,
  and session freshness together.
- Re-imported existing identity -> no automatic probe; new identity -> exactly
  one bounded probe.

### 5. Good/Base/Bad Cases

- Good: a fresh Plus capability rewrites field 12 to capacity 4 for the leased
  account, then a successful response asynchronously persists a new PSIDTS.
- Base: an unprobed `prefer` fallback uses the static model header and remains
  compatible.
- Bad: use the first integer in upstream flags, write Cookie headers directly
  inside the client, persist page tokens, or probe unchanged imports.

### 6. Tests Required

- Cover every documented capacity branch, field-12/field-13 header shape, and
  stale/mismatched fallback.
- Cover capability metadata through D1 snapshot, pool selection, lease, and
  text/rich/stream delegate headers.
- Cover `/app` and StreamGenerate observation, transient-field filtering,
  identity mismatch, unchanged hash, duplicate race, lock conflict, Worker
  `waitUntil`, Docker awaiting, and background failure isolation.
- Cover new-only import probing, concurrency `4`, compact mutation preservation,
  static/type/architecture, full unit, coverage, benchmark, size, Worker types,
  and smoke gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
const capacity = firstBoundedInt(tierFlags);
await store.writeRefreshedCookie(accountId, mergeCookies(response.headers));
```

#### Correct

```typescript
const probe = decodeGeminiAccountProbe(rawStatusResponse);
observeGeminiAccountResponseCookies(cfg, response);
cfg.execution_ctx.waitUntil(guardedMaintenance);
```
