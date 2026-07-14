# Runtime Performance And Transport

## Scenario: Socket HTTP Transport

### 1. Scope / Trigger

Use this contract when changing Gemini upstream transport, socket pooling, response body parsing, compression handling, or fetch fallback behavior.

### 2. Signatures

- `httpFetch(url, { method, headers, body, bodyLength, timeoutMs, socket, signal, cfg, acceptCompressed })` is the unified upstream entrypoint.
- `socketHttp(connect, url, { method, headers, body, bodyLength, timeoutMs, signal, keepAlive, pool, acceptCompressed })` owns HTTP/1.1 over `cloudflare:sockets`.
- `createSocketPool()`, `getDefaultSocketPool()`, and `closeIdleSocketPool(pool?)` own reusable idle sockets.
- `parseHttpChunkSizeLine(line: Uint8Array)` returns a safe integer chunk size or `-1`.

### 3. Contracts

- `httpFetch` should prefer socket transport when enabled and available, then fall back to `fetch` only for non-abort socket failures that occur before an upstream response status is exposed.
- Abort errors must not fall back to `fetch`; they must preserve request cancellation.
- Errors with upstream response metadata, such as `upstreamStatus`, must not fall back because the request may already have reached Gemini.
- `httpFetch` defaults socket `acceptCompressed` to `true` for `GET` and `false` for other methods unless explicitly provided.
- `socketHttp` sends `Accept-Encoding: gzip` only when `acceptCompressed` is true and `DecompressionStream("gzip")` is supported. Otherwise it sends `identity`.
- Streaming request bodies must provide a safe integer `bodyLength`. Socket transport uses it for `Content-Length` and writes chunks sequentially; fetch transport may use fixed-length Worker streams.
- Socket fallback with a streaming request body is allowed only before socket transport starts reading the body stream. Once the body stream has been read or written, do not retry through `fetch` because the body is no longer safely replayable.
- When a supported gzip response is decoded, remove `content-encoding` and `content-length` from the response headers exposed to callers.
- Unsupported or unsolicited compressed responses must remain raw bytes; do not construct unsupported decompression streams.
- Chunked response parsing must accept valid chunk extensions such as `5;foo=bar`, reject invalid hex, reject unsafe integer sizes, and tolerate split chunk-size lines across socket reads.
- `ByteQueue.readHttpChunkSizeLineIfAvailable()` must parse chunk-size digits incrementally while scanning for CRLF. Do not rescan and reparse the complete line after the terminator is found; long extensions may arrive one byte per socket read.
- Keep-alive sockets are pooled per origin, capped by `SOCKET_KEEP_ALIVE_MAX_IDLE_PER_ORIGIN`, and expire after `SOCKET_KEEP_ALIVE_IDLE_MS`.

### 4. Validation & Error Matrix

- `cloudflare:sockets` unavailable -> `httpFetch` uses normal `fetch`.
- Socket connection/read/write error before upstream response status and request not aborted -> `httpFetch` logs safe metadata and falls back to `fetch`.
- Socket error with `upstreamStatus` metadata -> no fallback; propagate the socket error.
- `signal.aborted` or socket abort error -> throw abort, no fallback.
- `acceptCompressed=true`, gzip support present, gzip response -> caller sees decompressed body and no compression headers.
- `acceptCompressed=true`, gzip support absent -> request advertises `identity`; a gzip response remains raw.
- Chunk size line `5;foo=bar` -> parse as `5`.
- Chunk size line `a ;ext=1`, `Z`, or an unsafe integer -> stream error with `socket: invalid chunk size`.

### 5. Good/Base/Bad Cases

- Good: add a new response parser behavior in `socket.ts` and cover both split-buffer and normal-buffer reads.
- Base: socket transport preserves method, headers, body, timeout, auth cookies, model selection, and file references when falling back through `httpFetch`.
- Bad: fall back to anonymous or header-stripped fetch after a socket failure.
- Bad: send `Accept-Encoding: gzip` from socket code when the runtime cannot build a gzip `DecompressionStream`.
- Bad: parse chunk sizes with `parseInt(TEXT_DECODER.decode(line), 16)` without validating the full size token.

### 6. Tests Required

