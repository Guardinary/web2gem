# Gemini Account Protocol

## Scenario: Stable Identity And Capability Storage

### 1. Scope / Trigger

Use this contract when changing account import, D1 account schema, Cookie refresh writeback, status persistence, or model-capability storage.

### 2. Signatures

- `identityHashFromCookie(cookie)` is SHA-256 of normalized bare `__Secure-1PSID`.
- `cookie_hash` is SHA-256 of the complete normalized stored Cookie header.
- `gemini_accounts.identity_hash` is `NOT NULL UNIQUE`.
- `gemini_account_models` is keyed by `(account_id, model_id)` and stores
  bounded display metadata, availability, capacity `1..4`, capacity field
  `12|13`, model number `1..64`, discovery order `0..127`, and `checked_at_ms`.
- `gemini_model_route_priority` stores one ordered exact tuple per known family
  and mutation batches bump `gemini_pool_meta.pool_version`.

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
- Atomic bounded capability replacement, failed-probe preservation, exact route
  priority replacement/reset, Worker/Docker query parity, and bind redaction.
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
- Lease requirements carry ordered exact
  `(providerModelId, capacity, capacityField, modelNumber)` candidates and a
  freshness cutoff; a successful lease returns `selectedRoute`.

### 3. Contracts

- Resolve known public names to family plus extended intent; resolve unknown
  public IDs through the live/persisted model catalog before account acquisition.
- Reconcile saved family priority by retaining missing saved tuples in storage,
  skipping them at runtime, and appending newly discovered tuples in discovery
  order. Standard and `-extended` names share candidates.
- Evaluate exact candidates in priority order before least-local-in-flight and
  round-robin account selection within a candidate.
- `prefer`: choose fresh known-capable accounts first; use unknown/stale accounts only when no known-capable account exists. Fresh known-incapable accounts are skipped.
- `strict`: return no account unless a fresh known-capable account exists. `off`: preserve ordinary pool selection.
- Unknown dynamic IDs never invent a Basic or stale/unprobed route fallback.
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

- Good: Pro request selects the first configured exact tuple that has a fresh
  eligible account, and payload/header use the lease's same tuple.
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

## Scenario: Dynamic Model Headers And Passive Session Maintenance

### 1. Scope / Trigger

Use this contract when changing GetUserStatus capacity decoding, selected
account model headers, Gemini response Cookie handling, or account import
initialization.

### 2. Signatures

- Probe models carry `{ modelId, displayName, description, available, capacity,
  capacityField, modelNumber, discoveryOrder }`.
- Known capacity precedence returns `(1,13)` for tier `21`, `(2,13)` for tier
  `22`, `(4,12)` for capability `115`, `(3,12)` for tier `16` or capability
  `106`, `(2,12)` for tier `8` or capability `19`, and `(1,12)` otherwise.
- A lease exposes `selectedRoute`, `modelCapability`, and
  `flushObservedCookies()`.
- `buildGeminiModelHeaders(route, extended, sessionId)` writes provider ID,
  capacity, capacity field, model number, extended flag `1|2`, and one
  provider-session UUID. Generation payload indexes are `17=[[0]]`,
  `79=modelNumber`, and `80=extended ? 2 : 1`.
- `RuntimeConfig.gemini_account.observeSetCookie(values)` is an internal
  in-memory response observer.
- Account import schedules one full `refreshAccountForAdmin` for each newly
  created canonical account ID with concurrency `4`.

### 3. Contracts

- Narrow and bound unknown flag arrays in `probe.ts`; never persist raw flags.
- Public resolution never carries `modelHeaders`. Authenticated execution builds
  model headers only after exact-route lease selection and uses that same route's
  model number in the payload.
- Anonymous generation is limited to Flash-family plain text/stream requests.
  It uses model number `1`, extended flag `1|2`, no model-specific header, no
  credentials, and no D1 read before a non-abort pre-output fallback is needed.
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
- Malformed D1 route tuples -> skip at the row-mapping boundary; do not use type
  assertions to admit them into catalog, priority, or lease state.
