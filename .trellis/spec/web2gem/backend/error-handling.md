# Error Handling

## Request Parsing

`src/http/index.ts` owns JSON request parsing through `readJsonRequest`. It reads the body as bytes, decodes with fatal UTF-8 decoding, parses JSON through `tryParseJson`, and accepts only JSON objects.

OpenAI-compatible routes convert parse failures with `openAIErrorResponse`. Google-compatible routes return `{ error: { message } }` JSON responses.

## Upstream Errors

Use `upstreamErrorMessage` and `upstreamErrorCode` from `src/shared/errors.ts` when converting known upstream errors. Unexpected application-boundary failures must return the stable `internal_server_error` envelope; raw exception messages remain log-only.

## Scenario: Completion Error Presentation

### 1. Scope / Trigger

Use this contract when changing completion finalization, empty upstream handling,
or OpenAI/Google streaming error and warning behavior.

### 2. Signatures

- `CompletionStreamLifecycle` records emitted output, empty output, terminal
  issue, tool calls, policy violation, and completion counts.
- `writeOpenAIChatStreamError(...)`, `writeResponsesEvent(...,
  "response.failed", ...)`, and `writeGoogleStreamError(...)` own native stream
  error serialization.
- `EMPTY_UPSTREAM_MSG` is an error message only; it must not become model output.

### 3. Contracts

- Request validation and generation failures before output use native protocol
  errors and produce no assistant/model content.
- A completed response without text or tool calls is HTTP 502 / stream failure
  with code `upstream_empty`.
- A failure after partial output preserves already-emitted model content, emits
  warning metadata, and then emits the protocol's valid terminal sequence.
- Warning/error text is excluded from candidates, assistant deltas, Responses
  output items, token counts, and persisted model output.
- Abort errors propagate and are never converted into protocol warnings.

### 4. Validation & Error Matrix

- Non-stream empty -> native JSON error, status 502, code `upstream_empty`.
- Stream empty before output -> native stream error, then required terminator.
- Upstream failure before output -> native stream error with upstream code.
- Upstream failure after output -> retain content, warning metadata, terminator.
- Tool-policy violation -> native protocol failure, no synthesized model text.

### 5. Good/Base/Bad Cases

- Good: client receives `partial answer`, warning metadata, and a terminator.
- Base: successful output contains only upstream model text and tool calls.
- Bad: append `⚠️ upstream error` to assistant or candidate text.

### 6. Tests Required

- Cover empty and pre-output failure for non-streaming and streaming Chat,
  Responses, and Google routes.
- Cover partial interruption and assert warning presence, original output
  preservation, absence of synthetic output text, and valid termination.
- Run unit, coverage, smoke, static, type, architecture, and Worker type gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
await writeChunk({ content: `⚠️ upstream error: ${message}` }, null);
```

#### Correct

```typescript
await writeStreamWarningEvent(write, error);
await writeProtocolTerminator(write);
```

Do not silently change request semantics after a failure. A request with an explicit `model` must either use that model or return `model_not_found`; do not fall back to `DEFAULT_MODEL` for empty or unknown explicit model values. A request that requires authenticated Gemini text-file attachments must either complete with those attachments or return the corresponding error; do not retry it as anonymous or without failed context files. Request-local image and generic file inputs are the exception: if validation, fetch, or upload is unavailable or partially fails, the worker may continue as text-only only when it adds a dropped-attachment note to the prompt and logs safe metadata. Transport-only socket-to-fetch fallback is allowed because it preserves headers, cookie, model, body, and file references.

Gemini content-push upload must use multipart without `Cookie` or SAPISID-derived `Authorization`. Do not fall back to cookie-backed resumable upload after multipart rejection; request-local attachment failures degrade with prompt notes, while required `message.txt` / `tools.txt` context-file failures still fail the request.

Gemini content-push `Push-ID` values must come from the Gemini `/app` page. Do not use hard-coded default upload tokens. Origin-scoped string caches such as Gemini build-label and upload `push_id` must share `createOriginScopedStringCache(...)`, which owns L1 memory cache, Workers Cache API reads/writes, TTL/stale deletion, `execution_ctx.waitUntil(...)` background writes, and concurrent refresh de-duplication. `/app` fetch failures must be logged with safe error summaries and must not be cached as successful empty token results. `/app` responses that are reachable but no longer contain the expected `push_id` marker must fail upload attempts with a safe diagnostic instead of sending guessed page tokens.

Request-local upload materialization follows `ds2api`: inline base64 and data URL payloads are supported, but remote `http://` / `https://` URLs are not fetched by the worker. Explicit file inputs that contain only a remote URL and no existing file reference are invalid request-local file inputs and must degrade with a prompt note instead of starting any network read.

When selected account credentials are present and Gemini generation returns an authentication-style upstream status (`401` or `403`), classify it immediately as `invalid_gemini_cookie` before reading or parsing the response body and log safe metadata. Managed-account requests attempt one lease-owned credential refresh, then may continue through an untried account; they never retry anonymously. If recovery is exhausted, OpenAI-compatible and Google-compatible callers receive the existing sanitized upstream error. Request-local image and generic file uploads may still degrade as described above; text-file context upload must fail instead of falling back.

Account failover is an internal recovery path, not a public protocol change. It is allowed only for normalized account issues and, for streams, only before the first non-empty delta. Abort, model/capability failures, and externally supplied Gemini file refs without a replay recipe remain pinned to the current attempt. Never expose attempted account IDs, cookies, refresh details, or failover state in error envelopes.

When selected account credentials are present, generation requests must also verify the Gemini page auth token (`at`) before calling `StreamGenerate`. If `/app` does not yield `at`, return `invalid_gemini_cookie` immediately instead of sending the generation request without `at`, because that silently turns the request into anonymous behavior.

When Gemini WRB response parsing yields no text, logs under `LOG_REQUESTS` should include safe response-shape diagnostics such as WRB line count, parsed-envelope count, parsed-inner count, text-part count, and a reason class. Do not log raw WRB payload snippets or response text as diagnostics.

## Scenario: Gemini StreamGenerate Semantic Failures

### 1. Scope / Trigger