- Unit test `parseHttpChunkSizeLine` for valid extensions, invalid hex, whitespace edge cases, and unsafe sizes.
- Unit test socket gzip decoding when `CompressionStream` and `DecompressionStream` are present.
- Unit test unsupported decompression behavior by patching `DecompressionStream` away.
- Unit test keep-alive reuse and expiry/cap behavior after changing socket pooling.
- Unit test a long chunk extension split across one-byte queue pushes and assert the parsed size plus remaining body bytes.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke` after changing transport fallback or socket response parsing.

### 7. Wrong vs Correct

#### Wrong

```typescript
const sizeText = TEXT_DECODER.decode(line).trim().split(";")[0] || "";
const chunkSize = parseInt(sizeText, 16);
```

#### Correct

```typescript
const chunkSize = parseHttpChunkSizeLine(line);
if (chunkSize < 0) throw new Error("socket: invalid chunk size");
```

## Scenario: Runtime Benchmark Regression Gates

### 1. Scope / Trigger

Use this contract when adding benchmark cases, changing hot-path algorithms, changing `scripts/bench.mjs`, or changing `scripts/check-benchmark.mjs`.

### 2. Signatures

- `BENCH_JSON=1 node scripts/bench.mjs` emits one JSON document with `{ iterations, warmup, filters, results }`.
- Each result contains `name`, `iterations`, `warmup`, `medianMs`, `p95Ms`, `p99Ms`, `meanMs`, `opsPerSec`, and optional `details`.
- `pnpm check:bench` gates a representative default case matrix.
- `BENCH_GATE_BUDGETS` may override the matrix with a JSON object mapping benchmark names to positive maximum median milliseconds.
- `BENCH_GATE_CASE` plus `BENCH_MAX_MEDIAN_MS` remains the explicit single-case compatibility mode.
- `BENCH_ACCOUNT_ADMIN_COUNT` controls the account-admin fixture population and
  defaults to 1000; the default overview case projects 200 rows and the bulk
  action case mutates 100 IDs.

### 3. Contracts

- Human-readable benchmark output remains the default for local investigation; the performance gate consumes machine-readable output.
- The default gate must cover more than one subsystem. It currently includes held tool sieving, cumulative stream extraction, split socket chunk-line parsing, structured-output uniqueness, account overview reads, and bulk account mutation orchestration.
- Every gated result must contain a finite numeric `medianMs`; missing, `null`, string, or non-finite values fail closed.
- Thresholds are absolute CI regression ceilings with hardware headroom, not claims about a specific workstation baseline.
- Default account-admin median ceilings are 0.1 ms for overview projection and
  0.5 ms for 100-ID bulk mutation orchestration.
- Intentional delay cases such as `sse_slow_consumer` remain observational and must not enter the CPU gate.
- Optimize only after repeated baseline runs. If an attempted fast path is slower, remove it instead of weakening the benchmark.
- `createStreamTextExtractor` may retain the complete previous raw value only while it is small enough for exact append comparison. For larger cumulative values, retain length plus bounded head/tail probes so prior large responses can be collected while append detection stays bounded.

### 4. Validation & Error Matrix

- Gated result is missing -> `Benchmark gate failed: missing benchmark median for <case>`.
- `medianMs` exceeds its case budget -> fail with measured and maximum formatted durations.
- `BENCH_GATE_BUDGETS` is malformed, empty, or contains non-positive values -> fail before running comparisons.
- Legacy text snapshot with an explicit input path -> parse the selected single-case median for compatibility.
- JSON output requested for one filtered case -> one parseable result with raw numeric millisecond fields.

### 5. Good/Base/Bad Cases

- Good: add a representative case, record repeated baselines, then add a threshold with CI headroom.
- Base: use `BENCH_CASES`, `BENCH_ITERS`, and `BENCH_WARMUP` for reproducible focused investigation.
- Bad: parse human-formatted microsecond/millisecond strings inside new gate logic when structured numeric output is available.
- Bad: gate the full benchmark suite or intentional timers, making normal validation slow and flaky.
- Bad: keep an algorithm change that only wins one noisy run or regresses behavior fixtures.

### 6. Tests Required

- Unit test machine-readable benchmark output with a fast filtered case.
- Unit test multi-case JSON gate success.
- Unit test benchmark fixture and default-budget changes through the scripts
  contract; keep the account-admin workload sizes aligned with production
  pagination and bulk-action bounds.
- Unit test a missing gated result and an over-budget result fail with the case name.
- Run `pnpm check:bench` after benchmark or hot-path changes.
- Run `pnpm unit` because script behavior is covered by `tests/unit/scripts.cases.mjs`.

### 7. Wrong vs Correct

#### Wrong

```javascript
const median = /median=([0-9.]+)ms/.exec(stdout)?.[1];
if (Number(median) > 20) process.exit(1);
```

#### Correct

```javascript
const results = parseBenchmarkResults(stdout);
for (const [name, maxMedianMs] of Object.entries(budgets)) {
  const medianMs = results.get(name)?.medianMs;
  if (!Number.isFinite(medianMs) || medianMs > maxMedianMs) fail(name);
}
```

## Scenario: Runtime Config And Bounded JSON Reads

### 1. Scope / Trigger

Use this contract when changing environment config parsing, config cache keys, request body size guards, or JSON response helpers.

### 2. Signatures

- `CONFIG_ENV_KEYS` lists every environment key that affects `getConfig`.
- `CONFIG_ENV_KEYS` defines the ordered fields captured by the structured cache snapshot.
- `getConfig(env)` returns a cached `StaticRuntimeConfig` only when current watched values match the stored snapshot.
- `assertRuntimeConfig(env)` validates the production bundle environment without exposing the internal config object.
- `RuntimeConfigError` contains safe `code`, `setting`, and `reason` fields and never includes the rejected value.
- `createRuntimeConfig(staticConfig, execution?, session?)` returns a new composed `RuntimeConfig` with request execution and account-session fields; it never mutates the cached static object.
- `requestContentLength(request)` returns a safe decimal byte length or `null`.
- `readJsonRequest(request, { maxBodyBytes, oversizedError })` reads UTF-8 JSON objects with optional bounded body size.
- `jsonTextResponse(body, status, extra)` returns an already-serialized JSON body.

### 3. Contracts

- Add every new environment variable consumed by `getConfig` to `CONFIG_ENV_KEYS`; otherwise cached configs can go stale.
- `ADMIN_KEY` is the single administrator credential and appears once in `CONFIG_ENV_KEYS`, deployment secret templates, and Compose forwarding. It accepts only one string; placeholder and overlong values are invalid.
- `API_KEYS` uses one comma-separated format. JSON-array strings, empty members, duplicates, and non-string array entries are invalid.
- Boolean settings accept only booleans or exact `"true"` / `"false"` strings. Integer settings accept only safe base-10 integers inside their documented bounds.
- `GEMINI_ORIGIN` must be an absolute HTTP(S) origin with no credentials, path, query, or fragment. Context filenames must be plain filenames without path separators or control characters.
- `StaticRuntimeConfig` contains only environment/default-derived values. `RuntimeExecutionContext` contains request-local `execution_ctx` and authenticated-session availability; `GeminiAccountSessionContext` contains cookie/SAPISID/account identity/writeback state.
- Parsed static config and its key arrays are frozen. Request/session composition must return a distinct object.
- The application composition root in `src/app.ts` must call `createRuntimeConfig(getConfig(env), executionContext)` before adding account-pool availability or acquiring a lease. Do not attach request/account fields directly to the cached object returned by `getConfig`.
- `GEMINI_COOKIE` and `SAPISID` are not public runtime config keys on the D1 account-pool branch. Do not add them back to `CONFIG_ENV_KEYS`; account leases populate `RuntimeConfig.cookie` and `RuntimeConfig.sapisid` internally after selecting a D1 account.
- Do not cache config solely by env object identity. Compare every watched value before returning a cached result.
- Store primitive watched values directly. Do not concatenate or serialize secret-bearing strings such as `ADMIN_KEY` or string-form `API_KEYS` on cache hits.
- Array-form `API_KEYS` uses a shallow content snapshot and invalidates after in-place replacement or length changes.
- `requestContentLength` accepts only safe base-10 integer strings after trimming; invalid, signed, fractional, or unsafe values return `null`.
- `readJsonRequest` must reject `Content-Length > maxBodyBytes` before reading the stream.
- When the streamed body exceeds `maxBodyBytes`, cancel the reader and return the configured 413 error before UTF-8 decoding or JSON parsing.
- If a valid `Content-Length` is present and within limit, preallocate that size; if the stream exceeds the declared length, fall back to chunk merging while still enforcing `maxBodyBytes`.
- Use `jsonTextResponse` when the caller already has a serialized JSON string and must avoid an extra `JSON.stringify`.

### 4. Validation & Error Matrix

- Reused env object changes `LOG_REQUESTS=false` to `LOG_REQUESTS=true` -> `getConfig` returns `true`.
- Composing two requests from one cached static config -> distinct runtime objects; neither request-local context appears on the cached static object.
- New env key used by config but missing from `CONFIG_ENV_KEYS` -> stale-cache bug; add the key and a cache regression test.
- `Content-Length: 1000`, `maxBodyBytes: 999` -> 413 before body read.
- Chunked body grows from 900 to 1001 bytes with `maxBodyBytes: 1000` -> cancel reader and return 413 using `1001 bytes > 1000`.
- Invalid `Content-Length: 01` or `+1` -> return `null` and use streamed byte accounting.
- Valid UTF-8 non-object JSON -> 400 `request body must be a JSON object`.
- Invalid UTF-8 -> 400 `invalid UTF-8 request body`.
- `LOG_REQUESTS=yes`, `RETRY_ATTEMPTS=0`, a path-bearing `GEMINI_ORIGIN`, or `API_KEYS=["key"]` -> `RuntimeConfigError` naming the setting and safe reason.
- Worker request with invalid config -> sanitized 500 `invalid_runtime_config` response with setting/reason and no rejected value.
- Docker CLI startup with invalid config -> reject before `server.listen(...)`.

### 5. Good/Base/Bad Cases

- Good: add `NEW_FEATURE_FLAG` to `CONFIG_ENV_KEYS` in the same change that reads it in `getConfig`.
- Good: call `createRuntimeConfig(staticConfig, { execution_ctx })` in `src/app.ts` and let account leases clone that runtime with session fields.
- Good: validate the built Worker module through `assertRuntimeConfig` before Docker starts listening.
- Base: use `requestContentLength(request)` for route-level body byte telemetry and oversized preflight checks.
- Bad: reuse `_configCacheValue` when `_configCacheEnv === env` without comparing the watched snapshot.
- Bad: build one serialized cache key containing copies of all watched secrets on every request.
- Bad: parse `Content-Length` with `Number(raw)` and accept signs, fractions, leading-zero variants, or unsafe integers.
- Bad: assign `execution_ctx`, `gemini_account`, or `cookie` onto an object returned by `getConfig`.
- Bad: silently clamp invalid integers, treat arbitrary truthy strings as booleans, or fall back from malformed JSON-array key text to comma parsing.

### 6. Tests Required

- Unit test that mutating and reusing one env object recomputes config.
- Unit test each new config env key through `getConfig`.
- Unit test strict boolean, integer, origin, filename, and key-list failures plus secret redaction.
- Unit test `ADMIN_KEY` single-string parsing, placeholder rejection, and deployment example/Compose coverage.
- Unit test that static config remains unchanged after runtime/session composition and that empty runtime sessions receive empty cookie/SAPISID compatibility fields.
- Unit test Docker rejects invalid config before listening and Worker returns the sanitized error envelope.
- Unit test `requestContentLength` for valid, absent, malformed, and unsafe values.
- Unit test `readJsonRequest` preflight rejection from `Content-Length`.
- Unit test streamed body cancellation when bytes exceed `maxBodyBytes`.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke` after changing request parsing or config wiring.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (_configCacheValue && _configCacheEnv === env) return _configCacheValue;
```

#### Correct

```typescript
if (
  _configCacheValue &&
  _configCacheEnv === env &&
  _configCacheSnapshot &&
  configSnapshotMatches(_configCacheSnapshot, env)
) {
  return _configCacheValue;
}
```

#### Wrong

```typescript
const cfg = getConfig(env);
cfg.execution_ctx = ctx;
```

#### Correct

```typescript
const cfg = createRuntimeConfig(getConfig(env), { execution_ctx: ctx });
```

#### Wrong

```typescript
const enabled = /^(1|true|yes|on)$/i.test(String(env.LOG_REQUESTS));
const attempts = Math.max(1, Number.parseInt(String(env.RETRY_ATTEMPTS), 10));
```

#### Correct

```typescript
const cfg = getConfig(env); // throws RuntimeConfigError on malformed values
assertRuntimeConfig(env);   // production bundle validation for Docker startup
```

## Scenario: Worker Request And Image Resource Budgets

### 1. Scope / Trigger

Use this contract when changing generation request parsing, inline Base64
decoding, multipart image edits, generated-image hydration, or deployment
defaults that affect Worker memory and CPU pressure.

### 2. Signatures

- `REQUEST_BODY_MAX_BYTES` maps to
  `StaticRuntimeConfig.request_body_max_bytes` and accepts integers from `1` to
  `104857600`.
- `readRouteJsonPost(request, cfg, path)` applies the JSON body budget before
  route handlers can acquire an account lease or call Gemini.
- `base64ToBytes(value)` supports strict standard Base64 and Base64URL input.
- `hydrateGeneratedImages(cfg, activeCfg, images, limits?)` defaults to `16 MiB`
  per generated image and `48 MiB` total decoded image bytes.

### 3. Contracts

- Authored Worker configuration defaults buffered generation JSON to `16 MiB`;
  Docker Compose defaults it to `64 MiB`. Explicit valid deployment values
  override both profiles.
- The JSON budget includes inline Base64 text because it limits the complete
  buffered request envelope before JSON parsing.

- Multipart image edits do not use `REQUEST_BODY_MAX_BYTES`. Their request
  capacity remains governed by `GENERIC_FILE_UPLOAD_MAX_BYTES` plus the existing
  multipart form overhead.
- When the generic JSON limit is lower than the large-context inline limit,
  return `request_body_too_large`. When the large-context limit is lower or
  equal and text attachments are unavailable, return the more specific 422
  capability error: `gemini_authenticated_session_required` when authentication
  is missing, otherwise `large_context_inline_unsupported`.
- Declared oversized JSON must be rejected before reading the body. Streamed
  oversized JSON and generated-image responses must cancel their active reader.
- Compact Base64 should use native `Uint8Array.fromBase64` as the validation and
  decode authority when available. Preserve strict malformed-input rejection,
  Base64URL support, and the validated fallback for older runtimes.
- Generated-image hydration tracks decoded bytes, does not retry preview URLs
  after a budget failure, and preserves the source URL without Base64 when an
  individual or aggregate budget is exceeded.

### 4. Validation & Error Matrix

- JSON `Content-Length` above `REQUEST_BODY_MAX_BYTES` -> HTTP 413
  `request_body_too_large` before D1 or Gemini work.
- Chunked JSON crosses the configured limit -> cancel the reader and return the
  route's OpenAI- or Google-compatible 413 envelope.
- Multipart image edit with a lower JSON limit -> ignore the JSON limit and use
  the multipart attachment limit.
- Malformed Base64 or Base64URL -> deterministic `invalid base64 payload`.
- Generated image `Content-Length` or streamed bytes exceed the remaining
  budget -> cancel, skip preview fallback, and return the original image URL.
- Invalid `REQUEST_BODY_MAX_BYTES` outside `1..104857600` -> sanitized
  `invalid_runtime_config` failure.

### 5. Good/Base/Bad Cases

- Good: tune Docker JSON capacity through `REQUEST_BODY_MAX_BYTES` without
  increasing the Worker-authored default.
- Base: a normal generated image hydrates to Base64 while remaining budgets are
  decremented by decoded byte length.
- Bad: apply the JSON envelope limit to multipart parsing or reduce
  `GENERIC_FILE_UPLOAD_MAX_BYTES` as a substitute.
- Bad: call `response.bytes()` for generated images without content-length and
  incremental stream bounds.

### 6. Tests Required

- Test Worker `16 MiB`, Docker Compose `64 MiB`, maximum valid override, and
  invalid range values.
- Test OpenAI and Google declared oversized JSON before any D1 read.
- Test streamed JSON and image overflow cancellation.
- Test multipart image edits remain independent from the JSON limit.
- Test malformed standard Base64 and Base64URL in native and fallback modes.
- Test individual and aggregate generated-image budgets preserve URL-only output.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`,
  `pnpm coverage:ci`, `pnpm smoke`, `pnpm check:bench`, and `pnpm check:size`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const body = await response.bytes();
