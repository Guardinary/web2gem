# Error Handling

## Request Parsing

`src/http/index.ts` owns JSON request parsing through `readJsonRequest`. It reads the body as bytes, decodes with fatal UTF-8 decoding, parses JSON through `tryParseJson`, and accepts only JSON objects.

OpenAI-compatible routes convert parse failures with `openAIErrorResponse`. Google-compatible routes return `{ error: { message } }` JSON responses.

## Upstream Errors

Use `upstreamErrorMessage` and `upstreamErrorCode` from `src/shared/runtime.ts` when converting unknown errors. OpenAI upstream failures should use OpenAI-style error envelopes when possible.

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
- Account list/public DTOs may expose `row_id`, hashes, category/status, and boolean presence flags, but not raw `cookie_header`, `SAPISID`, `session_token`, `SNlM0e`, or `at`.

### 3. Contracts

- Partial Docker D1 HTTP configuration must fail startup/config resolution before serving requests.
- Adapter errors may include safe status/code metadata, but must not include SQL text-derived bind values, raw cookie fragments, session-token fragments, or `D1_API_TOKEN`.
- Wrap underlying `fetch` failures from D1 HTTP adapters and replace arbitrary thrown messages with a safe adapter error; do not bubble a lower-level error string that might include request bodies or headers.
- Cookie previews in sanitized account objects must not contain raw cookie prefixes or suffixes. Prefer presence flags, row IDs, hashes, or short non-replayable diagnostics.
- D1 account state should be stored in structured rows, not JSON blob rewrites or delete-and-reinsert-all collection saves.

### 4. Validation & Error Matrix

- `D1_ACCOUNT_ID` and `D1_API_TOKEN` present but `D1_DATABASE_ID` missing -> throw a safe partial-config error listing missing variable names only.
- D1 HTTP response status is non-2xx -> throw `D1 HTTP query failed status=<status>` without SQL params or tokens.
- D1 HTTP API payload reports an error -> throw a safe code-only message such as `D1 HTTP query failed code=<code>`.
- D1 HTTP `fetch` throws before a response -> throw a generic pre-response D1 adapter error, not the original thrown message.
- Sanitized account list response contains raw cookie/session fields or raw cookie preview fragments -> test failure.

### 5. Good/Base/Bad Cases

- Good: `createD1HttpBinding(...).prepare(sql).bind(secret).all()` sends bind values to Cloudflare, but any thrown error message omits `secret`.
- Good: `sanitizeGeminiAccount(row)` returns `has_cookie`, `has_sapisid`, `has_session_token`, hashes, and `cookie_preview: "present"` rather than raw cookie material.
- Base: Docker leaves `GEMINI_DB` absent when all three D1 HTTP env vars are blank, and public Gemini generation routes fail closed with `gemini_account_pool_required`.
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

Use this contract when adding or changing account-pool admin routes, admin auth config, Gemini account import validation, account diagnostics, or any route that can mutate D1-backed Gemini account state.

### 2. Signatures

- Env key: `ADMIN_KEYS` accepts comma-separated admin keys. `ADMIN_KEY` and JSON-array strings are rejected by runtime configuration v2.
- Admin routes live under `/admin/accounts`.
- Supported operations:
  - `GET /admin/accounts?limit=&cursor=&status=&enabled=`
  - `POST /admin/accounts`
  - `PATCH /admin/accounts`
  - `POST /admin/accounts/update`
  - `POST /admin/accounts/enable`
  - `POST /admin/accounts/disable`
  - `DELETE /admin/accounts`
  - `POST /admin/accounts/refresh`
  - `POST /admin/accounts/check`
- Default create payload accepts only `provider`, `accounts[]`, `__Secure-1PSID`, `__Secure-1PSIDTS`, and safe metadata such as `label`, `user_agent`, `gemini_origin`, `source`, `source_id`, and `source_name`.
- Identifier payloads accept `id`, `account_id`, or `row_id`; `identifiers[]` is the batch form.
- `admin-input.ts` exports `normalizeCreateAccounts`, `createInputFromAccount`, `updateFromBody`, `normalizeIdentifiers`, `normalizeListFilter`, and `boundedConcurrency` as the single validation/normalization owner.
- `GeminiAccountAdminService` accepts explicit `adminStore` and `runtimeStore` capabilities; the legacy combined `store` option remains a compatibility construction path.