- Anonymous Pro, Flash Lite, attachment, rich/image, or large-context request ->
  bypass anonymous and require authenticated routing.
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
- Base: a known family in `prefer` mode may use its internal Basic tuple for an
  unprobed/stale account only when no discovered exact tuple is selectable.
- Bad: expose a static/public `modelHeaders` field, use the first integer in
  upstream flags, write Cookie headers directly inside the client, persist page
  tokens, or probe unchanged imports.

### 6. Tests Required

- Cover every documented capacity branch, field-12/field-13 header shape,
  standard/extended payload flags, anonymous header absence, and stale fallback.
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
const resolved = await runtime.resolveModel(name, defaultName, freshAfterMs);
const routes = await runtime.routeCandidatesForModel(resolved, freshAfterMs, mode);
const lease = await runtime.acquireLease(cfg, { routeCandidates: routes });
const headers = buildGeminiModelHeaders(lease.selectedRoute, resolved.extended, sessionId);
```

## Scenario: Public Model Catalog And Admin Route Policy

### 1. Scope / Trigger

Use this contract when changing `/v1/models`, `/v1beta/models`, dynamic model
resolution, model-routing Admin API/WebUI, or route-priority persistence.

### 2. Signatures

- Known public names are exactly `gemini-3.1-pro`, `gemini-3.5-flash`,
  `gemini-3.1-flash-lite`, and their `-extended` variants.
- Unknown discovered IDs project to `<id>` and `<id>-extended`.
- Admin endpoints are `GET /admin/model-routing`, `PUT
  /admin/model-routing/{family}`, and `DELETE /admin/model-routing/{family}`.
- PUT body is `{ routes: GeminiRouteTuple[] }`, maximum 128 unique tuples.

### 3. Contracts

- Build one ordered catalog: anonymous Flash pair first, then fresh available
  account records in pool/discovery order with first-public-ID wins. If no fresh
  catalog is usable, use the last complete persisted model snapshot.
- OpenAI and Google lists/details project the same IDs/order; health stays fixed
  to six known names and never reads D1 or exposes dynamic IDs.
- Ordinary public auth happens before catalog D1 access. Catalog D1 failure
  degrades to the anonymous Flash pair.
- Basic/Plus/Advanced labels and exact tuples are ADMIN_KEY-only internal data.
  Custom model configuration is unsupported.
- Admin overview retains saved missing routes, appends new discovery routes, and
  exposes only bounded tuple facts, known label, availability, configured flag,
  and account count.

### 4. Validation & Error Matrix

- Removed alias or `@think=N` -> protocol-specific model-not-found.
- Unknown dynamic ID absent from current/fallback catalog -> model-not-found.
- Invalid family, extra body key, malformed/duplicate/oversized tuple array ->
  sanitized 4xx; policy and `pool_version` unchanged.
- Submitted tuple absent from persisted discovery and saved policy ->
  `unknown_model_route`; policy unchanged.
- Missing/invalid ADMIN_KEY -> 401 before routing-policy D1 access.

### 5. Good/Base/Bad Cases

- Good: reorder Pro routes in WebUI; the next Worker and Docker request use the
  new order without deployment, while Flash and Flash Lite stay unchanged.
- Base: no D1 returns exactly the Flash standard/extended pair in both APIs.
- Bad: serialize module-load model constants, expose provider tuples publicly,
  delete missing saved routes, or accept arbitrary custom model IDs.

### 6. Tests Required

- Assert no-D1 Flash pair, live/persisted dynamic IDs, OpenAI/Google ID-order
  parity, known/unknown details, health D1 absence, and auth-before-D1 ordering.
- Assert three-family independence, capacity-3/field-13 round trip, missing/new
  reconciliation, invalid mutation atomicity, save/reset cache invalidation, and
  strict browser DTO validation.
- Run static, type, architecture, account/runtime, HTTP, Admin UI, Docker, smoke,
  Worker-type, benchmark, size, full unit, and coverage gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
const list = Object.keys(MODELS);
await store.replaceModelRoutePriority(family, unvalidatedRoutes, nowMs);
```

#### Correct

```typescript
const catalog = await runtime.modelCatalog(freshAfterMs);
const routes = normalizeModelRoutePriority(body);
await service.replaceModelRoutePriority(family, routes);
```