return bytesToBase64(body);
```

#### Correct

```typescript
const bytes = await responseBytes(response, remainingBytes);
remainingBytes -= bytes.byteLength;
return bytesToBase64(bytes);
```

## Scenario: Gemini Account Runtime Snapshot And Refresh Cost

### 1. Scope / Trigger

Use this contract when changing the D1 Gemini account schema, issue/state
semantics, selectable snapshots, leases, outcome persistence, cookie refresh, or
account-scoped page/push-token caches.

### 2. Signatures

- `GeminiAccountRuntimeStore.listSelectableAccounts(nowMs, limit)` returns only
  `id`, `enabled`, `cookie_header`, `cookie_hash`, `issue`,
  `cooldown_until_ms`, and `last_used_at_ms`.
- `GeminiAccountRuntimeStore.writeAccountOutcome(accountId, outcome)` accepts a
  success or a failure with an optional normalized issue and cooldown.
- `GeminiAccountRuntimeStore.writeRefreshedCookie(accountId, { cookieHeader,
  refreshedAtMs, nowMs })` returns `{ changed, reason?: "duplicate_cookie" }`.
- `AccountPoolService.acquireLease(baseConfig)` returns one account lease or
  `null`; a successful refresh updates that lease's active `config`.
- Persisted issues are `auth | rate_limit | user_action | location | transient`.
  Public states are `available | cooling | attention | disabled`.

### 3. Contracts

- `migrations/0001_gemini_accounts.sql` owns the compatibility-free initial
  schema. The account table has exactly identity/label, `enabled`, normalized
  Cookie plus unique hash, one issue/cooldown, issue/use/refresh timestamps, and
  create/update timestamps. Retain pool metadata and refresh locks.
- `enabled` is the only operator-controlled availability state. Never persist
  presentation state, category, counters, capability placeholders, source
  metadata, row aliases, page tokens, push IDs, or per-account transport
  overrides.
- Derive state in this order: disabled, active cooldown, durable issue, available.
  Suppress an expired `rate_limit` or `transient` issue from public summaries.
- `auth`, `user_action`, and `location` block durably. `rate_limit` uses a
  five-minute cooldown; `transient` uses one minute. Model-invalid and
  capability-mismatch errors are request-scoped and update only last use.
- Success clears issue/cooldown/issue time. Publish `pool_version` only when a
  health transition changes selectability; healthy last-use updates must not
  invalidate every isolate snapshot.
- Cookie refresh normalizes away `SNlM0e`, `session_token`, and `at`, checks
  duplicate ownership before and after the D1 update, clears health after an
  authenticated success, and atomically publishes pool version.
- A duplicate-cookie refresh leaves the lease/config unchanged. A successful
  refresh updates `lease.cookieHeader`, `lease.cookieHash`, and
  `lease.config.cookie/sapisid/gemini_account.cookieHash` together.
- `/app` page tokens and content-push `push_id` stay in account-scoped runtime
  caches. They are not D1 account columns and have no lease writeback callback.
- Snapshot caching, pending refresh dedupe, lock ownership, and cache keys use
  account IDs/hashes, never credentials.

### 4. Validation & Error Matrix

- Disabled row, active cooldown, or durable issue -> excluded from selection.
- Expired temporary issue -> selectable and publicly `available` with
  `issue: null`.
- Model/capability error -> no issue/cooldown mutation.
- 401/403 refresh rejection -> `auth`; 429 -> `rate_limit`; unknown
  network/5xx failure -> `transient`.
- Same-cookie authenticated refresh -> `unchanged`, health cleared, refresh
  timestamp recorded.
- Cookie hash owned by another account, including a convergence race ->
  `rotation_duplicate`, no lease mutation and no failure outcome.
- D1 lock conflict -> typed unchanged result and no rotate call.
- Successful outcome persistence rejection -> preserve the upstream result and
  handle the persistence rejection safely.

### 5. Good/Base/Bad Cases

- Good: `domain.ts` owns issue/state guards and derivation; storage and admin
  projection reuse it.
- Good: register pending refresh by `accountId + cookieHash` before the first
  await and update the active lease config after writeback.
- Base: an empty selectable snapshot is cached and version-probed like any other
  snapshot.
- Bad: storing a mutable status enum beside `enabled` and cooldown.
- Bad: writing page tokens, push IDs, counters, or category back to D1.
- Bad: bumping pool version for every healthy request merely because
  `last_used_at_ms` changed.

### 6. Tests Required

- State precedence, durable/temporary issue guards, and expired-issue
  suppression.
- Outcome classification for auth/rate/user-action/location/transient and
  request-scoped model errors.
- Selection exclusion, success recovery, local snapshot updates, and
  transition-only pool-version publication.
- Refresh pending dedupe, D1 lock conflict, same-cookie success, duplicate
  preflight/race handling, rejection classification, and active lease-config
  replacement.
- Account-scoped page/push-token cache isolation and absence of D1 page-state
  writeback.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`,
  `pnpm unit`, `pnpm coverage:ci`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