Use this contract when changing Gemini text, stream, or rich WRB parsing, same-account retries, or account failover classification.

### 2. Signatures

- `extractResponseFatalCode(raw)` returns known fatal code `1013|1037|1050|1052|1060` or `undefined`.
- `createSameAccountAttemptState(cfg)` owns the active config, at-most-one applied build-label update, cookie rotation, retry classification, last error, and one output-started fact for a logical client call.
- `consumeGeminiWrbStream(body, signal)` emits non-empty delta events followed by one bounded diagnostic summary; fatal lines throw before their deltas are exposed.
- Semantic errors carry internal `geminiSource: "stream_generate"`, `geminiCode`, and a stable sanitized `reason`.
- `GeminiAccountOutcome.recoveryScope` is `none|retry_same_account|try_next_account` and is independent from the optional durable account `issue`.

### 3. Contracts

- Inspect `[5,2,0,1,0]` on both WRB envelopes and decoded inner payloads before classifying a response as empty.
- Text, stream, and rich generation must use the same fatal-code semantics. Streaming checks each complete WRB line before emitting its text delta.
- Text, rich, and stream entrypoints share the same same-account recovery owner while retaining result-specific parsing. Mark output started immediately before exposing the first non-empty stream delta; after that point no build-label refresh, cookie rotation, delay retry, or same-account restart may begin.
- WRB stream consumption owns reader pulls, streaming UTF-8 decode, split/multiple line handling, decoder tail, final unterminated line, cumulative extractor delegation, and a 500-character diagnostic sample. The sample may feed shape classification but must never be logged raw.
- `1013` is a temporary model error: client transport policy may retry the same account, then account recovery may cool and switch before output.
- `1037` is an account usage limit: do not keep retrying the same account; mark rate-limit cooldown and permit an untried account before output.
- `1050` is model/conversation inconsistency: permit another account/context without marking credentials unhealthy.
- `1052` is a model-header/request-shape failure: do not blindly traverse accounts when the header context is unchanged.
- StreamGenerate `1060` is a temporary egress/IP block, not the account-status location code; do not persist a durable location issue or blindly churn the pool.

### 4. Validation & Error Matrix

- Fatal code before any delta -> typed semantic error; account recovery follows `recoveryScope`.
- Fatal code after a visible delta -> preserve stream pinning and surface the existing partial-output failure behavior; never switch accounts.
- Any non-abort failure after a visible delta -> preserve emitted deltas and propagate the original failure without same-account recovery.
- Unknown fatal code -> safe upstream failure/empty handling; never infer authentication or durable location failure.
- Caller abort -> propagate abort with no semantic classification, account mutation, or failover.

### 5. Good/Base/Bad Cases

- Good: `1050` retires the attempt and tries an untried compatible account without setting an account issue.
- Good: one client attempt state survives pre-output retries, while `client/index.ts` keeps only request/result orchestration.
- Base: successful WRB parts continue through existing text/rich parsing.
- Bad: search error message text for `1060` and permanently mark the account as location-blocked.

### 6. Tests Required

- Parser fixtures for inner and envelope fatal locations.
- Text and stream tests proving fatal detection happens before empty-response handling.
- Stream-consumer tests for split UTF-8, split/multiple lines, decoder tail, final unterminated lines, cumulative suffixes, bounded diagnostics, abort-before-pull, and no retry after the first delta.
- Classification tests for every known code and source.
- Provider tests for `1050` alternate-account recovery, `1052` no blind switching, post-delta pinning, attachment replay guards, and abort behavior.
- Run focused Gemini client/account tests, static checks, typecheck, and architecture checks.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (!text) throw upstreamEmptyResponseError(status, raw.length);
```

#### Correct

```typescript
const fatalCode = extractResponseFatalCode(raw);
if (fatalCode) throw geminiSemanticError("stream_generate", fatalCode);
if (!text) throw upstreamEmptyResponseError(status, raw.length);
```

## Scenario: Verified Gemini Account Refresh And Status Probe

### 1. Scope / Trigger

Use this contract when changing managed-account Cookie rotation, `/app` token fetching, admin refresh, or `GetUserStatus` probing.

### 2. Signatures

- `getFreshPageTokensForConfig(cfg)` always fetches `/app`; it never reads the ten-minute page-token cache.
- Account verification level is `session|status`.
- `verifyGeminiAccount({ config, level })` returns verification status and optionally a bounded `GeminiAccountProbe`.
- `GeminiAccountProbe` contains derived `statusCode`, mapped `issue`, and bounded normalized model capability rows.

### 3. Contracts

- Refresh order is RotateCookies, merge candidate Cookie, force fresh `/app`, require non-empty `SNlM0e`/`at`, optionally call minimal `GetUserStatus`, then write the Cookie and health result.
- RotateCookies HTTP 200, a changed PSIDTS, or a same-Cookie response is not sufficient to clear account health.
- Request-time auth recovery uses `session` verification and relies on successful generation to clear health.
- Admin refresh uses `status` verification. Known status `1000` clears health; known restricted statuses update the mapped issue after Cookie writeback.
- Use only `otAQ7b` with payload `[]`; do not reproduce Gemini-API settings, activity, recent-chat, or persistent-client initialization calls.
- Probe response reads are bounded. Persist or expose only normalized derived fields, never raw batchexecute arrays, localized descriptions, Cookie values, or response snippets.
- Unknown, missing, malformed, empty, or failed status probes never mark an account healthy and never replace capability data with an empty snapshot.

### 4. Validation & Error Matrix

- Fresh `/app` lacks `at` -> `missing_page_at_token`, no candidate Cookie writeback, authentication issue may be recorded.
- Status probe transport/HTTP/decode failure -> `status_probe_failed`, no health clearing or capability replacement.
- Status `1000` -> verified success and health clearing.
- Status `1014` -> transient issue; `1016` -> auth; `1021|1033|1040|1042|1054|1057` -> user action; account-status `1060` -> location.
- Unknown numeric status -> conservative probe failure, not automatic account rejection or health success.

### 5. Good/Base/Bad Cases

- Good: unchanged Cookie plus fresh `/app` and status `1000` reports verified unchanged success and clears a prior issue.
- Base: changed Cookie plus session verification is available for generation retry; later generation success clears health.
- Bad: call `writeRefreshedCookie` immediately after RotateCookies and clear issue before fetching `/app`.

### 6. Tests Required

- Prove cached page tokens are ignored by forced verification.
- Cover missing `at`, same/changed Cookie, duplicate Cookie, status success/restriction, unknown/malformed status, and bounded models/capacity.
- Assert request-time recovery never runs the status RPC and admin refresh does.
- Assert raw probe content and numeric status are absent from public/admin DTOs and logs.
- Run upload, Gemini client, account runtime/admin, Docker adapter, static, type, and architecture checks.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (rotateResponse.ok) await store.writeRefreshedCookie(accountId, candidate);
```