### 3. Contracts

- Admin auth is separate from public caller auth. Public `API_KEYS`, `x-goog-api-key`, and query-string `key` must not authorize account-pool admin routes.
- Admin routes accept admin credentials through `Authorization: Bearer <key>`, `X-Admin-Key`, or `x-api-key`, matched only against `cfg.admin_keys`.
- Missing, empty, or placeholder-only admin config fails closed with `401 admin_auth_not_configured`. Placeholder values include `changeme`, `change-me`, `your-admin-key`, `admin`, `password`, `test`, `example`, and `sample`.
- Service-layer admin methods return sanitized DTOs before the HTTP route serializes responses. Route handlers must not receive raw D1 account rows for list/create/update/delete/refresh/check results.
- Default Gemini import must reject full Cookie headers, JSON-looking cookie blobs, `access_token`, `accessToken`, `cookie`, `cookies`, extra non-null payload keys, provider mismatches, missing PSID/PSIDTS, and dual-field values containing cookie names, `=`, or `;`.
- List pagination is bounded: default `limit` is 50 and maximum `limit` is 200.
- Delete/update/enable/disable/refresh/check resolve and dedupe `id` / `account_id` / `row_id` before mutating D1 rows or scheduling refresh work.
- HTTP and service orchestration must consume normalized values from `admin-input.ts`; do not re-parse the same untyped payload fields in route or persistence code.
- Refresh/check are explicit admin-only diagnostics. Startup, health, public model listing, and public liveness routes must not select accounts, call `/app`, rotate cookies, run model/capability probes, or mutate account/session state.

### 4. Validation & Error Matrix

- No valid admin key configured -> `401 { error: { code: "admin_auth_not_configured" } }`, no D1 read.
- Public `API_KEYS` presented to an admin route -> `401 invalid_admin_key`, no D1 read unless it also equals a configured admin key.
- Admin route with no `GEMINI_DB` binding -> `503 gemini_account_store_unavailable`.
- Create with unsafe Gemini import shape -> `400` with a safe `gemini_import_*` code.
- Constructing `GeminiAccountAdminService` without either a combined store or both explicit capabilities -> developer configuration error before request handling.
- Update/delete with no resolvable identifier -> `400 account_identifier_required` or `404 account_not_found`.
- Refresh/check missing, disabled, or not-refreshable account -> count as `skipped` with a sanitized reason.
- Unexpected D1/upstream/admin failure -> safe error code/message or `errorLogSummary(error)` only; do not serialize arbitrary `error.message`.

### 5. Good/Base/Bad Cases

- Good: `/admin/accounts` checks admin auth before constructing a store or reading D1.
- Good: `createGeminiAccountAdminServiceFromD1(...).create(...)` returns `GeminiAccountPublic` items with `has_cookie`/hash/status metadata and no `cookie_header`, `sapisid`, or `session_token`.
- Good: D1 factory passes the same adapter as both `adminStore` and `runtimeStore`, while `AccountPoolService` sees only the runtime capability type.
- Good: refresh/check responses include `checked`, `skipped`, `refreshed`, `unchanged`, `failed`, `errors`, `results`, and sanitized `items`.
- Base: `/`, `/v1/models`, and `/v1beta/models` return static responses without constructing account runtime or reading D1 account rows.
- Bad: reusing `authorized(request, url, cfg)` for admin routes, because it accepts public `API_KEYS` and query-string `key`.
- Bad: route handlers receiving `GeminiAccountSecretRow` and relying on final JSON filtering for redaction.
- Bad: copying cookie/filter/identifier validation back into `admin.ts` or `http/admin` after it has been centralized in `admin-input.ts`.
- Bad: health checks or public model list endpoints that call refresh/check or dynamic model discovery.

### 6. Tests Required