row.status = "rate_limited";
await store.writePageState(accountId, { at, pushId });
```

#### Correct

```typescript
await store.writeAccountOutcome(accountId, {
  kind: "failure",
  issue: "rate_limit",
  cooldownUntilMs: nowMs + 5 * 60_000,
  nowMs,
});
// Page/push tokens remain in the account-scoped runtime cache.
```

## Scenario: Atomic Account-Pool Version Publication

### 1. Scope / Trigger

Use this contract when changing D1 account create/update/delete behavior, Cookie
writeback, selection-affecting account outcomes, `pool_version`, or the Docker D1
HTTP binding.

### 2. Signatures

- `D1GeminiAccountStore.getPoolVersion()` returns the opaque numeric string used
  by `AccountPoolService` to detect stale selectable snapshots.
- `D1DatabaseLike.batch(statements)` is the production transaction primitive for
  native Worker D1 and Docker's Cloudflare D1 HTTP adapter.
- `createD1HttpBinding(...).batch(statements)` serializes same-binding prepared
  statements as `{ batch: [{ sql, params }] }` to the D1 REST `/query` endpoint.

### 3. Contracts

- `pool_version` is a strictly increasing numeric string. Increment the value
  already stored in D1; never assign `String(nowMs)` as the version.
- Existing timestamp-shaped numeric versions are valid starting values and need
  no migration. Runtime consumers compare versions as opaque strings and must not
  parse or sort them.
- Create, update, delete, Cookie writeback, and outcomes that change status or
  cooldown must execute the account mutation plus a conditional version increment
  in one `batch()` transaction.
- The conditional single-row increment uses SQLite `changes() > 0`. A missing-row
  or no-op mutation does not publish invalidation.
- Success/failure counters and other outcome metadata that do not affect account
  selection do not increment `pool_version`.
- If `batch` is absent on a compatibility D1-like adapter, run the mutation first
  and increment only after a changed result. Production Worker and Docker bindings
  must expose `batch`.
- Docker batch statements must come from the same HTTP binding instance. Batch
  errors may include a result index or sanitized Cloudflare code, but never SQL
  bind values, Cookies, session tokens, authorization headers, or D1 API tokens.

### 4. Validation & Error Matrix

- Two writes with the same `nowMs` -> two distinct increasing versions.
- Existing version `1700000000000` plus one write -> `1700000000001`.
- Account mutation fails -> transaction rolls back; version unchanged.
- Version increment fails -> account mutation rolls back.
- Cookie-hash uniqueness race -> update and increment roll back; duplicate owner
  is re-read; return the existing duplicate no-op result.
- HTTP batch returns the wrong result count or a failed member -> sanitized
  `D1HttpBindingError`; no request secrets in the message.
- Statement from another HTTP binding -> reject before sending a network request.

### 5. Good/Base/Bad Cases

- Good: batch `[accountMutation, incrementWhereChangesPositive]` and return the
  first statement result.
- Good: keep `updated_at_ms` monotonic with `MAX(existing, incoming)` while the
  version itself increments independently of wall-clock collisions.
- Base: a D1-like test or compatibility adapter without `batch` uses the existing
  sequential fallback and cannot claim transaction atomicity.
- Bad: write the account row, then issue an independent timestamp assignment to
  `pool_version`.
- Bad: serialize arbitrary prepared-statement objects or cross-binding statements
  through the Docker HTTP adapter.

### 6. Tests Required

- Assert same-millisecond creates increment an existing timestamp-shaped version
  twice.
- Inject version-publication failure and assert the account row and version both
  roll back.
- Assert duplicate Cookie convergence preserves the original row and version.
- Assert HTTP batch request shape, ordered result mapping, empty batches,
  cross-binding rejection, malformed result counts, failed members, and secret-safe
  messages.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`,
  `pnpm coverage:ci`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