#### Correct

```typescript
const verification = await verifyGeminiAccount({
  config: candidateConfig,
  level: "status",
});
if (!verification.ok) return verification;
await store.writeRefreshedCookie(accountId, candidate);
```

## Scenario: Gemini Rich Response Parsing

### 1. Scope / Trigger

Use this contract when changing Gemini non-streaming rich output parsing, image generation parsing, WRB/framed response handling, or upstream empty/error classification for image mode.

### 2. Signatures

- `extractResponseText(raw)` remains the stable text-only parser for existing callers.
- `extractResponseParts(raw)` returns `{ text, images, fatalCode, candidateCount, generatedImageCount, webImageCount }` for rich callers.
- `generateRich(...)` must call the rich parser before deciding whether the upstream response is empty.

### 3. Contracts

- Rich parsing must accept both line-oriented WRB JSON envelopes and Gemini length-prefixed frames that may start with `)]}'`.
- Length markers are JavaScript string lengths / UTF-16 code units, not UTF-8 byte counts.
- Fatal Gemini part codes can live on the WRB envelope at `[5,2,0,1,0]`; do not only inspect the decoded inner payload.
- Generated image paths include plain generation `[12,7,0]` and image-to-image `[12,0,"8",0]`.
- Rich parser text cleanup must strip Gemini internal placeholder URLs such as `http://googleusercontent.com/image_generation_content/0` while preserving real client-usable image URLs such as `https://lh3.googleusercontent.com/...`.
- Preserve generated vs web image classification, selected-candidate semantics, and safe metadata such as `cid`, `rid`, `rcid`, and `imageId` when present.
- Generated image byte hydration should fetch the parsed generated image URL directly with Gemini browser headers, Gemini cookie when configured, and an image `Accept` header. Do not send SAPISID-derived `Authorization` to image CDN URLs; Gemini-API downloads images with browser/cookie session semantics, not RPC auth headers. The image byte GET path must force Worker `fetch` (`socket: false`) because Cloudflare socket transport can fail Google image CDN URLs even while `StreamGenerate` needs socket to avoid 429.
- Generated image bytes must be classified by supported image magic bytes (PNG, JPEG, GIF, WEBP). Do not trust URL suffix or `Content-Type` alone for `image_generation_call.result`, because a 200 HTML/text error page with misleading metadata must not become base64 image output.
- Image byte GET should rely on Worker `fetch`'s default redirect handling. Do not add a custom redirect loop unless a concrete platform failure requires it. If byte fetching fails, continue to preview candidates (`=s1024-rj` -> `=s2048-rj`, direct `gg-dl` first for direct URLs) without failing the whole rich result.
- Do not log raw WRB payloads, full image URLs, generated-image objects, or base64 image data in diagnostics.

### 4. Validation & Error Matrix

- OpenAI image generation or image editing request without a configured Gemini account pool -> sanitized account-pool-required failure before upstream generation, upload resolution, or generated-image byte fetching.
- Rich response has no text but at least one generated image -> success, not `upstream_empty_response`.
- Rich response has neither text nor images after retries -> `upstream_image_generation_empty`.
- Rich response text only contains `http://googleusercontent.com/<kind>/<number>` placeholders and images are present -> return image output without placeholder text.
- Fatal part code `1013`, `1037`, `1050`, `1052`, or `1060` -> provider/upstream error code, not empty-image output.
- Image-to-image generated metadata under `[12,0,"8",0]` -> generated image output.
- Generated image metadata includes a usable URL -> fetch image bytes/base64 from that URL through Worker `fetch`, not socket transport.
- Generated image byte URL returns an HTTP redirect -> Worker `fetch` follows it; the Worker validates the final response bytes before returning base64.
- Generated image byte fetching fails for all preview candidates -> preserve URL markdown instead of failing the whole rich result.
- Length-prefixed frame with astral Unicode -> parse by UTF-16 code units and preserve text/images.

### 5. Good/Base/Bad Cases

- Good: rich parser first normalizes WRB envelopes from frames, then decodes inner candidate payloads.
- Good: tests use fixtures for framed responses and the exact `[12,0,"8",0]` image-to-image path.
- Base: text-only `extractResponseText(raw)` behavior stays unchanged for existing text callers.
- Bad: only testing simplified `[["wrb.fr", ...]]` lines while live image responses arrive as length-prefixed frames.
- Bad: checking fatal codes only after decoding the inner candidate payload.

### 6. Tests Required

