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

## Scenario: Runtime Config And Bounded JSON Reads

### 1. Scope / Trigger

Use this contract when changing environment config parsing, config cache keys, request body size guards, or JSON response helpers.

### 2. Signatures

- `CONFIG_ENV_KEYS` lists every environment key that affects `getConfig`.
- `configCacheKey(env)` serializes the watched environment keys.
- `getConfig(env)` returns a cached `RuntimeConfig` only when the env object and serialized key still match.
- `requestContentLength(request)` returns a safe decimal byte length or `null`.
- `readJsonRequest(request, { maxBodyBytes, oversizedError })` reads UTF-8 JSON objects with optional bounded body size.
- `jsonTextResponse(body, status, extra)` returns an already-serialized JSON body.

### 3. Contracts

- Add every new environment variable consumed by `getConfig` to `CONFIG_ENV_KEYS`; otherwise cached configs can go stale.
- Do not cache config solely by env object identity. Cloudflare-style env objects may be reused and mutated in tests or local harnesses, so `getConfig` must recompute when `configCacheKey(env)` changes.
- `requestContentLength` accepts only safe base-10 integer strings after trimming; invalid, signed, fractional, or unsafe values return `null`.
- `readJsonRequest` must reject `Content-Length > maxBodyBytes` before reading the stream.
- When the streamed body exceeds `maxBodyBytes`, cancel the reader and return the configured 413 error before UTF-8 decoding or JSON parsing.
- If a valid `Content-Length` is present and within limit, preallocate that size; if the stream exceeds the declared length, fall back to chunk merging while still enforcing `maxBodyBytes`.
- Use `jsonTextResponse` when the caller already has a serialized JSON string and must avoid an extra `JSON.stringify`.

### 4. Validation & Error Matrix

- Reused env object changes `LOG_REQUESTS=false` to `LOG_REQUESTS=true` -> `getConfig` returns `true`.
- New env key used by config but missing from `CONFIG_ENV_KEYS` -> stale-cache bug; add the key and a cache regression test.
- `Content-Length: 1000`, `maxBodyBytes: 999` -> 413 before body read.
- Chunked body grows from 900 to 1001 bytes with `maxBodyBytes: 1000` -> cancel reader and return 413 using `1001 bytes > 1000`.
- Invalid `Content-Length: 01` or `+1` -> return `null` and use streamed byte accounting.
- Valid UTF-8 non-object JSON -> 400 `request body must be a JSON object`.
- Invalid UTF-8 -> 400 `invalid UTF-8 request body`.

### 5. Good/Base/Bad Cases

- Good: add `NEW_FEATURE_FLAG` to `CONFIG_ENV_KEYS` in the same change that reads it in `getConfig`.
- Base: use `requestContentLength(request)` for route-level body byte telemetry and oversized preflight checks.
- Bad: reuse `_configCacheValue` when `_configCacheEnv === env` without checking `_configCacheKey`.
- Bad: parse `Content-Length` with `Number(raw)` and accept signs, fractions, leading-zero variants, or unsafe integers.

### 6. Tests Required