await mutation.run();
await setPoolVersion(String(nowMs));
```

#### Correct

```typescript
await db.batch([
  mutation,
  incrementPoolVersion("WHERE changes() > 0"),
]);
```

## Scenario: D1 Batch Account Import


### 1. Scope / Trigger

Use this contract when changing Gemini account creation, batch import limits,
D1 insert/query shape, pool-version updates, or Worker/Docker import behavior.

### 2. Signatures

- `GeminiAccountAdminStore.createAccountsBulk?(entries)` accepts unique
  `{ cookieHash, input }` entries and returns `itemsByCookieHash` plus
  `addedCookieHashes`.
- `D1GeminiAccountStore.createAccountsBulk(entries)` is the native D1 owner.
- `normalizeCreateAccounts(body, maxAccounts)` enforces the runtime-specific
  account-count ceiling before cookie hashing or store access.
- `ApplicationExecutionContext.runtimeProfile` is `"docker"` only for the Node
  adapter; application runtime config normalizes it to `runtime_profile`.

### 3. Contracts

- Workers accept at most 40 accounts per admin import. A 40-account all-new
  import uses 40 conflict-ignoring insert statements, one hash lookup query, and
  one conditional pool-version update: 42 D1 queries total.
- Docker has no account-count ceiling. It remains bounded by the shared 256 KiB
  admin request-body limit, writes accounts in transactional groups of at most
  40, and reconstructs imported rows in chunks of at most 100 cookie-hash bind
  parameters.
- The Docker distinction is request-local adapter metadata, not a public
  environment variable or user-controlled HTTP header.
- Normalize and hash each input, collapse duplicate cookie hashes before store
  access, then project sanitized items back into original input order.
- D1 inserts use `ON CONFLICT(cookie_hash) DO NOTHING`; a duplicate cookie must
  not roll back unrelated inserts in the same native batch.
- Native Worker D1 and Docker's HTTP adapter use `db.batch(statements)`.
  D1-compatible adapters without `batch` execute the same prepared statements
  sequentially and publish one post-reconstruction version increment when rows
  were added.
- Determine added rows by matching the prepared row ID with the post-insert row
  selected by cookie hash. A transactional group appends one conditional version
  statement whose `EXISTS` predicate checks those generated IDs. All-conflict
  groups execute the condition but do not change `pool_version`.
- Stores without `createAccountsBulk` retain the bounded compatibility path;
  Worker validation still caps that path before hashing or store calls.
- The built-in admin UI submits the full import first. It retries sequentially
  in groups of 40 only after HTTP 413
  `gemini_import_account_limit_exceeded`; direct API callers retain the explicit
  per-request ceiling, and Docker avoids chunking when the first request succeeds.

### 4. Validation & Error Matrix

- Worker payload with 41 accounts -> HTTP 413
  `gemini_import_account_limit_exceeded`, zero hashes and zero D1 access.
- Docker payload with more than 40 accounts and at most 256 KiB -> process it;
  do not return the Worker count-limit error.
- Admin UI payload with more than 40 accounts on Worker -> one rejected full
  request followed by ordered requests of at most 40; merge successful results.
- Admin UI import with any other error -> no automatic retry.
- Existing, repeated-in-payload, or concurrently inserted cookie -> sanitized
  duplicate item, increment `skipped` and `duplicates`.
- All rows in a group conflict -> conditional version statement changes zero rows.
- Mixed new/conflicting rows -> add independent new rows and increment the pool
  version once for that changed group.
- Post-insert cookie-hash lookup lacks an expected row -> fail with a generic
  internal admin error; never include Cookie values or hashes in the response.

### 5. Good/Base/Bad Cases

- Good: 40 Worker inserts run through one `batch()` call and stay at 42 queries.
- Good: 101 Docker imports use three transactional insert groups plus two
  100-parameter-bounded reconstruction queries.
- Base: duplicate input positions return the same sanitized account item while
  only the first newly inserted position contributes to `added`.
- Bad: perform `findAccountByCookieHash` plus `createAccount` plus a version bump
  for every D1-backed input.
- Bad: apply the 40-account Worker ceiling to Docker or expose a public runtime
  profile environment setting.

### 6. Tests Required

- Assert 40 all-new Worker accounts produce one native batch, 42 recorded D1
  statements, and one pool-version update.
- Assert 41 Worker accounts fail before any D1 statement.
- Assert the Docker adapter marks its execution context and a 101-account Docker
  import uses three batches, three version increments, and two reconstruction
  queries.
- Assert a compatibility D1-like adapter without `batch` still imports accounts
  and increments once after reconstruction.
- Assert mixed existing/new/in-payload duplicates preserve order and counts.
- Assert an all-duplicate batch does not update the pool version.
- Assert a store without bulk capability preserves compatibility semantics.
- Assert the admin UI retries only the stable Worker limit error in ordered
  40-account chunks, keeps Docker to one request, and preserves merged items.
- Search complete response JSON for Cookie/session fragments and run
  `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`,
  `pnpm coverage:ci`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
for (const input of inputs) {
  if (!(await store.findAccountByCookieHash(input.cookieHash))) {
    await store.createAccount(input);
  }
}
```