- Unit test rich generated image parsing for `[12,7,0]`.
- Unit test image-to-image generated image parsing for `[12,0,"8",0]`.
- Unit test length-prefixed frames, including astral Unicode text.
- Unit test fatal response part code mapping when parser or provider error handling changes.
- Unit test direct `gg-dl` URLs are fetched before suffix mutation.
- Unit test image byte fetching uses Worker `fetch` even when `StreamGenerate` uses socket transport.
- Unit test a 200 non-image body with image-looking `Content-Type` is rejected and falls back to URL markdown instead of becoming `image_generation_call.result`.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const parts = raw.split("\n").map((line) => JSON.parse(line));
const code = getNested(decodedInner, [5, 2, 0, 1, 0]);
```

#### Correct

```typescript
const envelopes = parseLineOrLengthPrefixedWrbEnvelopes(raw);
const code = getNested(envelope, [5, 2, 0, 1, 0]);
```

#### Wrong

```typescript
await fetchGeneratedImageBytes(image.url);
```

#### Correct

```typescript
const bytes = await fetchGeneratedImageBytes(previewUrl, { socket: false });
```

Streaming paths should keep partial-output behavior intact:

- SSE producers use `sseResponse`.
- `sseResponse` must abort the producer `AbortSignal` when the client cancels or when `controller.enqueue(...)` fails, so provider streams stop pulling upstream data promptly.
- Stream warnings use `writeStreamWarningEvent` or protocol-specific error helpers.
- Client disconnects and aborts should not be converted into noisy stream errors.

## Scenario: SSE Producer Abort Semantics

### 1. Scope / Trigger

Use this contract when changing `src/http/core/sse.ts`, protocol stream writers, or provider stream loops that consume the `AbortSignal` passed by `sseResponse`.

### 2. Signatures

- `sseResponse(producer, options)` passes `producer(write, signal)`.
- `write(chunk)` accepts an already-framed SSE string.
- `signal` is aborted on client `cancel()` and on enqueue failure.

### 3. Contracts

- Stream producers must pass the signal into provider streaming calls when possible.
- `write()` failure means the response stream is no longer writable; abort the signal and suppress further writes.
- Abort errors from provider streams should be rethrown or swallowed as disconnects, not converted into protocol error events.

### 4. Validation & Error Matrix

- Client cancels SSE body -> producer signal is aborted; no stream-error event is emitted.
- `controller.enqueue` throws -> producer signal is aborted; no further chunks are enqueued.
- Provider throws non-abort before output -> protocol adapter may emit an error event.
- Provider throws non-abort after partial output -> protocol adapter preserves partial output and may emit a warning.

### 5. Good/Base/Bad Cases

- Good: `write()` catches enqueue failure, marks the stream closed, and calls `AbortController.abort(...)`.
- Base: `cancel()` aborts the same controller used by producer code.
- Bad: enqueue failure only sets a local `closed` boolean while the upstream provider stream continues running.

### 6. Tests Required

- Unit test that canceling an SSE body aborts the signal observed by the producer.
- Unit or targeted helper test for enqueue-failure abort behavior when the controller can no longer accept chunks.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke` after changing stream wiring.

### 7. Wrong vs Correct

#### Wrong

```typescript
try { controller.enqueue(bytes); } catch (_) { closed = true; }
```

#### Correct

```typescript
try {
  controller.enqueue(bytes);
} catch (_) {
  closed = true;
  abortController.abort("stream closed");
}
```

## Top-Level Worker Errors

`src/app.ts` catches unhandled application-route errors, logs through `log(cfg, ...)`, and returns a JSON 500 response. Keep this as the final fallback, not the primary validation mechanism. `src/index.ts` must remain a thin Worker adapter and must not add a second error-mapping path.

The Docker adapter links Node request aborts and premature response closes to the Web `Request.signal`. Once that signal is aborted, disconnect-related stream failures are expected cancellation and must not be converted into a second generic adapter error response or noisy application failure.

## Scenario: D1 Account Storage And Docker Adapter Redaction

### 1. Scope / Trigger

Use this contract when adding D1-backed storage, Docker-side D1 HTTP bindings, account storage DTOs, or any adapter that can see SQL bind values, Gemini cookies, session tokens, or Cloudflare API tokens.


### 2. Signatures

- Worker storage uses a minimal D1-compatible shape: `db.prepare(sql).bind(...values).first/all/run()`.
- Docker D1 HTTP config is all-or-none: `D1_ACCOUNT_ID`, `D1_DATABASE_ID`, and `D1_API_TOKEN`.
- Account summaries expose only stable `id`, user label/enablement, derived
  state/visible issue, cooldown, and lifecycle timestamps. They never expose
  hashes, Cookie material, page/session tokens, or secret-presence flags.

### 3. Contracts

- Partial Docker D1 HTTP configuration must fail startup/config resolution before serving requests.
- Adapter errors may include safe status/code metadata, but must not include SQL text-derived bind values, raw cookie fragments, session-token fragments, or `D1_API_TOKEN`.
- Wrap underlying `fetch` failures from D1 HTTP adapters and replace arbitrary thrown messages with a safe adapter error; do not bubble a lower-level error string that might include request bodies or headers.
- Do not construct Cookie previews or public hash/presence diagnostics. Project
  the explicit account summary allowlist at the admin boundary.
- D1 account state should be stored in structured rows, not JSON blob rewrites or delete-and-reinsert-all collection saves.

### 4. Validation & Error Matrix

- `D1_ACCOUNT_ID` and `D1_API_TOKEN` present but `D1_DATABASE_ID` missing -> throw a safe partial-config error listing missing variable names only.
- D1 HTTP response status is non-2xx -> throw `D1 HTTP query failed status=<status>` without SQL params or tokens.
- D1 HTTP API payload reports an error -> throw a safe code-only message such as `D1 HTTP query failed code=<code>`.
- D1 HTTP `fetch` throws before a response -> throw a generic pre-response D1 adapter error, not the original thrown message.
- Account list response contains a field outside the explicit summary allowlist
  or any raw cookie/session fragment -> test failure.

### 5. Good/Base/Bad Cases

- Good: `createD1HttpBinding(...).prepare(sql).bind(secret).all()` sends bind values to Cloudflare, but any thrown error message omits `secret`.
- Good: `summaryFromSql(row, nowMs)` returns the slim account summary and derives
  state without selecting credential columns.
- Base: Docker leaves `GEMINI_DB` absent when all three D1 HTTP env vars are blank, and account-required Gemini generation routes fail closed with 422 `gemini_authenticated_session_required` plus a bounded `reason`.
- Bad: returning `token.slice(0, 8) + "..."` for Gemini cookies in admin/public account lists.
- Bad: `catch (err) { throw err; }` around D1 HTTP calls, because custom fetch implementations or runtime errors can include request bodies.

### 6. Tests Required