- Unit test strict admin key parsing, placeholder rejection, removed `ADMIN_KEY` rejection, and config cache invalidation for `ADMIN_KEYS`.
- Unit test public `API_KEYS` cannot authorize admin routes and unauthenticated admin failures perform zero D1 `prepare` calls.
- Unit test safe dual-field Gemini import accepts and unsafe token/cookie/blob/provider/extra-key shapes reject.
- Unit test admin-input projections directly, including identifier dedupe, filter bounds, update normalization, and combined-store compatibility.
- Unit test admin list limit clamping and cursor/filter behavior.
- Unit test update/delete/refresh/check identifier dedupe.
- Unit test refresh/check count fields, skipped reasons, and sanitized item/error payloads.
- Unit test health/model-list routes perform zero D1 account reads when `GEMINI_DB` is configured.
- Unit or review checks should search full admin JSON responses for raw cookie/session fragments, not only known fields.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (!authorized(request, url, cfg)) return openAIErrorResponse("invalid api key", 401);
return jsonResponse(await store.getAccountForRefresh(id));
```

#### Correct

```typescript
const auth = adminAuthorized(request, cfg);
if (!auth.ok) return adminErrorResponse(auth);
return jsonResponse(await service.refresh(body)); // service returns sanitized DTOs
```

## Scenario: Gemini Account Admin WebUI

### 1. Scope / Trigger

Use this contract when adding or changing the built-in browser UI for Gemini account-pool administration. The UI is part of the Worker HTTP boundary and must stay aligned with the sanitized admin API instead of introducing a separate frontend stack or a second mutation contract.

### 2. Signatures

- UI route: `GET /admin` returns static `text/html; charset=utf-8` with `cache-control: no-store`.
- Non-GET requests to the UI route return 404 and must not create a `GEMINI_DB` binding or read D1.
- API route used by the UI: `/admin/accounts`.
- Admin auth header: `Authorization: Bearer <admin-key>`.
- Gemini import payload: `{ provider: "gemini", "__Secure-1PSID": string, "__Secure-1PSIDTS": string, label?: string }`.
- Mutation payload: `{ identifiers: Array<{ id?: string; account_id?: string; row_id?: string }> }`.
- `src/admin-ui/state.ts` owns shared Preact signals and UI draft types.
- `src/admin-ui/logic.ts` owns browser-independent identifiers, validation, parsing, formatting, summaries, and sanitized CSV construction.
- `src/admin-ui/actions.ts` owns browser storage, API calls, pagination transitions, destructive confirmation, downloads, and toast side effects.
- `src/admin-ui/components.tsx` owns reusable metric, account-row, and edit-modal presentation; `app.tsx` remains the composition shell.

### 3. Contracts

- The UI must be served by the Worker from `src/http/admin/**` and routed before the broader `/admin/accounts` admin API prefix.
- The admin key may be stored client-side by the browser, but it must only be sent as an admin header. Do not put admin keys in query strings, HTML links, form actions, or local logs.
- The UI may render sanitized account metadata from `GeminiAccountPublic`, including IDs, row IDs, labels, statuses, boolean secret-presence flags, redacted error text, and source metadata.
- The UI must not render raw `cookie_header`, SAPISID values, session tokens, SQL bind values, or D1 API tokens.
- The UI must import Gemini accounts with value-only `__Secure-1PSID` and `__Secure-1PSIDTS` fields. It must not accept or show full cookie headers, cookie-name/value examples, JSON blobs, `tokens`, `access_token`, or legacy single-cookie fallback fields.
- Row and batch actions must reuse existing admin API operations: refresh, check, enable, disable, and delete. Do not add UI-only mutation routes.
- Editing account labels/status/enabled/source metadata must use `PATCH /admin/accounts` with identifier fields plus safe update fields only.
- Cursor pagination must use the admin API's `nextCursor` without requesting or caching raw D1 rows. The server `nextCursor` is the last returned row id, matching the route's `id > cursor` query semantics.
- Client-side metadata export may include sanitized account IDs, status/category, timestamps, counters, redacted errors, and source metadata. It must not export raw cookies, SAPISID values, session tokens, SQL bind values, or D1 API tokens.
- Public API auth remains separate from admin auth. A public API key must not authorize UI-driven admin API mutations.
- Browser-independent UI behavior must not read module-global signals or browser globals. Pass data (and time where determinism matters) into pure helpers, then keep signal/browser mutation in `actions.ts`.

### 4. Validation & Error Matrix

- UI route `GET` -> 200 static HTML without D1 reads.
- UI route non-GET -> 404 without D1 reads.
- Missing admin key in browser state -> UI should require one before API calls; API returns 401 if called anyway.
- Admin key supplied in URL query or form action -> forbidden implementation pattern.
- Import field contains `=`, `;`, JSON-looking text, or cookie names -> reject client-side before API call; server validation remains authoritative.
- Admin API returns non-2xx JSON error -> show the sanitized error message, not raw response bodies or request payload secrets.
- List response includes secret-presence flags -> render safe labels such as present/missing; do not derive previews from raw values.
- Metadata export requested with no current rows -> no-op user error.
- Batch import parser receives an empty string -> return no batch items so the single-account form remains authoritative; malformed non-empty rows -> safe client-side validation error.
- Cursor pagination response with `nextCursor=null` -> disable the next-page control.

### 5. Good/Base/Bad Cases

- Good: static UI calls `fetch("/admin/accounts", { headers: { Authorization: "Bearer " + key } })`.
- Good: unit tests import `admin-ui/logic.ts` through `src/test-exports.ts` without importing the browser entrypoint or adding a DOM emulator.
- Good: import form submits only `provider`, `__Secure-1PSID`, `__Secure-1PSIDTS`, and optional display metadata.
- Base: UI displays sanitized account status, enabled state, IDs, row IDs, timestamps, source metadata, and redacted error text from the existing admin API response.
- Base: UI may show refreshability, cooldown, success/failure counters, and category filters derived from sanitized admin fields.
- Bad: serving a separate Next.js/React build for this Worker-only admin console.
- Bad: using `/admin/accounts?admin_key=...`, `x-api-key` public auth, or full `Cookie: __Secure-1PSID=...` examples.
- Bad: adding a Gemini TXT export that serializes raw cookie values through the browser UI.
- Bad: components implementing their own cookie parsing, identifier selection, or CSV field list instead of using `logic.ts`.
- Bad: adding UI text or docs that reintroduce `GEMINI_COOKIE` or single-cookie fallback setup.

### 6. Tests Required

- Unit test the Worker serves the UI route with `text/html`, `no-store`, and zero D1 reads.
- Unit test non-GET UI requests return 404 and perform zero D1 reads.
- Unit or snapshot-style assertions should verify static HTML/JS includes the admin API path, bearer admin header usage, value-only dual-cookie fields, and existing action names.
- Unit or snapshot-style assertions should cover static UI controls for category/cooldown filters, pagination, safe metadata export, editing safe metadata, and success/failure counters.
- Unit tests should cover value-only cookie validation, batch rows, identifier preference, deterministic relative time, mutation summaries, and CSV escaping/field allowlisting through the pure logic owner.
- Unit test admin list cursor pagination so `nextCursor` does not skip the first row on the next page.
- Unit or grep-style assertions should verify the UI bundle does not contain `GEMINI_COOKIE`, raw cookie examples, SAPISID value examples, session-token examples, or query-parameter admin-key patterns.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke` after changing the UI route, static HTML, or Worker routing.

### 7. Wrong vs Correct

#### Wrong

```javascript
fetch("/admin/accounts?admin_key=" + encodeURIComponent(key));
```

#### Correct

```javascript
fetch("/admin/accounts", {
  headers: { Authorization: "Bearer " + key },
});
```

#### Wrong

```javascript
body: JSON.stringify({ cookie: "__Secure-1PSID=...; __Secure-1PSIDTS=..." });
```

#### Correct

```javascript
body: JSON.stringify({
  provider: "gemini",
  "__Secure-1PSID": psidValue,
  "__Secure-1PSIDTS": psidtsValue,
});
```

## Scenario: Oversized Inline Long Context

### 1. Scope / Trigger

Use this contract when a request may be too large to send inline to Gemini Web and context-file attachments are unavailable. This prevents Worker CPU from being spent on JSON parsing, prompt conversion, Gemini `f.req` serialization, or URL form encoding for a request that cannot be handled safely.

### 2. Signatures

- HTTP boundary: JSON route helpers may reject POST routes before `readJsonRequest` when `Content-Length` exceeds the attachment-aware body read limit for inline-context-unavailable requests.
- JSON boundary: `readJsonRequest(request, { maxBodyBytes, oversizedError })` may stop reading `request.body` as soon as streamed bytes exceed the configured limit.
- Completion boundary: `preparePromptWithAttachments` may return `ContextFileFailure` with `ErrorWithMetadata`.
- Error code: `large_context_inline_unsupported`.

### 3. Contracts

- Environment keys:
  - `CURRENT_INPUT_FILE_ENABLED=true` keeps context-file attachment support enabled.
  - `CURRENT_INPUT_FILE_MIN_BYTES` is the oversized threshold.
  - `GENERIC_FILE_UPLOAD_MAX_BYTES` contributes to the JSON body read limit because base64 request-local attachments increase `Content-Length` without increasing inline prompt bytes.
  - A configured Gemini account pool must be available for text attachment upload.
  - `LOG_REQUESTS` is opt-in and should not be required for normal operation.
- `Content-Length` is not an inline prompt size. It includes base64 image/file bytes that prompt conversion later replaces with markers and attachment candidates.
- If `Content-Length` is present and exceeds the attachment-aware body read limit while context-file attachments are unavailable, return 413 before parsing JSON. The client-facing message should include `<contentLength> bytes > <bodyLimit>` and the inline prompt threshold.
- If `Content-Length` is absent or inaccurate and streamed body bytes exceed the attachment-aware body read limit while context-file attachments are unavailable, `readJsonRequest` returns 413 before decoding/parsing the full body. The client-facing message should include `at least <bodyLimit + 1> UTF-8 bytes > <bodyLimit>` and the inline prompt threshold.
- If a parsed prompt exceeds the threshold after prompt conversion has removed request-local attachment payloads from the live prompt, return 413 before provider generation when context-file attachments are unavailable. The client-facing message should include `<promptBytes> UTF-8 bytes > <threshold>`; bounded checks may say `at least <bytes>`.
- If conversion-time checks show the base prompt or estimated final inline prompt exceeds the threshold while text attachments are available, choose the context-file path before constructing the full hidden-tools/structured inline prompt string.
- In the context-file path, upload `CURRENT_TOOLS_FILE_NAME` (default `tools.txt`) as the home for tool-use context. It must contain visible tool descriptions/schemas when present, DSML tool-call format instructions, the tool-choice policy text when present, and `GEMINI_NATIVE_HIDDEN_TOOLS_PROMPT`. The live prompt should only reference the attached tools file and must not duplicate DSML call-format instructions or the hidden native tool payload text.
- If no client-visible tools are declared, still attach `tools.txt` for the hidden native tool prompt when the request uses context files. Token accounting for context-file prompts must include history text, `tools.txt`, and the short live prompt exactly once.
- OpenAI-compatible routes return an OpenAI error envelope.
- Google-compatible routes return `{ error: { message, code } }`.

### 4. Validation & Error Matrix

- `Content-Length > attachment-aware body read limit` and no authenticated account-pool session is available -> 413 `large_context_inline_unsupported`.
- Streamed request body exceeds attachment-aware body read limit and no authenticated account-pool session is available -> 413 `large_context_inline_unsupported`.
- Prompt bytes exceed threshold and no authenticated account-pool session is available -> 413 `large_context_inline_unsupported`.
- Prompt bytes exceed threshold and `CURRENT_INPUT_FILE_ENABLED=false` -> 413 `large_context_inline_unsupported`.
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

- Unit test that oversized invalid JSON with `Content-Length` returns 413 when the body read limit is exceeded, proving the HTTP guard runs before parsing.
- Unit test that oversized invalid JSON without `Content-Length` returns 413 from bounded stream reading when the body read limit is exceeded, proving the body reader stops before JSON parsing.
- Unit test that a request with inline image data and small text prompt can exceed `CURRENT_INPUT_FILE_MIN_BYTES` as `Content-Length` and still reach JSON parsing / prompt conversion.
- Unit test that parsed oversized prompts without attachment support return `large_context_inline_unsupported`.
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