#### Correct

```typescript
const entries = Array.from(uniqueEntries.values());
const stored = this.adminStore.createAccountsBulk
  ? await this.adminStore.createAccountsBulk(entries)
  : await createAccountsCompatibility(this.adminStore, entries);
for (const cookieHash of orderedCookieHashes) {
  items.push(stored.itemsByCookieHash.get(cookieHash));
}
```

## Scenario: Account-aware Gemini Provider Lease And Caches

### 1. Scope / Trigger

Use this contract when wiring `GeminiAccountRuntime` into `src/gemini/completion-provider.ts`, changing provider request lifecycle behavior, changing Gemini upload/page-token caches, or changing generated-image byte fetching in account-pool mode.

### 2. Signatures

- `createGeminiCompletionProvider(cfg, { accountRuntime })` returns a request-scoped provider.
- Account-backed `RuntimeConfig` carries only `gemini_account.accountId` and `gemini_account.cookieHash` plus the selected Cookie/SAPISID runtime values.
- `CompletionProvider.supportsAuthenticatedSession` is the provider-neutral signal that authenticated Gemini behavior is available through a configured account pool. Low-level cookie-shaped configs may still appear after a D1 account lease is selected.
- `CompletionProvider.dispose()` releases an acquired request lease when preparation fails before generation.

### 3. Contracts

- Public auth and JSON/multipart request validation must happen before account lease acquisition or D1 account reads. Constructing a runtime object is allowed before parsing, but `acquireLease` and store reads must stay lazy.
- A provider instance may lazily acquire at most one account lease and must reuse it across `resolveAttachments`, `uploadTextFile`, `generateText`, `generateRich`, and `streamText`.
- Upload-only provider calls keep the lease for the later generation call. If preparation returns an error after upload/bootstrap, the HTTP handler must call `provider.dispose()` before returning.
- Non-streaming generation marks account success only after the Gemini call resolves. Streaming marks success only after the async iterator completes normally.
- Non-abort provider failures mark the selected account failure and release the lease. Abort/disconnect errors release without recording noisy account failure.
- Terminal outcomes update the isolate-local snapshot before durable persistence,
  so an auth-failed or cooling account is not immediately selected again locally.
- Account outcome persistence is auxiliary state management. Its rejection must
  never replace a successful upstream result, replace the original upstream
  failure, or enter the success path's failure classifier.
- Guard every outcome promise with a safe rejection handler. Register the guarded
  promise with `execution_ctx.waitUntil` when available; otherwise await the
  guarded promise for deterministic non-Worker callers. Release the local lease
  before waiting or returning.
- Anonymous eligibility is decided at the provider boundary from the resolved
  model, rendered prompt bytes, file references, operation kind, and existing
  lease state. Reuse `CURRENT_INPUT_FILE_MIN_BYTES` and the bounded UTF-8 prompt
  helpers; do not inspect raw HTTP `Content-Length` for this decision.
- Short text requests with no file references, no image operation, prompt bytes
  at or below the configured threshold, and a non-Pro model call Gemini with an
  empty Cookie/SAPISID config before acquiring an account.
- Pro mode (`modeId === 3`), oversized prompts, uploaded or existing file refs,
  image generation, and image editing are account-required and never attempt
  anonymous generation.
- An anonymous non-abort error or empty response may acquire one lease and retry
  through the existing account selector. Streaming may do this only before its
  first non-empty delta. If lease acquisition cannot start because the runtime
  is absent or the pool is empty, preserve the original anonymous error.
- No eligible account for direct account-required work must throw a sanitized
  503 error with code `no_available_gemini_account` and must not call anonymous
  upstream Gemini.
- Account-marked configs must not use the process-global single-cookie rotation singleton. Cookie/session recovery goes through account runtime leases.
- `/app` page tokens and content-push `push_id` caches must include account identity or cookie hash when `gemini_account` is present. Build-label cache remains origin-scoped.
- Raw cookies, `SNlM0e`, `at`, `SAPISID`, session tokens, SQL bind values, and D1 API tokens must not appear in cache keys, log fields, or public error messages.
- Successful `/app` token bootstrap updates only the account-scoped page/push-token caches. It must not write page tokens or push IDs into D1 or outbound Cookie headers.
- Content-push upload may send selected `Push-ID`, but must not send Gemini `Cookie` or SAPISID-derived `Authorization` to `content-push.googleapis.com`.

### 4. Validation & Error Matrix

- Auth failure with `GEMINI_DB` configured -> 401 and zero D1 `prepare` calls.
- Invalid JSON with `GEMINI_DB` configured -> 400 and zero D1 `prepare` calls.
- Missing `GEMINI_DB` plus eligible short text -> anonymous upstream generation,
  zero D1 reads.
- Missing `GEMINI_DB` plus Pro, attachment, oversized, or image work -> 422
  `gemini_authenticated_session_required` with the matching `reason`, zero
  anonymous upstream calls.
- D1 configured with no selectable account plus eligible short text -> anonymous
  success when upstream succeeds; after anonymous failure, preserve that error.
- D1 configured with no selectable account plus direct account-required work ->
  503 `no_available_gemini_account`, zero upstream Gemini calls.
- Anonymous error before output plus one selectable account -> retry once with
  the selected account and record only that account attempt's outcome.
- Anonymous abort or stream error after a non-empty delta -> no account lease.
- Upload then generation -> one lease acquisition, same account config in both calls, one success, one release.
- `/app` page token fetch for account A then account B -> distinct cache keys; tokens cannot cross accounts.
- Account stream yields a first delta -> no success marked yet; stream completion -> success and release.
- Account stream throws after partial output -> failure and release; no alternate-account retry after visible output.
- Successful generation plus D1 outcome rejection -> preserve the generated
  result, release once, and handle the background rejection.
- Upstream generation failure plus D1 outcome rejection -> preserve the original
  upstream error, release once, and do not record the D1 error as an account
  failure.

### 5. Good/Base/Bad Cases

- Good: provider closure stores the lease promise and reuses `lease.config` for upload and generation.
- Good: create one guarded outcome promise, release the lease, then pass the
  guarded promise to `waitUntil`.