- Unit test complete Docker D1 HTTP config injects a D1-compatible `GEMINI_DB` binding.
- Unit test partial D1 HTTP config throws without exposing provided secret values.
- Unit test D1 HTTP `first`, `all`, and `run` normalize Cloudflare query responses into the Worker D1-like shape.
- Unit test adapter status/API/fetch errors do not include SQL params, cookie fragments, session-token fragments, or D1 API token fragments.
- Unit test sanitized account pages omit raw secret fields and raw cookie/session fragments.

### 7. Wrong vs Correct

#### Wrong

```javascript
try {
  return await fetch(endpoint, { body: JSON.stringify({ sql, params }) });
} catch (err) {
  throw err;
}
```

#### Correct

```javascript
try {
  return await fetch(endpoint, { body: JSON.stringify({ sql, params }) });
} catch (_) {
  throw new D1HttpBindingError("D1 HTTP query failed before response", { code: "d1_http_fetch_error" });
}
```

## Scenario: Gemini Account Admin API Auth And Redaction

### 1. Scope / Trigger

Use this contract when changing account-pool admin auth, routes, list projection,
mutation payloads, validation, or D1-backed account administration.

### 2. Signatures

- Admin auth: one `ADMIN_KEY`, sent through `Authorization: Bearer <key>` or
  `X-Admin-Key`; public `API_KEYS` never authorize admin routes.
- `GET /admin/accounts?limit=&cursor=&q=&state=` returns
  `{ items, nextCursor, limit, stats }`.
- Summary fields: `id`, `label`, boolean `enabled`, derived `state`,
  visible `issue`, `cooldown_until_ms`, `last_issue_at_ms`,
  `last_used_at_ms`, `last_refresh_at_ms`, `created_at_ms`, and
  `updated_at_ms`.
- Global stats: `total`, `available`, `cooling`, `attention`,
  `disabled`.
- Create accepts only dual bare Cookie values plus optional label. PATCH accepts
  only `label` and/or `enabled`.
- Bulk actions are `enable | disable | delete | refresh`; single refresh is
  `POST /admin/accounts/:id/refresh`.
- Every mutation returns `{ processed, changed, unchanged, failed, errors? }`;
  errors contain optional `id`, stable `code`, and sanitized `message`.

### 3. Contracts

- `admin-input.ts` is the sole request/query validation owner. `domain.ts`
  owns issue/state vocabularies and page limits. `store-d1-admin.ts` owns SQL
  filtering and the summary projection.
- The list endpoint always returns global stats. There is no `include_stats`
  switch or separate stats route.
- Public state is derived from `enabled + cooldown + issue + now`; it is never
  stored or writable. Temporary issues are omitted after cooldown expiry.
- Admin rows are purpose-built summaries, never sanitized copies of raw D1 rows.
  Cookies, hashes, page/session tokens, bind values, and credentials must not
  cross the service boundary.
- Mutations never echo account rows or detailed diagnostic item arrays. The UI
  reloads the overview after mutation.
- Label-only changes need not invalidate runtime snapshots. Enable/disable,
  create/delete, health transitions, and refreshed credentials publish pool
  version when selectability changes.
- Route auth and query/body validation happen before D1 access. Error envelopes
  remain `{ error: { code, message } }`.
- Model-routing authenticates and matches method/path/family before rejecting
  query parameters; an unknown route with a query remains a route error rather
  than becoming a query-validation error.

### 4. Validation & Error Matrix

- Missing configured admin key -> 401 `admin_auth_not_configured`, zero D1.
- Wrong/public key -> 401 `invalid_admin_key`, zero D1.
- Unknown/duplicate query parameter, including legacy status/category/source
  filters -> explicit 400, zero D1 mutation.
- Legacy update field or `check` bulk action -> explicit 400.
- `GET /admin/accounts/stats` or `POST /admin/accounts/:id/check` -> 404.
- Worker import above 40 -> 413 before hashing/D1; Docker has no count ceiling.
- Browser Admin UI fallback uses ordered 40-account chunks after the exact
  `gemini_import_account_limit_exceeded` response. The UI chunk size is a
  documented wire contract synchronized with the Worker import cap; it must
  not import backend modules across the browser boundary.
- Browser bulk actions use ordered 100-ID chunks only after the exact
  `admin_bulk_action_limit_exceeded` response, matching the Admin API action
  limit shared by Worker and Docker runtimes.
- Missing account during mutation -> compact failed result with
  `account_not_found`; malformed JSON or invalid route input remains a 4xx
  error envelope.
- Unexpected route failure -> generic `admin_request_failed`; per-account
  refresh exceptions become sanitized mutation errors and safe logs.

### 5. Good/Base/Bad Cases

- Good: `GET /admin/accounts?state=attention&q=primary` returns a slim page plus
  global five-field stats.
- Good: PATCH label and enablement only; use explicit enable/disable actions in
  the UI.
- Base: duplicate import or no-op update is `unchanged`, not a failure.
- Bad: returning `SELECT *`, cookie hashes, raw errors, counters, or source
  metadata to the HTTP route.
- Bad: accepting mutable status/state reason or silently ignoring legacy fields.
- Bad: reintroducing Check as an alias for cookie refresh.

### 6. Tests Required

- Admin-key separation and zero-D1 unauthenticated failures.
- Strict list query, create/update body, bulk action, ID, and request-body
  validation including rejection of legacy fields/routes.
- Summary field allowlist, cookie/hash absence, state filtering, expired issue
  suppression, pagination, and global stats.
- Compact mutation counts for create/update/delete/refresh/bulk success, no-op,
  missing account, refresh rejection, and partial failure.
- Worker import limit/Docker behavior and duplicate-cookie races.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`,
  `pnpm unit`, `pnpm coverage:ci`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
return jsonResponse(await store.getAccountForRefresh(id));
```

#### Correct

```typescript
const result = await service.refresh(id);
return jsonResponse(result); // compact counts and sanitized errors only
```

## Scenario: Gemini Account Admin WebUI

### 1. Scope / Trigger

Use this contract when changing the built-in account-pool admin UI, its browser
protocol decoder, state, actions, responsive table/cards, or generated bundle.

### 2. Signatures

- `GET /admin` serves static no-store HTML and performs zero D1 reads; non-GET
  returns 404.