- Unit test that mutating and reusing one env object recomputes config.
- Unit test each new config env key through `getConfig`.
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
const cacheKey = configCacheKey(env);
if (_configCacheValue && _configCacheEnv === env && _configCacheKey === cacheKey) {
  return _configCacheValue;
}
```

## Scenario: Gemini Account Runtime Snapshot And Refresh Cost

### 1. Scope / Trigger

Use this contract when adding or changing D1-backed Gemini account runtime code, account selection, account leases, snapshot caching, account-scoped cookie rotation, or refresh dedupe.

### 2. Signatures

- `AccountPoolService.acquireLease(baseConfig)` returns a lease or `null`.
- `GeminiAccountStore.getPoolVersion()` reads one metadata row.
- `GeminiAccountStore.listSelectableAccounts(nowMs, limit)` reads a bounded selectable snapshot.
- Account refresh uses `tryAcquireRefreshLock(accountId, owner, expiresAtMs, nowMs)` and `releaseRefreshLock(accountId, owner)`.

### 3. Contracts

- A fresh selectable snapshot must satisfy account selection without a D1 account-row read and without any D1 write.
- Version probes read only `gemini_pool_meta.pool_version`; reload selectable rows only when the version changes or the snapshot TTL expires.
- Local fairness uses in-memory round-robin and in-flight counts. Do not write durable round-robin pointers or last-used timestamps synchronously during selection.
- Register pending per-account refresh promises before the first `await` in the refresh path. If the key is computed after an async hash/read, two same-tick callers can both start refresh work.
- The first refresh attempt for an account must not be suppressed just because `lastRotateAtMs` is initialized to `0`; apply debounce only when a prior rotate timestamp is positive.
- Refresh lock owners and cache keys must be based on account IDs and hashes, never raw cookies or session tokens.
- No-D1 mode must return `null` runtime and leave the single-cookie path unchanged.

### 4. Validation & Error Matrix

- Snapshot fresh and version probe not due -> no store calls.
- Version probe due and version unchanged -> exactly one metadata read, no row reload.
- Version changed -> metadata read plus bounded selectable row reload.
- Selection with two available accounts and one local in-flight -> choose the lower in-flight account.
- Two concurrent refresh waiters for the same account/cookie hash -> one rotate call and shared result/rejection.
- D1 lock conflict -> typed refresh conflict result, no rotate call, no lock release attempt for a lock not owned.
- `lastRotateAtMs = 0` -> first refresh may proceed; recent positive timestamp -> debounce.

### 5. Good/Base/Bad Cases

- Good: `pendingRefresh.set(key, promise)` happens before awaiting account state or hashes.
- Good: selection increments local in-flight and release is idempotent.
- Base: snapshot TTL/probe values are short enough for operator changes to propagate but long enough to avoid D1 reads on every request.
- Bad: `await sha256(cookie)` before checking the pending refresh map.
- Bad: writing `last_used_at_ms` or global round-robin state during every lease acquisition.

### 6. Tests Required

- Unit tests with fake store counters for snapshot reads, version probes, row reloads, and selection write counts.
- Unit tests for in-flight spread and idempotent release.
- Unit tests for refresh debounce, pending dedupe, D1 lock conflict, failure propagation, and lock release.
- Unit tests proving `SNlM0e`, `session_token`, and `at` stay out of outbound Cookie headers during writeback.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm check:static`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const state = await accountState(lease);
const key = `${lease.accountId}\0${state.cookieHash}`;
if (pending.has(key)) return pending.get(key);
```

#### Correct

```typescript
const key = `${lease.accountId}\0${lease.cookieHash}`;
const pending = pendingRefresh.get(key);
if (pending) return pending;
const promise = refreshOnce(lease).finally(() => pendingRefresh.delete(key));
pendingRefresh.set(key, promise);
return promise;
```

## Scenario: Account-aware Gemini Provider Lease And Caches

### 1. Scope / Trigger

Use this contract when wiring `GeminiAccountRuntime` into `src/gemini/completion-provider.ts`, changing provider request lifecycle behavior, changing Gemini upload/page-token caches, or changing generated-image byte fetching in account-pool mode.

### 2. Signatures

- `createGeminiCompletionProvider(cfg, { accountRuntime })` returns a request-scoped provider.
- Account-backed `RuntimeConfig` carries `gemini_account.accountId`, `gemini_account.cookieHash`, optional `rowId`, and a narrow `gemini_account_writeback(...)` callback.
- `CompletionProvider.supportsAuthenticatedSession` is the provider-neutral signal that authenticated Gemini behavior is available through either `GEMINI_COOKIE` or a configured account pool.
- `CompletionProvider.dispose()` releases an acquired request lease when preparation fails before generation.

### 3. Contracts

- Public auth and JSON/multipart request validation must happen before account lease acquisition or D1 account reads. Constructing a runtime object is allowed before parsing, but `acquireLease` and store reads must stay lazy.
- A provider instance may lazily acquire at most one account lease and must reuse it across `resolveAttachments`, `uploadTextFile`, `generateText`, `generateRich`, and `streamText`.
- Upload-only provider calls keep the lease for the later generation call. If preparation returns an error after upload/bootstrap, the HTTP handler must call `provider.dispose()` before returning.
- Non-streaming generation marks account success only after the Gemini call resolves. Streaming marks success only after the async iterator completes normally.
- Non-abort provider failures mark the selected account failure and release the lease. Abort/disconnect errors release without recording noisy account failure.
- No eligible account must throw a sanitized 503 error with code `no_available_gemini_account` and must not call upstream Gemini.
- Account-marked configs must not use the process-global single-cookie rotation singleton. Cookie/session recovery goes through account runtime leases.
- `/app` page tokens and content-push `push_id` caches must include account identity or cookie hash when `gemini_account` is present. Build-label cache remains origin-scoped.
- Raw cookies, `SNlM0e`, `at`, `SAPISID`, session tokens, SQL bind values, and D1 API tokens must not appear in cache keys, log fields, or public error messages.
- Successful `/app` token bootstrap in account mode should write changed `SNlM0e`/`at` and `push_id` through the lease writeback callback. These values remain structured account/session fields, not outbound Cookie header members.
- Content-push upload may send selected `Push-ID`, but must not send Gemini `Cookie` or SAPISID-derived `Authorization` to `content-push.googleapis.com`.

### 4. Validation & Error Matrix

- Auth failure with `GEMINI_DB` configured -> 401 and zero D1 `prepare` calls.
- Invalid JSON with `GEMINI_DB` configured -> 400 and zero D1 `prepare` calls.
- D1 configured and no selectable account -> 503 `no_available_gemini_account`, zero upstream Gemini calls.
- Upload then generation -> one lease acquisition, same account config in both calls, one success, one release.
- `/app` page token fetch for account A then account B -> distinct cache keys; tokens cannot cross accounts.
- Account stream yields a first delta -> no success marked yet; stream completion -> success and release.
- Account stream throws after partial output -> failure and release; no alternate-account retry after visible output.

### 5. Good/Base/Bad Cases

- Good: provider closure stores the lease promise and reuses `lease.config` for upload and generation.
- Good: HTTP prepare-error branches call `provider.dispose?.()` before returning a validation error after possible upload work.
- Good: generated-image byte hydration receives the same account-backed config as rich generation.
- Base: no-D1 provider keeps existing single-cookie/anonymous behavior.
- Bad: calling `AccountPoolService.acquireLease` while parsing JSON, checking public API keys, listing models, or serving health checks.
- Bad: keying page tokens or push IDs by raw cookie header.
- Bad: releasing the lease immediately after successful upload and selecting another account for generation.

### 6. Tests Required

- Provider unit tests for lease reuse across upload plus text/rich generation.
- Provider stream tests for success only after iterator completion and release on stream failure.
- Route tests proving auth and request-validation failures do not touch D1.
- Cache tests proving account-scoped page-token and push-id isolation.
- Upload tests proving content-push requests omit Cookie and Authorization.
- Runtime tests proving page-token writeback keeps session tokens out of outbound Cookie headers.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm check:static`, `pnpm unit`, and `pnpm smoke`.

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