- Good: HTTP prepare-error branches call `provider.dispose?.()` before returning a validation error after possible upload work.
- Good: generated-image byte hydration receives the same account-backed config as rich generation.
- Good: eligible text reaches anonymous upstream without calling
  `AccountPoolService.acquireLease`; a pre-output failure then uses the normal
  least-in-flight/round-robin selector once.
- Base: no-D1 eligible text remains usable anonymously, while account-required
  work fails closed with `gemini_authenticated_session_required`; static health/model
  routes still do not read D1.
- Bad: acquire an account before the final prompt, model, and file references are
  known, because that defeats anonymous preference and consumes pool capacity.
- Bad: retry through an account after a streamed delta, which duplicates visible
  output.
- Bad: calling `AccountPoolService.acquireLease` while parsing JSON, checking public API keys, listing models, or serving health checks.
- Bad: keying page tokens or push IDs by raw cookie header.
- Bad: releasing the lease immediately after successful upload and selecting another account for generation.
- Bad: await `markSuccess()` inside the generation `try` with an unguarded
  rejection; a persistence failure then enters the upstream failure branch.

### 6. Tests Required

- Provider unit tests for lease reuse across upload plus text/rich generation.
- Provider tests for threshold equality vs threshold-plus-one, both Pro models,
  uploaded/existing refs, and rich image operations.
- Provider tests for anonymous preference with no D1/empty D1, anonymous error
  and empty-response fallback, original-error preservation when acquisition
  fails, and abort exclusion.
- Stream tests for fallback before output, empty-stream fallback, and no fallback
  after a delta or abort.
- Provider stream tests for success only after iterator completion and release on stream failure.
- Provider tests proving `waitUntil` registration, successful-result preservation,
  original-error preservation, and handled outcome-write rejection.
- Runtime test proving a terminal auth failure immediately removes the account
  from the local selectable set.
- Route tests proving auth and request-validation failures do not touch D1.
- Cache tests proving account-scoped page-token and push-id isolation.
- Upload tests proving content-push requests omit Cookie and Authorization.
- Runtime/cache tests proving page tokens and push IDs are account-scoped, never written to D1, and never added to outbound Cookie headers.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm check:static`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const activeCfg = await acquireAccountConfig();
return generate(activeCfg, input);
```

#### Correct

```typescript
if (!accountRequired(cfg, model, input, hasLease)) {
  return generateAnonymousThenAccountFallback(input);
}
return generateWithAccountLease(input);
```

#### Wrong

```typescript
const result = await generate(activeCfg);
await lease.markSuccess();
lease.release();
return result;
```

#### Correct

```typescript
const result = await generate(activeCfg);
const guarded = lease.markSuccess().catch((error) => logSafe(error));
lease.release();
cfg.execution_ctx?.waitUntil(guarded);
return result;
```

## Scenario: Streaming Delta Coalescing

### 1. Scope / Trigger

Use this contract when changing completion stream event helpers, OpenAI or Google streaming writers, SSE pacing, or small-delta performance behavior.

### 2. Signatures

- `streamPlainCompletionEvents(provider, input, { signal, coalesceTextDeltas, minCoalescedTextChars, maxCoalescedTextWaitMs })` emits completion stream events.
- `streamToolSieveCompletionEvents(...)` and `streamBufferedToolTextCompletionEvents(...)` accept the same internal coalescing options.
- `createDeltaCoalescer(sendDeltaFrame, minFlushChars = 64, maxFlushWaitMs = 20, { emitFirstImmediately })` buffers protocol deltas.
- `MIN_DELTA_FLUSH_CHARS` and `MAX_DELTA_FLUSH_WAIT_MS` are the protocol-frame defaults.

### 3. Contracts

- Completion coalescing options are internal to `src/completion/runtime.ts`; pass only provider-supported options such as `signal` into `provider.streamText`.
- With `coalesceTextDeltas: true`, emit the first provider text delta immediately, then buffer later deltas until `minCoalescedTextChars` code points, `maxCoalescedTextWaitMs`, stream end, or a non-abort stream error.
- On non-abort provider errors, flush pending text before yielding the warning/error event so partial output is preserved.
- On abort/disconnect, do not flush buffered text as a synthetic final delta and do not emit noisy stream errors.
- Protocol writers should use `createDeltaCoalescer(..., { emitFirstImmediately: true })` when user-visible streaming latency matters.
- Always await promise-returning `append(...)` or `flush()` results before writing a finish frame, switching delta fields, or closing the stream.
- Responses streaming should track accumulated output length separately from joined text so empty-output checks do not require repeated full-string concatenation.


### 4. Validation & Error Matrix

- Provider yields `["he", "llo"]` with first-immediate coalescing -> first chunk may contain `he`, later flush contains `llo`.
- Many tiny provider deltas after the first -> fewer protocol frames once buffered text reaches 64 code points or 20 ms.
- Provider throws after pending non-abort text -> pending text is emitted, then warning/error handling runs.
- Provider aborts after pending text -> stream stops without warning/error event and without forcing buffered text.
- Delta field changes from `content` to `tool_calls` -> flush `content` before buffering `tool_calls`.
- Finish frame written before `flush()` resolves -> ordering bug; await the flush.

### 5. Good/Base/Bad Cases

- Good: OpenAI Chat, OpenAI Responses, and Google stream writers opt into completion coalescing and protocol-frame coalescing.
- Base: keep the first user-visible token fast while reducing high-frequency tiny writes after that.
- Bad: pass `coalesceTextDeltas` through to a provider adapter that does not understand it.
- Bad: join the whole Responses output string on every delta just to decide whether output is empty.

### 6. Tests Required