- The UI decodes the exact strict account summary, overview, stats, and compact
  mutation schemas from the admin API.
- Shared UI state contains search, derived-state filter, pagination, selection,
  import/edit drafts, scoped busy flags, confirmation, and transient toasts.
- `updateAdminKey(value)` is the sole browser credential-draft mutation action.
  Credential restore/save/change/clear invalidates the current admin session
  generation and every server-derived account/model-routing state.
- `loadAccounts(direction, verifyConnection)` captures an account-load
  generation plus the requested query, state, cursor stack, and page index; it
  commits that page as one snapshot only while it remains the newest load.
- `runAdminSessionOperation(session, operation, options)` is the sole async
  execution boundary for browser Admin API reads and mutations. It returns an
  explicit success/failure result after checking the captured session.
- `AdminApiSession` is `{ adminKey: string, signal: AbortSignal }`. Every Admin
  API helper accepts this context instead of a bare key, and every fetch in one
  logical operation, including limit-fallback chunks, reuses its signal.
- Wire-limit synchronization contract: the Worker import ceiling and the UI
  import fallback chunk are both `40` accounts; the Admin API bulk-action
  ceiling and the UI bulk-action fallback chunk are both `100` IDs. The
  corresponding stable 413 codes are `gemini_import_account_limit_exceeded` and
  `admin_bulk_action_limit_exceeded`. The UI owns browser-local copies of these
  constants because importing backend modules would cross the browser boundary;
  any change must update this contract and both owners together.
- Model-routing overview `version` is the decimal, monotonically increasing D1
  `pool_version`; the UI uses it as the authoritative snapshot order.
- Row actions: refresh, rename, enable/disable, delete. Bulk actions: refresh,
  enable, disable, delete.

### 3. Contracts

- Default overview renders exactly five metrics: total, available, cooling,
  needs attention, disabled.
- Filters are search plus derived state only. Search covers label/ID; no advanced
  filter disclosure exists.
- Desktop table has eight columns: selection, account, state, last used, current
  issue/cooldown, last successful refresh, status checked, actions. Mobile cards
  expose the same facts and no hidden diagnostic expansion.
- Edit changes label only. Enable/disable remains an explicit action.
- Mutation feedback is a transient toast summarizing processed/changed/
  unchanged/failed. Do not store or render a persistent diagnostics result.
- There is no Check action, metadata CSV export, editable runtime status,
  category/session/source/error display, or success/failure counters.
- Import accepts only value-only `__Secure-1PSID`, `__Secure-1PSIDTS`, and an
  optional label. The 40-account Worker fallback is triggered only by the stable
  413 limit code.
- The strict browser decoder rejects old wide DTOs and unknown protocol fields.
- Admin credentials stay in browser storage/header use only; never place them in
  query strings or logs. All UI text remains English/Simplified Chinese.
- Async admin reads and mutations capture the current credential plus session
  generation before the request. A response from an invalidated generation must
  not update protected state, busy flags, connection state, or feedback.
- One `AbortController` owns each admin session generation. Invalidating the
  generation aborts the controller before publishing a new one; the Admin API
  request owner checks the signal immediately before every fetch and passes it
  through `RequestInit.signal`.
- Every browser Admin API call goes through `runAdminSessionOperation`. A current
  `AdminApiError` with status `401` invalidates the complete protected session
  before feedback is shown; non-auth failures retain the verified session and
  may update only operation-scoped error state.
- Model-routing responses commit through one version-aware state transition.
  Older snapshots never replace newer state; a completed mutation still settles
  its own family from the newest accepted snapshot, while unrelated dirty/busy
  family drafts remain intact.
- Account rows, stats, selection, pagination, model-routing overview/drafts,
  edit/confirmation state, and scoped busy flags are one protected session
  boundary. Clear them together when the credential changes or verification
  fails; protected panels also gate rendering on `connectionVerified`.
- Account/model mutations require the same currently verified session even when
  called outside the rendered controls. A non-empty key alone does not authorize
  browser-side mutation flow.
- Account mutation commands capture the current account-load generation and must
  fail closed while a new page is loading or after that generation is replaced.
  They must not reuse the previous page's selection or trigger a refresh from a
  stale completion.
- Row, bulk, and edit mutations claim one shared set of target account IDs before
  issuing a request. Overlapping claims are rejected with local feedback; each
  claim is released exactly once even when the session is invalidated.
- Concurrent account reads use latest-request-wins ordering inside one credential
  generation. Rows, stats, next cursor, cursor stack, page index, and selection
  commit together; an older response and its `finally` block are ignored.
- Keep the desktop/mobile split, accessible dialogs, scoped busy states, visible
  focus, zoom support, and reduced-motion behavior.

### 4. Validation & Error Matrix

- Missing admin key -> local error and no fetch; invalid key -> sanitized API
  error, connection remains unverified, and all protected state is empty.
- Previously verified session receives 401 from an account read or mutation ->
  invalidate the session generation, clear all protected state and busy flags,
  expand connection settings, and ignore later responses from that generation.
- Credential changes while an admin request is in flight -> invalidate the old
  generation immediately, abort its active fetches, prevent any later fallback
  chunks, and ignore its eventual success/error in UI state.
- Session invalidation between two 40-account import or 100-account action
  chunks -> the next chunk fails locally with `AbortError`; zero further fetches.
- Concurrent model-family saves returned out of order -> retain the overview
  with the greatest decimal `pool_version`, settle both saved family drafts, and
  never restore routes from the older response.
- Concurrent account reads returned out of order -> retain the newest requested
  page and its matching stats/cursors; an older response never clears the newer
  loading state or replaces its data.
- Non-empty draft ADMIN_KEY without successful verification -> protected panels
  are absent and import/update/delete/model-routing actions perform no request.
- Old wide account DTO, old stats, or old mutation shape -> decoder failure.
- Empty batch textarea -> single-account form remains authoritative; malformed
  non-empty row -> client validation error.
- Worker import limit -> ordered 40-account retries; other failures -> one
  request and propagate.
- Bulk action limit -> ordered 100-ID retries; unrelated 413 responses remain
  single-request failures.
