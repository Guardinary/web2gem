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

`src/index.ts` catches unhandled route errors, logs through `log(cfg, ...)`, and returns a JSON 500 response. Keep this as the final fallback, not the primary validation mechanism.

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

- Env keys: `ADMIN_KEYS` accepts comma-separated or JSON-array admin keys; `ADMIN_KEY` is a single-key compatibility alias.
- Admin routes live under `/admin/gemini/accounts`.
- Supported operations:
  - `GET /admin/gemini/accounts?limit=&cursor=&status=&enabled=`
  - `POST /admin/gemini/accounts`
  - `PATCH /admin/gemini/accounts`
  - `POST /admin/gemini/accounts/update`
  - `POST /admin/gemini/accounts/enable`
  - `POST /admin/gemini/accounts/disable`
  - `DELETE /admin/gemini/accounts`
  - `POST /admin/gemini/accounts/refresh`
  - `POST /admin/gemini/accounts/check`
- Default create payload accepts only `provider`, `accounts[]`, `__Secure-1PSID`, `__Secure-1PSIDTS`, and safe metadata such as `label`, `user_agent`, `gemini_origin`, `source`, `source_id`, and `source_name`.
- Identifier payloads accept `id`, `account_id`, or `row_id`; `identifiers[]` is the batch form.

### 3. Contracts

- Admin auth is separate from public caller auth. Public `API_KEYS`, `x-goog-api-key`, and query-string `key` must not authorize account-pool admin routes.
- Admin routes accept admin credentials through `Authorization: Bearer <key>`, `X-Admin-Key`, or `x-api-key`, matched only against `cfg.admin_keys`.
- Missing, empty, or placeholder-only admin config fails closed with `401 admin_auth_not_configured`. Placeholder values include `changeme`, `change-me`, `your-admin-key`, `admin`, `password`, `test`, `example`, and `sample`.
- Service-layer admin methods return sanitized DTOs before the HTTP route serializes responses. Route handlers must not receive raw D1 account rows for list/create/update/delete/refresh/check results.
- Default Gemini import must reject full Cookie headers, JSON-looking cookie blobs, `access_token`, `accessToken`, `cookie`, `cookies`, extra non-null payload keys, provider mismatches, missing PSID/PSIDTS, and dual-field values containing cookie names, `=`, or `;`.
- List pagination is bounded: default `limit` is 50 and maximum `limit` is 200.
- Delete/update/enable/disable/refresh/check resolve and dedupe `id` / `account_id` / `row_id` before mutating D1 rows or scheduling refresh work.
- Refresh/check are explicit admin-only diagnostics. Startup, health, public model listing, and public liveness routes must not select accounts, call `/app`, rotate cookies, run model/capability probes, or mutate account/session state.

### 4. Validation & Error Matrix

- No valid admin key configured -> `401 { error: { code: "admin_auth_not_configured" } }`, no D1 read.
- Public `API_KEYS` presented to an admin route -> `401 invalid_admin_key`, no D1 read unless it also equals a configured admin key.
- Admin route with no `GEMINI_DB` binding -> `503 gemini_account_store_unavailable`.
- Create with unsafe Gemini import shape -> `400` with a safe `gemini_import_*` code.
- Update/delete with no resolvable identifier -> `400 account_identifier_required` or `404 account_not_found`.
- Refresh/check missing, disabled, or not-refreshable account -> count as `skipped` with a sanitized reason.
- Unexpected D1/upstream/admin failure -> safe error code/message or `errorLogSummary(error)` only; do not serialize arbitrary `error.message`.

### 5. Good/Base/Bad Cases

- Good: `/admin/gemini/accounts` checks admin auth before constructing a store or reading D1.
- Good: `createGeminiAccountAdminServiceFromD1(...).create(...)` returns `GeminiAccountPublic` items with `has_cookie`/hash/status metadata and no `cookie_header`, `sapisid`, or `session_token`.
- Good: refresh/check responses include `checked`, `skipped`, `refreshed`, `unchanged`, `failed`, `errors`, `results`, and sanitized `items`.
- Base: `/`, `/v1/models`, and `/v1beta/models` return static responses without constructing account runtime or reading D1 account rows.
- Bad: reusing `authorized(request, url, cfg)` for admin routes, because it accepts public `API_KEYS` and query-string `key`.
- Bad: route handlers receiving `GeminiAccountSecretRow` and relying on final JSON filtering for redaction.
- Bad: health checks or public model list endpoints that call refresh/check or dynamic model discovery.

### 6. Tests Required

- Unit test admin key normalization, placeholder rejection, and config cache invalidation for `ADMIN_KEYS` / `ADMIN_KEY`.
- Unit test public `API_KEYS` cannot authorize admin routes and unauthenticated admin failures perform zero D1 `prepare` calls.
- Unit test safe dual-field Gemini import accepts and unsafe token/cookie/blob/provider/extra-key shapes reject.
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