- Unit test completion coalescing for first-delta emission and later buffered emission.
- Unit test pending coalesced text flushes before non-abort stream warnings.
- Unit test `createDeltaCoalescer` flushes on field changes.
- Unit test `emitFirstImmediately` writes the first delta before throttling later deltas.
- Route or stream writer tests should assert OpenAI and Google streaming still preserve finish frames and warning behavior.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke` after changing stream coalescing.

### 7. Wrong vs Correct

#### Wrong

```typescript
for await (const delta of provider.streamText(input, options)) {
  await write(`data: ${JSON.stringify({ delta })}\n\n`);
}
```

#### Correct

```typescript
for await (const event of streamPlainCompletionEvents(provider, input, { signal, coalesceTextDeltas: true })) {
  if (event.type === "text_delta") {
    const writeResult = coalescer.append("content", event.text);
    if (writeResult) await writeResult;
  }
}
const flushResult = coalescer.flush();
if (flushResult) await flushResult;
```

## Scenario: Attachment Dedupe And In-Flight Memory

### 1. Scope / Trigger

Use this contract when changing request-local attachment materialization, deduplication, upload concurrency, or attachment memory limits.

### 2. Signatures

- `mapWithConcurrencyAndWeight(items, concurrency, maxWeight, weightOf, mapper)` preserves input ordering while limiting item count and aggregate active weight.
- Attachment uploads use four workers and a 32 MiB normal in-flight materialized-byte budget.

### 3. Contracts

- Hash `materialized.bytes` directly; never prepend metadata into a payload-sized temporary buffer.
- Include normalized MIME and filename alongside the payload digest.
- Preserve pending-promise deduplication and result ordering.
- Weight admission is FIFO. An attachment above the normal budget may run only when no other weighted item is active, so valid large files still make progress.

### 4. Validation & Error Matrix

- Same bytes, MIME, and filename -> one upload and repeated ordered references.
- Same bytes with different MIME or filename -> distinct dedupe keys.
- One valid item exceeds 32 MiB -> run alone; queued items resume after release.
- Mapper throws -> release weight in `finally`.

### 5. Good/Base/Bad Cases

- Good: digest the existing `Uint8Array`, then format a small metadata-plus-hex key.
- Base: output arrays retain input order when completion order differs.
- Bad: allocate `new Uint8Array(prefix.length + payload.length)` solely for hashing.
- Bad: permanently queue a valid attachment because it exceeds the normal aggregate budget.

### 6. Tests Required

- Test dedupe equivalence and MIME/filename distinctions.
- Test FIFO weighted concurrency, ordered results, error release, and oversized-item progress.
- Preserve request-local pending-upload dedupe integration tests.
- Benchmark a large attachment key against the former copy-based path.

### 7. Wrong vs Correct

#### Wrong

```typescript
const copy = new Uint8Array(prefix.byteLength + materialized.bytes.byteLength);
copy.set(prefix);
copy.set(materialized.bytes, prefix.byteLength);
```

#### Correct

```typescript
const digest = await crypto.subtle.digest("SHA-256", materialized.bytes);
return `${materialized.mime}\0${materialized.filename}\0${bytesToHex(new Uint8Array(digest))}`;
```

## Scenario: Tool-Sieve Held Candidate Performance

### 1. Scope / Trigger

Use this contract when changing `src/toolstream/index.ts`, DSML/XML tool-call parsing, streamed tool-call candidate holding, or markdown-protected tool-looking text behavior.

### 2. Signatures

- `processToolSieveChunk(state, chunk)` appends provider text and returns plain text chunks that are safe to emit.
- `flushToolSieve(state, toolsRaw)` parses any final buffered tool candidate or releases buffered text.
- `parseCanonicalDSMLToolCallsFast(text)` may parse straightforward canonical XML tool blocks before the tolerant DSML normalization path.

### 3. Contracts

- A held candidate is confirmed by a complete tool opening tag prefix, not by `isPartialToolMarkupPrefix` on the whole buffer. `isPartialToolMarkupPrefix` intentionally remains broad and can return true for complete strings that start with `<tool_calls`.
- Once a candidate is confirmed, `processToolSieveChunk` must not rescan the entire growing buffer for partial-prefix detection on every provider chunk.
- `heldTail` is bounded to 128 characters. When an incoming held chunk is already at least 128 characters, derive the tail directly from that chunk instead of concatenating the previous tail only to slice it away.
- Canonical DSML fast parsing may only accept plain canonical `<tool_calls>...<invoke ...>...</invoke></tool_calls>` XML. Confusable, alias, fenced, missing-wrapper, markdown-protected, or backtick-bearing inputs must fall back to the tolerant parser.
- Malformed but real-looking tool syntax should not leak mid-stream; keep it buffered until flush unless it is proven to be ordinary stale/plain text.
- Markdown-protected examples such as fenced `<tool_calls>` snippets must be released as plain text, not held as real tool calls.

### 4. Validation & Error Matrix

- 240 KB canonical held candidate split into 1 KB chunks -> no per-chunk full-buffer partial-prefix scan; benchmark should stay materially below the old ~25 ms median baseline.
- `<tool_calls><invoke></invoke></tool_calls>` in a held state -> remains buffered until flush.
- Fenced markdown example containing `<tool_calls>` -> released as plain text.
- Stale holding state with no tool syntax -> releases through the bounded plain-text path.
- Confusable or alias DSML -> parsed by tolerant path, not fast path.

### 5. Good/Base/Bad Cases

- Good: use a complete-opening-tag check to set `confirmedToolCandidate`.
- Base: final parsing still delegates parameter handling to existing XML/DSML helpers.
- Bad: call `isPartialToolMarkupPrefix(state.buffer)` for every chunk after a candidate has already been confirmed.
- Bad: fast-parse markdown-protected examples or confusable markup.

### 6. Tests Required

- Unit tests for canonical fast-path parsing and fast-path rejection of fenced, alias, confusable, and backtick-bearing inputs.
- Unit tests for held malformed syntax, markdown-protected examples, and stale holding state recovery.
- Benchmark `stream_sieve_held_tool` after changing held-candidate logic.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, `pnpm coverage:ci`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (isPartialToolMarkupPrefix(state.buffer)) return [];
```

#### Correct

```typescript
if (!state.confirmedToolCandidate && isPartialToolMarkupPrefix(state.buffer)) return [];
```
## Scenario: Shared Completion Stream Lifecycle

### 1. Scope / Trigger

Use this contract when changing completion events or OpenAI Chat, OpenAI
Responses, or Google streaming adapters.

### 2. Signatures

- `createCompletionStreamLifecycle()` creates protocol-neutral stream state.
- `recordCompletionStreamEvent(lifecycle, event)` records output, terminal issue,
  empty output, tool calls, policy violation, and completion counts.

### 3. Contracts

- Completion owns lifecycle state; HTTP adapters own JSON and SSE framing.
- Record every completion event exactly once before protocol-specific handling.
- Abort propagation, warning/error classification, coalescer flushes, and terminal
  frame ordering remain protocol-specific and behavior-compatible.

### 4. Validation & Error Matrix

- text then warning -> `emittedText=true` and terminal issue retained.
- empty event -> `empty=true`; adapter emits its existing fallback.
- done event -> completion counts replace initial empty counts.
- abort -> event producer throws; no lifecycle error conversion occurs.

### 5. Good/Base/Bad Cases

- Good: update the central lifecycle reducer when adding a new stateful event.
- Base: adapters branch only for protocol payload emission.
- Bad: recreate local `issue`, `empty`, and completion-count reducers per adapter.

### 6. Tests Required

- Unit-test lifecycle reduction for text, empty, issue, tool, and done events.
- Run OpenAI and Google streaming route tests plus smoke and coverage gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (event.type === "warning") issue = event;
else if (event.type === "done") completionCounts = event.completionCounts;
```

#### Correct

```typescript
recordCompletionStreamEvent(lifecycle, event);
if (event.type === "text_delta") await writeProtocolDelta(event.text);
```