- `nextCursor = null` -> next disabled; previous at page zero -> disabled.
- Delete -> scoped in-app confirmation before the first request; cancellation
  performs no mutation.
- Row action -> only that row busy; bulk action -> only batch controls busy.
- Account load in progress -> selection and account mutation controls are
  disabled, and stale command invocations perform no request.
- Row and bulk operations overlap on an account ID -> the second operation is
  rejected locally without changing the first operation's busy state.

### 5. Good/Base/Bad Cases

- Good: reload the overview after mutation and show one concise toast.
- Good: table and cards consume the same `GeminiAccount` summary type.
- Good: route all credential input through `updateAdminKey` and compare the
  captured session generation before committing an async response.
- Good: pass one `AdminApiSession` from the action boundary through every API
  helper and fallback request in the logical operation.
- Good: use the server `pool_version` to order overview snapshots and reconcile
  mutation completion against the newest accepted overview.
- Good: construct a requested account page without mutating live pagination,
  then atomically commit it only if its load generation is still current.
- Good: claim target IDs before a row/bulk/edit request, compare the captured
  load generation on completion, and release the IDs in `finally`.
- Base: issue is `-` for healthy accounts and shows issue plus remaining
  cooldown for cooling accounts.
- Bad: mirroring D1 columns in `admin-ui/types.ts`.
- Bad: CSV export, diagnostics panel, Check, advanced filters, duplicate enabled
  badge, or editable health state.
- Bad: deriving secret presence or previews from raw Cookie material.
- Bad: only flip `connectionVerified` on credential change while leaving old
  account/model-routing state or allowing an old request to repopulate it.
- Bad: let every response matching only the credential generation overwrite the
  account page, or allow import because the draft key is merely non-empty.
- Bad: pass a captured key string into a batching helper, because it can keep
  issuing writes after its owning browser session has been invalidated.

### 6. Tests Required

- Strict schema accepts the slim DTO and rejects old/extra fields.
- Generated HTML contains five metrics, simple filters, eight-column facts,
  pagination, and supported actions; removed controls/labels are absent.
- Import fallback, non-limit failure, compact result merging, load verification,
  cursor navigation, display helpers, confirmation copy, and bare-cookie
  validation.
- Credential-change tests must assert all protected state clears together.
  Deferred-request tests must resolve an old successful verification after a
  key change and assert it cannot repopulate accounts, stats, routing, or
  connection state.
- Return 401 from both a normal account read and a model-routing mutation after
  verification; assert the complete protected session is invalidated in both
  cases.
- Resolve concurrent family-save responses in reverse version order and assert
  that the newest overview plus all settled drafts remain visible.
- Resolve concurrent account-overview responses in reverse request order and
  assert rows/stats/pagination remain from the newest request.
- Attempt import with a non-empty but unverified key and assert zero fetches.
- Start a fallback import, invalidate the session during its first chunk, and
  assert the active fetch signal aborts and no remaining chunks are requested.
- UI route headers/zero-D1 behavior, non-GET 404, no external assets, and no
  credential examples or query-string admin key.
- Build the in-memory Admin UI injection through `pnpm build`; never add or
  hand-edit a generated source module.
- Run the full package quality gate after UI changes.

### 7. Wrong vs Correct

#### Wrong

```typescript
type GeminiAccount = D1AccountRow;
lastDiagnostics.value = mutation;
```

#### Correct

```typescript
type GeminiAccount = GeminiAccountSummary;
showToast(resultSummary(action, mutation));
await loadAccounts();
```

#### Wrong

```typescript
adminKey.value = nextKey;
connectionVerified.value = false;
```

#### Correct

```typescript
updateAdminKey(nextKey); // Invalidates protected state and old async commits.
```

#### Wrong

```typescript
if (isCurrentAdminSession(session)) accounts.value = overview.items;
await createAccount(adminKey.value, input); // Key has not been verified.
```

#### Correct

```typescript
if (isCurrentAccountLoad(session, loadGeneration)) {
  commitAccountPage(requestedPage, overview);
}
const session = currentVerifiedAdminSession();
if (!session) return;
```

#### Wrong

```typescript
try {
  await runAccountAction(adminKey.value, action, identifiers);
} catch (error) {
  showToast(error.message, "error"); // Leaves a rejected session verified.
}
```

#### Correct

```typescript
const session = currentVerifiedAdminSession();
if (!session) return;
const result = await runAdminSessionOperation(
  session,
  () => runAccountAction(session, action, identifiers),
  { fallbackMessage: `${action} failed` },
);
if (!result.ok) return;
```

#### Wrong

```typescript
await createAccountsWithLimitFallback(session.adminKey, input);
```

The fallback loop can keep issuing requests after the captured key's session is
no longer current.

#### Correct

```typescript
await createAccountsWithLimitFallback(session, input);
```

Each request checks and forwards the session's shared abort signal.

## Scenario: Oversized Inline Long Context

### 1. Scope / Trigger

Use this contract when a request may be too large to send inline to Gemini Web and context-file attachments are unavailable. This prevents Worker CPU from being spent on JSON parsing, prompt conversion, Gemini `f.req` serialization, or URL form encoding for a request that cannot be handled safely.

### 2. Signatures

- HTTP boundary: JSON route helpers may reject POST routes before `readJsonRequest` when `Content-Length` exceeds the attachment-aware body read limit for inline-context-unavailable requests.
- JSON boundary: `readJsonRequest(request, { maxBodyBytes, oversizedError })` may stop reading `request.body` as soon as streamed bytes exceed the configured limit.
- Completion boundary: `preparePromptWithAttachments` may return `ContextFileFailure` with `ErrorWithMetadata`.
- Missing authenticated-session error: 422 `gemini_authenticated_session_required` with `reason: "large_context"`.
- Disabled context-file capability error: 422 `large_context_inline_unsupported`.

### 3. Contracts

- Environment keys:
  - `CURRENT_INPUT_FILE_ENABLED=true` keeps context-file attachment support enabled.
  - `CURRENT_INPUT_FILE_MIN_BYTES` is the oversized threshold.
  - `GENERIC_FILE_UPLOAD_MAX_BYTES` contributes to the JSON body read limit because base64 request-local attachments increase `Content-Length` without increasing inline prompt bytes.
  - A configured Gemini account pool must be available for text attachment upload.
  - `LOG_REQUESTS` is opt-in and should not be required for normal operation.
