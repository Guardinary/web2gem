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

When selected account credentials are present and Gemini generation returns an authentication-style upstream status (`401` or `403`), classify it immediately as `invalid_gemini_cookie` before reading or parsing the response body, log safe metadata, and return HTTP 401 to OpenAI-compatible and Google-compatible callers. Do not retry the same request anonymously. Request-local image and generic file uploads may still degrade as described above; text-file context upload must fail instead of falling back.

When selected account credentials are present, generation requests must also verify the Gemini page auth token (`at`) before calling `StreamGenerate`. If `/app` does not yield `at`, return `invalid_gemini_cookie` immediately instead of sending the generation request without `at`, because that silently turns the request into anonymous behavior.

When Gemini WRB response parsing yields no text, logs under `LOG_REQUESTS` should include safe response-shape diagnostics such as WRB line count, parsed-envelope count, parsed-inner count, text-part count, and a reason class. Do not log raw WRB payload snippets or response text as diagnostics.

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

### 4. Validation & Error Matrix

- Missing configured admin key -> 401 `admin_auth_not_configured`, zero D1.
- Wrong/public key -> 401 `invalid_admin_key`, zero D1.
- Unknown/duplicate query parameter, including legacy status/category/source
  filters -> explicit 400, zero D1 mutation.
- Legacy update field or `check` bulk action -> explicit 400.
- `GET /admin/accounts/stats` or `POST /admin/accounts/:id/check` -> 404.
- Worker import above 40 -> 413 before hashing/D1; Docker has no count ceiling.
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
- Row actions: refresh, rename, enable/disable, delete. Bulk actions: refresh,
  enable, disable, delete.

### 3. Contracts

- Default overview renders exactly five metrics: total, available, cooling,
  needs attention, disabled.
- Filters are search plus derived state only. Search covers label/ID; no advanced
  filter disclosure exists.
- Desktop table has seven columns: selection, account, state, last used, current
  issue/cooldown, last refresh, actions. Mobile cards expose the same facts and
  no hidden diagnostic expansion.
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
- Keep the desktop/mobile split, accessible dialogs, scoped busy states, visible
  focus, zoom support, and reduced-motion behavior.

### 4. Validation & Error Matrix

- Missing admin key -> local error and no fetch; invalid key -> sanitized API
  error and connection remains unverified.
- Old wide account DTO, old stats, or old mutation shape -> decoder failure.
- Empty batch textarea -> single-account form remains authoritative; malformed
  non-empty row -> client validation error.
- Worker import limit -> ordered 40-account retries; other failures -> one
  request and propagate.
- `nextCursor = null` -> next disabled; previous at page zero -> disabled.
- Delete -> scoped in-app confirmation before the first request; cancellation
  performs no mutation.
- Row action -> only that row busy; bulk action -> only batch controls busy.

### 5. Good/Base/Bad Cases

- Good: reload the overview after mutation and show one concise toast.
- Good: table and cards consume the same `GeminiAccount` summary type.
- Base: issue is `-` for healthy accounts and shows issue plus remaining
  cooldown for cooling accounts.
- Bad: mirroring D1 columns in `admin-ui/types.ts`.
- Bad: CSV export, diagnostics panel, Check, advanced filters, duplicate enabled
  badge, or editable health state.
- Bad: deriving secret presence or previews from raw Cookie material.

### 6. Tests Required

- Strict schema accepts the slim DTO and rejects old/extra fields.
- Generated HTML contains five metrics, simple filters, seven-column facts,
  pagination, and supported actions; removed controls/labels are absent.
- Import fallback, non-limit failure, compact result merging, load verification,
  cursor navigation, display helpers, confirmation copy, and bare-cookie
  validation.
- UI route headers/zero-D1 behavior, non-GET 404, no external assets, and no
  credential examples or query-string admin key.
- Rebuild `src/generated/admin-ui.ts` through `pnpm build`; never hand-edit it.
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
- In the context-file path, upload `CURRENT_TOOLS_FILE_NAME` (default `tools.txt`) as the home for tool-use context. It must contain visible tool descriptions/schemas when present, DSML tool-call format instructions, the tool-choice policy text when present, and `GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT`. The live prompt should only reference the attached tools file and must not duplicate DSML call-format instructions or the hidden native tool payload text.
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
const toolsText = toolsContextTranscriptFor(toolSource, choiceInstruction, cfg.current_tools_file_name, toolDefs);
const livePrompt = currentInputFilePrompt(cfg, true);
```