- `Content-Length` is not an inline prompt size. It includes base64 image/file bytes that prompt conversion later replaces with markers and attachment candidates.
- If `Content-Length` is present and exceeds the attachment-aware body read limit while context-file attachments are unavailable, return 422 before parsing JSON. The client-facing message should include `<contentLength> bytes > <bodyLimit>` and the inline prompt threshold.
- If `Content-Length` is absent or inaccurate and streamed body bytes exceed the attachment-aware body read limit while context-file attachments are unavailable, `readJsonRequest` returns 422 before decoding/parsing the full body.
- If a parsed prompt exceeds the threshold after prompt conversion has removed request-local attachment payloads from the live prompt, return 422 before provider generation when context-file attachments are unavailable. The client-facing message should include `<promptBytes> UTF-8 bytes > <threshold>`; bounded checks may say `at least <bytes>`.
- HTTP 413 is reserved for the configured JSON request-body limit and uses `request_body_too_large`.
- If conversion-time checks show the base prompt or estimated final inline prompt exceeds the threshold while text attachments are available, choose the context-file path before constructing the full hidden-tools/structured inline prompt string.
- In the context-file path, upload hard-coded `tools.txt` as the home for tool-use context (not an env-configurable filename). It must contain visible tool descriptions/schemas when present, DSML tool-call format instructions, the tool-choice policy text when present, and `GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT`. The live prompt should only reference the attached tools file and must not duplicate DSML call-format instructions or the hidden native tool payload text.
- If no client-visible tools are declared, still attach `tools.txt` for the hidden native tool prompt when the request uses context files. Token accounting for context-file prompts must include history text, `tools.txt`, and the short live prompt exactly once.
- OpenAI-compatible routes return an OpenAI error envelope.
- Google-compatible routes return `{ error: { message, code } }`.

### 4. Validation & Error Matrix

- `Content-Length > attachment-aware body read limit` and no authenticated session is available -> 422 `gemini_authenticated_session_required`, reason `large_context`.
- Streamed request body exceeds attachment-aware body read limit and no authenticated session is available -> 422 `gemini_authenticated_session_required`, reason `large_context` when the envelope can preserve metadata.
- Prompt bytes exceed threshold and no authenticated session is available -> 422 `gemini_authenticated_session_required`, reason `large_context`.
- Prompt bytes exceed threshold and `CURRENT_INPUT_FILE_ENABLED=false` with an authenticated session available -> 422 `large_context_inline_unsupported`.
- Prompt bytes exceed threshold and text upload fails -> 502 `large_context_file_upload_failed`.
- Context-file path with visible tools -> upload `message.txt` and `tools.txt`; provider prompt references `tools.txt` but does not contain `Available tools`, `<|DSML|tool_calls>`, or `Gemini native hidden tool calls`.
- Context-file path without visible tools -> upload `message.txt` and `tools.txt`; `tools.txt` contains `Gemini native hidden tool calls`.
- Prompt bytes are within threshold -> continue existing inline prompt flow.

### 5. Good/Base/Bad Cases

- Good: reject an oversized no-cookie request before `readJsonRequest` when `Content-Length` proves it exceeds the attachment-aware body read limit.
- Good: pass the attachment-aware body read limit into `readJsonRequest` when inline text attachments are unavailable, so oversized invalid JSON is still bounded while valid image/file requests can reach prompt conversion.
- Good: use conversion-time prompt byte checks plus a bounded final-inline estimate to select context-file upload before concatenating a large hidden-tools/structured inline prompt.
- Good: put tool schemas, DSML call instructions, tool-choice policy, and hidden native tool instructions into `tools.txt` for context-file requests.
- Base: use context-file upload for large authenticated requests and send only the short live prompt inline.
- Bad: allow a multi-megabyte no-cookie prompt to reach Gemini `buildPayload`, which serializes the full prompt into nested JSON and URL form encoding.
- Bad: prepend `toolCallInstructionsFor(...)`, `toolChoiceInstruction`, or `GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT` to the live prompt after `tools.txt` has been attached.

### 6. Tests Required

- Unit test that oversized invalid JSON with `Content-Length` returns the appropriate 422 capability error when the attachment-aware body read limit is exceeded, proving the HTTP guard runs before parsing.
- Unit test that oversized invalid JSON without `Content-Length` returns the appropriate 422 capability error from bounded stream reading when the attachment-aware body read limit is exceeded, proving the body reader stops before JSON parsing.
- Unit test that a request with inline image data and small text prompt can exceed `CURRENT_INPUT_FILE_MIN_BYTES` as `Content-Length` and still reach JSON parsing / prompt conversion.
- Unit test that parsed oversized prompts without an authenticated session return `gemini_authenticated_session_required`, while deployments that explicitly disable context files return `large_context_inline_unsupported`.
- Unit test that context-file requests with visible tools put `Available tool descriptions`, `<|DSML|tool_calls>`, tool-choice policy, and hidden native tool text in `tools.txt`, while the provider live prompt only references the file.
- Unit test that context-file requests without visible tools still upload `tools.txt` containing the hidden native tool prompt.
- Unit test or smoke coverage that existing small-prompt and context-file helper behavior still works.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const parsed = await readJsonRequest(request);
// Later: buildPayload(largePrompt, ...)
```

#### Correct

```typescript
const rejection = oversizedInlineBodyRejection(request, cfg);
if (rejection) return openAIErrorResponse(rejection.message, 413, rejection.code);
const parsed = await readJsonRequest(request);
```

#### Wrong

```typescript
const livePrompt = [
  toolCallInstructionsFor(toolSource, toolDefs),
  choiceInstruction,
  currentInputFilePrompt(cfg, true),
  GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT,
].join("\n\n");
```

#### Correct

```typescript
const toolsText = toolsContextTranscriptFor(toolBundle, choiceInstruction, "tools.txt");
const livePrompt = currentInputFilePrompt(cfg, true);
```
