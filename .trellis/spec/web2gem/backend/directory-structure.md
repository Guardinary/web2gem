# Directory Structure

## Source Layout

- The root `package.json` / `src/` tree is the default `web2gem` package. The Cloudflare Worker build and architecture guard are scoped to this root package unless a task explicitly expands the scope.
- `src/app.ts` is the application composition root. It owns route matching, CORS wrapping, public/admin auth policy ordering, request parsing before account-runtime acquisition, provider composition, and top-level error conversion using Web-standard `Request` / `Response` types.
- `src/index.ts` is the thin Cloudflare Worker entrypoint. It delegates `fetch` to `handleApplicationRequest` and exports only stable public helpers; protocol route branches must not be added there.
- `src/http/` owns HTTP boundary concerns only. Generic CORS/auth/JSON/SSE helpers live under `http/core/`, stream framing helpers under `http/stream/`, and protocol adapters under `http/openai/` and `http/google/`.
- `src/http/openai/images.ts` owns OpenAI image route orchestration and generation response flow. JSON and multipart image-edit input normalization, upload-size enforcement, and image-part coercion belong in `src/http/openai/images-input.ts`; keep provider calls and response formatting out of that input owner.
- HTTP protocol adapters should import `http/core/*` and `http/stream/*` owner modules directly. `src/http/index.ts` is a public/top-level barrel for the Worker entrypoint and compatibility exports, not an internal dependency for protocol adapters.
- `src/completion/` owns provider-neutral completion contracts and shared business behavior: prompt/context preparation, provider text-generation ports, empty-output handling, stream/tool-sieve event generation, one `CompletionStreamLifecycle` reducer, and completion turn finalization. Protocol adapters must not mirror reducer-owned issue/empty/tool-call/policy/count state, and callback-style stream consumption APIs are not part of the contract.
- `src/promptcompat/` converts OpenAI Responses, OpenAI chat, and Google content shapes into prompt text and file references.
- `src/toolcall/` owns tool-call prompt formatting, parsing, policy validation, and schema normalization.
- `src/toolcall/index.ts` is a compatibility barrel only. Implementation modules outside `src/toolcall/` should import concrete owner modules such as `toolcall/content`, `toolcall/tool-bundle`, `toolcall/policy-openai`, `toolcall/policy-google`, `toolcall/google`, `toolcall/dsml`, `toolcall/openai-format`, `toolcall/prompt-format`, or `toolcall/structured` instead of the broad barrel.
- `src/toolstream/` owns streamed tool-call sieve state.
- `src/gemini/` owns Gemini Web protocol details, transport, and upload behavior. `gemini/client/index.ts` should stay an orchestration layer; payload/header construction, response parsing, retry helpers, and domain error classification live in sibling client modules.
- `src/gemini/client/generated-images.ts` owns generated-image URL candidates, browser/cookie download headers, byte hydration, supported output-format mapping, and URL fallback. It must reuse MIME detection from `src/attachments/mime.ts` and encoding from `src/attachments/base64.ts`.
- `src/gemini/accounts/admin-input.ts` owns admin request normalization and validation. `admin.ts` owns account-admin use-case orchestration and depends on capability-specific admin/runtime store contracts.
- `src/gemini/accounts/domain.ts` is the single owner for account issue/state
  vocabularies, guards, derived-state rules, and the shared
  default/minimum/maximum account page limit. Admin input, runtime
  classification, and D1 summary projection must reuse this owner instead of
  maintaining parallel status arrays or limit clamps.
- `src/gemini/accounts/store-d1.ts` owns minimal D1 account persistence operations. Admin summary projection, derived-state filter-to-SQL construction, and global stats belong in `src/gemini/accounts/store-d1-admin.ts`; keep database execution and mutations in the main store.
- `src/gemini/transport/http.ts` owns the unified upstream HTTP entry. It may choose `cloudflare:sockets` first and fall back to `fetch` only when request semantics are preserved.
- `src/gemini/transport/socket.ts` is the public socket transport facade. If the socket implementation is decomposed, keep public exports compatible from this module and move internals into owner modules under `src/gemini/transport/`.
- `src/gemini/completion-provider.ts` is the Gemini adapter for `src/completion/ports.ts`. It may import completion port types; other Gemini implementation modules should not depend on completion business modules.
- `src/shared/` must stay leaf-level and provider-neutral. Production code imports concrete owners: `encoding.ts`, `logging.ts`, `abort.ts`, `errors.ts`, and `crypto.ts`; `runtime.ts` is compatibility-only. Gemini SAPISID hashing belongs to `src/gemini/auth.ts`.
- Media and attachment helpers live under `src/attachments/**`; do not add compatibility shims under `src/shared/`.
- `scripts/docker-server.mjs` adapts Node HTTP requests to the Worker `fetch` entrypoint. It owns Node header/body/response-stream translation and propagates client disconnects into the Web `Request.signal`; it must not duplicate route, auth, completion, or provider logic.

## Scenario: Shared Application Routing Boundary

### 1. Scope / Trigger

Use this contract when adding or moving routes, changing route-level authentication or CORS, changing top-level request errors, or modifying the Cloudflare Worker and Docker request adapters.

### 2. Signatures

- `handleApplicationRequest(request, env, executionContext): Promise<Response>` in `src/app.ts` is the shared Web-standard application entrypoint.
- `src/index.ts` exposes the Cloudflare default export with `fetch: handleApplicationRequest`.
- `handleDockerRequest(req, res, options)` translates Node HTTP to the Worker `fetch` contract and links disconnects to `Request.signal`.

### 3. Contracts

- Route matching, CORS, configuration composition, public/admin auth ordering, JSON validation, account-runtime acquisition, protocol dispatch, and sanitized top-level errors have one owner: `src/app.ts`.
- `src/index.ts` contains no protocol-specific route branches and exports only `src/public-exports.ts`.
- The Docker adapter delegates to the built Worker entrypoint and owns only platform translation, D1 binding injection, response streaming, and disconnect propagation.
- Public authentication and request-body validation must finish before any account lease acquisition or D1 account read.

### 4. Validation & Error Matrix

- CORS preflight -> 204 before runtime configuration or authentication.
- Health and admin UI routes -> retain their documented auth exemptions and ordering.
- Invalid public auth or invalid generation JSON -> 4xx with zero account-store reads.
- Docker request abort or premature response close -> abort the shared `Request.signal`; do not emit a second adapter 500.
- Unexpected application error -> sanitized JSON 500 through the application boundary.

### 5. Good/Base/Bad Cases

- Good: add a route branch or matcher in `src/app.ts` and cover its method/path/auth/body/account policy in route tests.
- Base: Cloudflare and Docker both delegate to the same Worker/application handler and return equivalent status, protocol headers, and body.
- Bad: add a Docker-only route, auth shortcut, protocol handler, or error envelope.

### 6. Tests Required

- Route-matrix tests for OPTIONS, health, models, admin, generation, and not-found behavior.
- Tests proving invalid auth/body requests do not acquire account leases or read D1.
- Representative Cloudflare-versus-Docker response parity for status, content type, CORS, and body.
- Docker disconnect test asserting the application `Request.signal` is aborted.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, `pnpm coverage:ci`, `pnpm smoke`, and `pnpm check:size`.

### 7. Wrong vs Correct

#### Wrong

```javascript
// scripts/docker-server.mjs
if (req.url === "/v1/models") return sendModels(res);
```

#### Correct

```typescript
// src/index.ts
export default { fetch: handleApplicationRequest };
```

## Provider Ports and Stream Events

### 1. Scope / Trigger

Use the completion provider port when code needs model text generation, request-local attachment resolution, or large-context text-file upload from completion/business logic. This keeps Gemini Web details behind an adapter and prevents completion modules from depending on provider implementation packages.

### 2. Signatures

- `CompletionProvider.generateText(input)` returns final text.
- `CompletionProvider.streamText(input, options)` returns provider text deltas as `AsyncIterable<string>`. Provider adapters normalize loose upstream chunks before they cross the port.
- `CompletionProvider.resolveAttachments(plan)` accepts a provider-neutral attachment plan and returns provider file references plus request-local dropped-attachment notes.
- `CompletionProvider.uploadTextFile(text, filename)` returns a provider file reference for large context attachment.
- `CompletionTextInput.fileRefs` is `FileRef[] | null | undefined`; completion and HTTP modules should not pass untyped provider file payloads through this port.
- `streamPlainCompletionEvents`, `streamToolSieveCompletionEvents`, and `streamBufferedToolTextCompletionEvents` convert provider deltas into explicit completion events.

### 3. Contracts

- `src/app.ts` is the composition root: create the concrete Gemini provider there and pass it into HTTP handlers.
- HTTP handlers may depend on completion ports/events, but must not call `gemini/client` or `gemini/uploads`.
- Completion modules may depend on prompt compatibility, tool-call, toolstream, shared, config, and model types, but not `src/gemini/**`.
- Stream adapters should format protocol-specific SSE frames from completion events rather than coordinating provider callbacks directly.
- Context preparation should keep request-local attachment resolution and large-context text upload behind `CompletionProvider.resolveAttachments` and `CompletionProvider.uploadTextFile`. Shared prompt/file-reference sequencing belongs in `src/completion/context.ts`; OpenAI and Google branches should only supply protocol-specific prompt conversion and file-reference ordering.

### 4. Validation & Error Matrix

- Provider stream abort -> rethrow abort errors; do not convert client disconnects into noisy SSE warnings.
- Provider stream error before output -> emit an explicit stream-error event; HTTP protocol adapters decide whether to fail or surface fallback text.
- Provider stream error after partial output -> emit a warning event; adapters preserve partial-output behavior.
- No provider output and no error -> emit an empty event; adapters preserve each protocol's existing empty-output behavior.

### 5. Good/Base/Bad Cases

- Good: `src/app.ts` creates `createGeminiCompletionProvider(cfg)` and passes it to `handleChat`.
- Base: completion consumes `CompletionProvider.streamText(...)` through completion event helpers.
- Bad: `src/completion/runtime.ts` imports `../gemini/client` or HTTP stream code calls provider delta callbacks directly.

### 6. Tests Required

- Run `pnpm typecheck` after changing provider signatures.
- Run `pnpm check:arch` after moving imports or adding modules.
- Run `pnpm smoke` after changing Worker routing, public exports, or stream wiring.
- Run `pnpm unit` when changing stream delta consumption, tool sieve behavior, or context-file upload helpers.

### 7. Wrong vs Correct

#### Wrong

```typescript
import { generateStream } from "../gemini/client";
```

#### Correct

```typescript
import type { CompletionProvider } from "./ports";

export function streamCompletionText(provider: CompletionProvider, input: CompletionTextInput) {
  return provider.streamText(input);
}
```

## Scenario: Request-Local Attachment Pipeline

### 1. Scope / Trigger

Use this contract when changing OpenAI/Google file or image input handling, request-local attachment upload, Gemini upload transport, file-reference ordering, or large-context text attachment integration.

### 2. Signatures

- `src/attachments/types.ts` owns `AttachmentPlan`, `AttachmentCandidate`, `AttachmentDrop`, and `AttachmentUploadResult`.
- `src/attachments/plan.ts` owns `createAttachmentPlan({ images, files, existingFileRefs, maxFiles })`, `mergeAttachmentPlans(...)`, candidate ordering, max-count enforcement, and request-local candidate normalization.
- `src/attachments/refs.ts` owns existing file-reference extraction and consolidation, including OpenAI-compatible `file_id`, `ref_file_ids`, `file_ids`, and direct provider file-ref objects.
- `src/attachments/collect-openai.ts` owns OpenAI-compatible request walking for top-level inline upload candidates and returns an `AttachmentPlan` by composing `refs.ts` and `plan.ts`.
- `src/attachments/notes.ts` owns dropped-attachment records and deterministic prompt notes.
- `CompletionProvider.resolveAttachments(plan)` resolves request-local candidates to provider file refs and prompt notes.
- `CompletionProvider.uploadTextFile(text, filename)` uploads required large-context text files.

### 3. Contracts

- `src/attachments/**` is provider-neutral and may depend on `src/shared/**`, but must not import `src/gemini/**`, HTTP adapters, or completion modules.
- Implementation modules import Base64 helpers from `src/attachments/base64.ts`, MIME/filename helpers from `src/attachments/mime.ts`, and upload-input normalization from `src/attachments/input.ts`. `src/attachments/media.ts` is a compatibility facade only.
- `src/completion/**` must call provider ports for upload and must not import Gemini upload modules.
- `src/gemini/uploads/**` owns Gemini Web upload protocol details. Preferred content-push upload is multipart and must not include Gemini cookie or SAPISID authorization headers.
- Request-local candidate dedupe is scoped to one request and keyed by MIME/content type, filename, and bytes.
- Large-context `message.txt` / `tools.txt` uploads use the upload transport but keep hard-failure semantics through `prepareContextFiles`.

### 4. Validation & Error Matrix

- Invalid base64/data URL request-local attachment -> continue as text-only with deterministic prompt note.
- Remote `http://` / `https://` URLs are not upload sources. Match `ds2api`: only inline base64/data URL payloads are materialized for request-local upload.
- Explicit file inputs that provide only a remote URL and no existing file reference -> continue as text-only with deterministic invalid-file prompt note; do not fetch the URL.
- Preferred multipart upload rejection, invalid multipart file refs, ambiguous exceptions without a status, network-like failures, aborts, and local validation failures -> do not auth fallback; request-local attachments degrade with a deterministic prompt note and required context-file uploads fail.
- Resumable upload is not part of the current upload fallback path; do not reintroduce cookie-backed auth fallback without a spec update and explicit user-facing security review.
- Required large-context text upload failure -> return `large_context_file_upload_failed`; do not fall back to oversized inline context.

### 5. Good/Base/Bad Cases

- Good: prompt conversion emits markers, attachment planning owns candidates/refs, completion calls `resolveAttachments(plan)`, and Gemini adapter executes the plan.
- Bad: `src/completion/context.ts` imports `src/gemini/uploads`.
- Bad: implementation modules import attachment helpers through the broad `src/attachments/media.ts` compatibility facade instead of the concrete owner.
- Bad: adding a second resolver path for images or files outside `AttachmentPlan`.
- Bad: sending `Cookie` or `Authorization` to `https://content-push.googleapis.com/upload` on the preferred multipart path.

### 6. Tests Required

- Unit tests for attachment planning, max count, existing ref consolidation, dedupe, invalid base64, remote URL non-fetch behavior, multipart request construction, upload failure degradation, upload protocol telemetry, and final file-ref ordering.
- HTTP/context tests should assert provider handoff through `resolveAttachments(plan)`, not `resolveImages` / `resolveFiles`.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const imageRefs = await provider.resolveImages(images);
const fileRefs = await provider.resolveFiles(files);
```

#### Correct

```typescript
const attachmentResult = await provider.resolveAttachments(attachmentPlan);
const fileRefs = mergeFileRefs(
  contextFileRefs,
  attachmentPlan.existingFileRefs,
  attachmentResult.genericFileRefs,
  attachmentResult.imageFileRefs,
);
```

## Architecture Guard

`scripts/check-architecture.mjs` is the source of truth for import boundaries. It checks forbidden imports plus authored `.ts` / `.tsx` file and top-level owner cycles. Top-level owners are discovered from `src/` instead of maintained as a hard-coded allowlist; generated sources are excluded from the owner graph. Run `pnpm check:arch` after moving modules or changing imports.

Current enforced rules include:

- `src/shared/**` must not import feature layers such as `gemini`, `http`, `promptcompat`, `toolcall`, or `toolstream`.
- `src/attachments/**` may depend on its own modules and provider-neutral `src/shared/**` helpers, but must not depend on completion, Gemini, HTTP, prompt compatibility, model, config, tool-call, or tool-stream owners.
- `src/admin-ui/**` may depend on its own modules and external browser packages, but must not import backend source owners through parent-relative paths.
- `src/completion/**` must not import `src/gemini/**`; use `src/completion/ports.ts` plus `src/gemini/completion-provider.ts`.
- `src/gemini/**` may import completion port types only through the provider adapter path.
- HTTP adapters must not call `gemini/client` directly.
- `promptcompat` and `completion` must not depend on HTTP adapters.
- `promptcompat` internals must not depend on `completion`; only the compatibility barrel may re-export legacy completion context helpers.
- OpenAI and Google HTTP adapters must not import each other.
- `toolcall` must not depend on prompt compatibility, HTTP adapters, stream state, or Gemini uploads.
- HTTP adapter barrels should not re-export lower-layer completion, prompt compatibility, tool-call, or Gemini client internals. Export protocol handlers/formatters from HTTP packages and import lower-layer owner modules directly when needed.
- Implementation modules under `src/completion/`, `src/promptcompat/`, `src/toolstream/`, and `src/http/` should not import bare `src/toolcall` / `src/toolcall/index`; use the specific tool-call owner module that owns the contract being consumed.
- Directory-level source dependency cycles are also rejected; compatibility-only barrels are excluded where explicitly documented.
- Architecture-script tests must execute the real checker against temporary fixture roots and include TSX rejection plus dynamically discovered owner-cycle cases.

### Design Decision: Owner-Module Toolcall Imports

**Context**: `src/toolcall/index.ts` re-exports parsing, policy, formatting, schema normalization, metadata extraction, and prompt helpers. Using it from implementation modules hides which tool-call subdomain a caller actually depends on and makes future refactors harder to review.

**Decision**: Keep the barrel for public/test compatibility surfaces, but require implementation modules to import the concrete owner module. The architecture guard enforces this with exact bare-barrel import checks, while still allowing imports such as `../toolcall/openai-format`.

**Example**:

```typescript
// Good
import { validateRequiredToolCalls } from "../toolcall/policy-openai";
import type { OpenAIToolCall } from "../toolcall/openai-format";

// Bad
import { validateRequiredToolCalls, type OpenAIToolCall } from "../toolcall";
```

## Generated Files

Do not hand-edit `dist/worker.js`; it is generated from `src/index.ts` by `scripts/build.mjs`. The root `worker.js` is a legacy shim.

## Scenario: Gemini Upstream Transport Facade

### 1. Scope / Trigger

Use this contract when changing `src/gemini/transport/http.ts`, `src/gemini/transport/socket.ts`, socket pooling, timeout handling, chunked/fixed response body parsing, decompression, abort cleanup, or any future socket transport submodule. The Worker uses this layer to avoid Cloudflare `fetch` egress limits while preserving Gemini Web request semantics.

### 2. Signatures

- `httpFetch(url, options)` is the unified upstream entry for Gemini client and upload code. It returns a `Response` or `SocketHttpResponse`-compatible object with `status`, `ok`, `headers`, `body`, and `text()`.
- `resolveConnect()` lazily resolves `cloudflare:sockets` and returns `SocketConnect | null`.
- `socketHttp(connect, url, options)` performs one HTTP/1.1 request over a socket and returns `SocketHttpResponse`.
- `createSocketPool()`, `getDefaultSocketPool()`, and `closeIdleSocketPool(pool?)` own keep-alive pool lifecycle.
- `_setConnectForTest(connect)` resets socket state for unit tests and must remain local-test only through `src/test-exports.ts`.

### 3. Contracts

- `httpFetch` may fall back from socket to `fetch` only when `canFallbackAfterSocketError(method, error)` allows it. Fallback must preserve method, headers, body, timeout, abort signal, Gemini cookie/auth headers, model payload, and file references.
- Abort errors and already-aborted signals must not be converted into socket fallback attempts.
- `socketHttp` must support:
  - HTTP/1.1 status/header parsing with bounded header bytes.
  - `Transfer-Encoding: chunked`.
  - valid `Content-Length`.
  - connection-close-delimited bodies.
  - HEAD, 204, 304, and 1xx no-body behavior.
  - optional gzip decompression when `DecompressionStream` supports it.
  - keep-alive reuse only when the response framing makes reuse safe.
- Timeout and abort cleanup must close the socket and release stream locks where applicable.
- `socket.ts` is the compatibility facade. Splitting implementation into `byte-queue.ts`, `pool.ts`, `timeout.ts`, `http-parse.ts`, `body-stream.ts`, or `decompression.ts` must not require callers to change imports outside `src/gemini/transport/` and `src/test-exports.ts`.
- New socket submodules must stay inside `src/gemini/transport/` and must not import HTTP adapters, completion modules, prompt compatibility, tool-call modules, or uploads unless a spec update first defines a new boundary.

### 4. Validation & Error Matrix

- `cloudflare:sockets` unavailable -> `httpFetch` uses `fetch`.
- Socket connect/write/read fails before an upstream response and fallback is allowed -> log safe fallback metadata and retry through `fetch`.
- Socket fails after an upstream response or when fallback is disallowed -> propagate the socket error.
- Client abort or timeout -> close socket, abort promptly, and do not fall back to `fetch`.
- Header bytes exceed `MAX_SOCKET_HEADER_BYTES` -> fail before body streaming and close socket.
- Invalid `Content-Length` or invalid chunk size -> fail the socket response and close socket.
- Chunked response reaches terminating zero chunk and trailers end -> close or pool the socket according to keep-alive eligibility.
- Gzip response with supported decompression -> remove `content-encoding` and `content-length` from response headers and expose decoded body bytes.

### 5. Good/Base/Bad Cases

- Good: keep `socket.ts` as a facade while moving byte queue, timeout, pool, and parser internals to owner modules with focused tests.
- Good: preserve existing error messages and cleanup order when extracting helper modules.
- Base: `gemini/client` and `gemini/uploads` call `httpFetch`; they do not call `socketHttp` directly.
- Bad: add socket fallback in `gemini/client` retry code, which duplicates transport policy and risks changing request semantics.
- Bad: reuse a socket for a connection-close response with no content length or chunked framing.
- Bad: expose new transport helper imports from HTTP adapters or completion modules.

### 6. Tests Required

- Run `pnpm typecheck` after changing transport signatures or extracted module exports.
- Run `pnpm check:arch` after adding transport modules or moving imports.
- Run `pnpm unit` after changing socket parsing, timeout, abort, keep-alive, fallback, or decompression behavior.
- Run `pnpm smoke` after changing public/test exports or build entrypoints.
- Socket unit coverage should include chunked body, fixed content-length body, connection-close body, invalid headers/chunks, timeout, abort cleanup, keep-alive pool reuse/close, gzip path, and socket-to-fetch fallback.

### 7. Wrong vs Correct

#### Wrong

```typescript
// src/gemini/client/index.ts
try {
  return await socketHttp(connect, url, options);
} catch (_) {
  return fetch(url, init);
}
```

#### Correct

```typescript
// src/gemini/client/index.ts
return httpFetch(url, {
  method: "POST",
  headers,
  body,
  timeoutMs,
  socket: cfg.upstream_socket,
  signal,
  cfg,
});
```

#### Wrong

```typescript
// src/http/openai/chat.ts
import { socketHttp } from "../../gemini/transport/socket";
```

#### Correct

```typescript
// HTTP adapters stay protocol-boundary only.
import { streamPlainCompletionEvents } from "../../completion";
```

## Scenario: Production And Test Bundles

### 1. Scope / Trigger

Use this contract when changing build outputs, public exports, smoke tests, or local unit tests. Production deployments must not expose local-only test helpers.

### 2. Signatures

- `src/index.ts` is the production Worker entrypoint and exports only stable public helpers from `src/public-exports.ts`.
- `src/test-index.ts` is the local test entrypoint and may re-export `src/test-exports.ts`.
- `scripts/build.mjs` emits:
  - `dist/worker.js` from `src/index.ts`
  - `dist/worker.test.js` from `src/test-index.ts`
- `pnpm check:size` builds `dist/worker.js` and gates its level-9 gzip size
  through `scripts/check-bundle-size.mjs`; the default gzip ceiling is 3 MiB and
  `BUNDLE_GZIP_SIZE_LIMIT_BYTES` may override it.
- `wrangler.jsonc` deploys `dist/worker.js`.
- `tests/unit/*.test.mjs` are Vitest-discovered wrapper files; unit modules import `dist/worker.test.js` by default.
- `tests/unit/*.cases.mjs` own reusable case lists imported by the Vitest wrapper files.
- `tests/unit/assertions.js` provides Vitest-backed assertion helpers for shared case modules.

### 3. Contracts

- Internal helpers such as `buildPayload`, route handlers, stream adapters, and socket helpers belong in `src/test-exports.ts` when local tests need them.
- Do not add `export * from "./test-exports"` to `src/index.ts`.
- Smoke tests should import the production bundle for public exports and health checks.
- Smoke tests may import the test bundle for internal compatibility checks, but must also assert that representative internal helpers are absent from the production bundle.
- Bundle-size output reports raw bytes, gzip bytes, the configured gzip ceiling,
  and remaining headroom. Raw bundle bytes are observational and are not the
  release gate.

### 4. Validation & Error Matrix

- `dist/worker.js` exports `buildPayload` -> fail smoke; test helpers leaked into production.
- `dist/worker.test.js` misses a helper required by `tests/unit/*` -> fail unit tests.
- `wrangler.jsonc` points to `dist/worker.test.js` -> invalid deployment config.
- `scripts/build.mjs` only emits one bundle -> unit or smoke should fail before deploy.
- Missing/empty production bundle -> `pnpm check:size` fails.
- Level-9 gzip bytes exceed `BUNDLE_GZIP_SIZE_LIMIT_BYTES` (or the 3 MiB
  default) -> `pnpm check:size` fails even when raw size is otherwise readable.

### 5. Good/Base/Bad Cases

- Good: add a local-only helper export to `src/test-exports.ts` and use it from focused `tests/unit/*.test.mjs` files.
- Base: add a stable user-facing helper to `src/public-exports.ts` only when it is intentionally part of the package surface.
- Bad: import `src/test-exports.ts` from `src/index.ts` to make a unit test pass.
- Bad: make smoke validate only `dist/worker.test.js`; that misses production export leaks and route wiring regressions.
- Bad: gate raw bundle bytes with the legacy `BUNDLE_SIZE_LIMIT_BYTES`; release
  size is the compressed artifact budget.

### 6. Tests Required

- Run `pnpm build` after changing build entrypoints.
- Run `pnpm unit` after changing `src/test-exports.ts`, `src/test-index.ts`, or `tests/unit/*`.
- Run `pnpm smoke` after changing `src/index.ts`, `src/public-exports.ts`, `scripts/build.mjs`, or `scripts/smoke.mjs`.
- Run `pnpm check:arch` after adding imports between source layers.
- Run `pnpm check:size` after changing build inputs or runtime dependencies.

### 7. Wrong vs Correct

#### Wrong

```typescript
// src/index.ts
export * from "./test-exports";
```

#### Correct

```typescript
// src/test-index.ts
import worker from "./index";

export default worker;
export * from "./public-exports";
export * from "./test-exports";
```

## Scenario: Coverage Build And Reports

### 1. Scope / Trigger

Use this contract when changing test coverage commands, build sourcemap behavior, CI quality gates, or the local unit runner. Coverage must report authored `src/**/*.ts` locations where possible while preserving normal production/test build output.

### 2. Signatures

- `pnpm unit` runs `pnpm build` and then executes unit tests through Vitest.
- `pnpm coverage` runs `COVERAGE=1 pnpm build` and then `TEST_BUNDLE=../../dist-coverage/worker.test.js vitest run --coverage`.
- `pnpm coverage:ci` uses the same Vitest V8 coverage execution path, then runs `node scripts/check-coverage.mjs`.
- `scripts/build.mjs` reads `process.env.COVERAGE`; truthy values are `1`, `true`, `yes`, and `on`.
- Coverage builds default to `dist-coverage/`; normal builds default to `dist/`.
- `vitest.config.mjs` owns the V8 coverage provider, report formats, and
  include/exclude paths; percentage thresholds belong to
  `scripts/check-coverage.mjs`.
- `scripts/check-coverage.mjs` owns aggregate source thresholds plus directory-
  and file-level source gates using `coverage/coverage-summary.json`.

### 3. Contracts

- Normal `pnpm build` must not emit sourcemaps and should remove stale `dist/worker.js.map` / `dist/worker.test.js.map`.
- Coverage builds emit linked sourcemaps with `sourcesContent` into `dist-coverage/` so Vitest V8 coverage can remap `dist-coverage/worker.test.js` coverage back to `src/`.
- Coverage includes the isolated test bundle entry (`dist-coverage/worker.test.js`) because unit tests import the bundle rather than raw TypeScript.
- Unit helpers read `process.env.TEST_BUNDLE` when set and default to `../../dist/worker.test.js` for the normal workflow.
- Vitest V8 coverage is the collector and remapper; it does not own regression
  thresholds. `scripts/check-coverage.mjs` aggregates only remapped `src/`
  entries, excluding bundled third-party rows, and applies source-wide,
  directory, and file gates.
- Coverage thresholds are regression floors, not aspirational 100% targets. No directory or aggregate threshold should be 100%; stable areas should normally retain 3–5 percentage points of measured headroom so one defensive branch does not block unrelated work.
- Global thresholds must remain representative of the repository baseline, and newer high-risk owners such as `src/admin-ui`, `src/attachments`, `src/gemini/accounts`, and `src/http/admin` require explicit line and branch gates instead of relying only on broad parent-directory aggregation. Browser UI coverage is sourced from browser-independent logic exported through the test bundle; generated embedded HTML is validated separately by route/smoke assertions.
- Generated coverage output belongs under `coverage/` and coverage build output belongs under `dist-coverage/`; both must stay git-ignored.
- Do not change `src/index.ts`, `src/public-exports.ts`, or `wrangler.jsonc` to make coverage work.

### 4. Validation & Error Matrix

- `pnpm coverage` reports test wrappers or generated bundle paths only -> Vitest coverage include/exclude paths or sourcemap output are wrong; fix `vitest.config.mjs` and the coverage build sourcemaps.
- `pnpm coverage:ci` reports zero files -> coverage filtering is invalid; do not rely on a passing exit code until the report includes `src/` rows.
- Normal `pnpm build` leaves sourcemaps after a prior coverage run -> clean stale map files in the non-coverage build path.
- `pnpm coverage:ci` collects a report but `scripts/check-coverage.mjs` fails ->
  an aggregate source, protected directory, or protected file gate regressed;
  add focused tests or intentionally ratchet the gate with evidence.
- A zero-coverage `node_modules` row changes aggregate source percentages -> the
  gate is aggregating third-party coverage incorrectly; restrict source gates
  to normalized `src/` paths.
- A new authored source owner has no explicit gate -> add one when the owner handles external input, credentials, persistence, protocol adaptation, or other high-risk behavior; use the measured baseline with maintenance headroom.
- Coverage commands import `dist/worker.test.js` instead of `dist-coverage/worker.test.js` -> normal builds can overwrite coverage sourcemaps and produce stale or misleading reports.
- Production bundle exports test helpers -> smoke must fail; restore the production/test entrypoint split.

### 5. Good/Base/Bad Cases

- Good: add a coverage-only build flag that writes to `dist-coverage/` and preserves normal build output.
- Good: use a 92% line floor for a directory measured near 95% instead of a brittle 100% floor.
- Base: use Vitest V8 coverage over `dist-coverage/worker.test.js` with `json-summary` output and directory gates.
- Bad: change Vitest coverage include/exclude paths without verifying the report still contains covered `src/` files.
- Bad: enable sourcemaps unconditionally for deploy builds.
- Bad: share `dist/worker.test.js` between normal unit tests and coverage runs.
- Bad: use `exclude-after-remap` without verifying the report still contains covered `src/` files.
- Bad: lower a gate only until the current command turns green without recording the measured baseline and risk-specific rationale.

### 6. Tests Required

- Run `pnpm coverage` after changing Vitest coverage config, build sourcemaps, or the unit runner.
- Run `pnpm coverage:ci` after changing aggregate, directory, or file thresholds.
- Architecture/coverage script fixture summaries must include every required target so missing-data failures remain tested.
- Run `pnpm unit` to confirm the non-coverage test workflow still passes.
- Run `pnpm smoke` after changing `scripts/build.mjs` because production/test bundle separation is part of smoke coverage.

### 7. Wrong vs Correct

#### Wrong

```json
{
  "scripts": {
    "coverage": "vitest run --coverage"
  }
}
```

This can import the normal test bundle and miss the isolated coverage sourcemaps.

```javascript
const lineGates = [["src/http/stream", 100]];
```

This makes a single uncovered defensive line fail unrelated development.

#### Correct

```json
{
  "scripts": {
    "coverage": "COVERAGE=1 pnpm build && TEST_BUNDLE=../../dist-coverage/worker.test.js vitest run --coverage"
  }
}
```

```javascript
const lineGates = [["src/http/stream", 94]];
```

This remains a meaningful regression floor for a directory measured near 98% while preserving maintenance headroom.

## Scenario: Tool Syntax Probing And Stream Sieve CPU

### 1. Scope / Trigger

Use this contract when changing non-streaming tool-call parsing, streamed tool-call sieve behavior, or prompt text that may contain DSML/XML-looking content. The Worker must avoid spending most of the 10ms CPU budget on false-positive tool parsing for ordinary prose.

### 2. Signatures

- `src/toolcall/syntax-probe.ts` owns high-confidence syntax detection helpers:
  - `hasToolCallSyntaxCandidate(text)`
  - `hasToolCallMarkupSyntaxCandidate(text)`
  - `findToolCallSyntaxCandidateStart(text)`
  - `isPartialToolCallSyntaxPrefix(text)`
  - `hasClosedToolCallsSyntax(text)`
  - `toolCallSieveSafeTailLength(text)`
- `src/toolcall/dsml.ts` preserves legacy helper exports such as `mayContainToolCallSyntax`, `findToolSieveCandidateStart`, and `normalizeToolMarkupConfusables` by delegating to the syntax-probe owner.
- `src/toolstream/index.ts` consumes syntax-probe helpers through `src/toolcall` and owns only stream buffer state transitions.

### 3. Contracts

- A text is a markup tool-call candidate only when it contains a tag-shaped accepted tool prefix such as `<tool_calls`, `<|DSML|tool_calls`, `<invoke`, `<parameter`, accepted fullwidth/confusable equivalents, or accepted prefixed legacy forms. Legacy fenced markers such as ```tool_call are plain text and must not trigger tool-call parsing.
- Ordinary prose such as `a < b and parameterless text` must not enter full DSML/XML parsing just because it contains `<` and a tool-like substring.
- Streamed tool-call sieve may hold true partial prefixes across chunks, for example `<|DS`, but must release the buffer once later text proves the prefix is not a valid partial tool tag.
- DSML parser compatibility remains permissive after the probe admits a candidate: accepted XML tag aliases, confusable delimiters, DSML aliases, protected Markdown handling, and schema normalization must continue in the parser/formatter modules.
- Prompt/history formatters must emit the DSML-prefixed form (`<|DSML|tool_calls>`, `<|DSML|invoke>`, `<|DSML|parameter>`) rather than generating legacy `<tool_calls>` tags. Parsers may continue accepting legacy tags as input compatibility.
- Legacy fenced tool-call blocks must remain visible as plain text instead of being stripped from the model output or producing a tool call.

### 4. Validation & Error Matrix

- Long ordinary prose with `<` plus `parameterless` -> clean text, no tool calls, no full parse hot path.
- Split partial prefix `<|DS` followed by `ML|tool_calls...` -> held and parsed as a tool candidate.
- Split partial prefix `<|DS` followed by plain prose -> released as text.
- Valid DSML or legacy fenced tool calls -> parsed and formatted as OpenAI/Google tool calls.
- Malformed legacy fenced `tool_call` / `function_call` blocks -> no tool call, original block remains in clean text.

### 5. Good/Base/Bad Cases

- Good: add a new accepted tag spelling in `syntax-probe.ts`, then test both non-streaming parse and streamed sieve behavior.
- Base: `parseToolCalls` asks the probe before entering `parseDSMLToolCallsDetailed`.
- Base: legacy `<tool_calls>` is accepted by parsers and stream sieve tests, but generated history/prompt text uses DSML tags.
- Bad: broad checks such as `text.includes("<") && /parameter/.test(text)` because long ordinary prose can burn several milliseconds before returning no tool calls.
- Bad: generated prompt/history text uses legacy `<tool_calls>` tags for new assistant tool-call blocks.
- Bad: malformed legacy fenced blocks are removed from clean text when no valid tool call was produced.
- Bad: `toolstream` retaining everything after any `<` until a large maximum-candidate threshold.

### 6. Tests Required

- Unit test that long false-positive prose returns no tool calls and stays below the previous local hot-path baseline.
- Unit test for valid DSML, accepted fullwidth/confusable DSML, and legacy fenced tool calls.
- Unit test for streamed ordinary `<` prose release.
- Unit test for split partial prefixes that should remain buffered until resolved.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (text.includes("<") && /tool_calls|invoke|parameter/.test(text)) {
  return parseDSMLToolCallsDetailed(text);
}
```

#### Correct

```typescript
if (!hasToolCallSyntaxCandidate(text)) return [String(text || "").trim(), []];
return parseDSMLToolCallsDetailed(text);
```

## Scenario: Tool Calling Metadata Normalization

### 1. Scope / Trigger

Use this contract when changing OpenAI Chat, OpenAI Responses, or Google-compatible tool calling behavior. Tool definitions arrive in several protocol shapes and must be normalized before prompt construction, schema-based argument normalization, filtering, or policy validation diverge.

### 2. Signatures

- `src/toolcall/tool-meta.ts` owns shared extraction helpers such as `extractToolMeta`, `toolDefsFromTools`, and protocol conversion helpers.
- `src/toolcall/tool-bundle.ts` owns request-scoped reuse through `createToolBundle(toolsRaw)` and `filterToolBundleByPolicy(bundle, policy)`.
- Prompt builders receive compact tool definitions shaped as `{ name, description, parameters }`.
- Google-compatible filtering may return normalized OpenAI-style function tools for downstream prompt/schema parsing.

### 3. Contracts

- Accept OpenAI function tools: `{ type: "function", function: { name, description, parameters } }`.
- Accept Responses flattened tools: `{ type: "function", name, description, parameters }`.
- Accept schema aliases at top level or under `function`: `parameters`, `input_schema`, `inputSchema`, and `schema`.
- Accept Google declarations from `tools[].functionDeclarations` and `tools[].function_declarations`.
- Do not make endpoint-local prompt builders reinterpret only one protocol's tool shape.
- For hot paths, build one `ToolBundle` per request and pass it through policy, filtering, prompt definition, and schema-normalization code instead of repeatedly calling `toolItemsFromTools`, `extractToolNames`, `openAIToolDefs`, or `buildToolSchemaIndex`.

### 4. Validation & Error Matrix

- Google `functionCallingConfig.mode=ANY` with no normalized tool names -> `invalid_tool_choice`.
- Google `allowedFunctionNames` containing no declared normalized name -> `invalid_tool_choice`.
- OpenAI `tool_choice=required` with no normalized tool names -> OpenAI tool choice validation error.
- Parsed tool calls with available schemas -> normalize argument values through the shared schema index.

### 5. Good/Base/Bad Cases

- Good: add a new schema alias by updating `tool-meta.ts` and reusing it from prompt and schema-normalization code.
- Base: endpoint handlers pass raw request tools into the lower layer and let `toolcall` normalize them once into a `ToolBundle`.
- Bad: Google prompt code loops only over `functionDeclarations`, while validation accepts OpenAI-style tools; this validates a request and then builds a prompt with no tools.
- Bad: OpenAI Responses normalizes tools in the HTTP adapter, then completion code builds a second schema/name index for the same request.

### 6. Tests Required

- Unit test that Responses/OpenAI tools using `input_schema`, `inputSchema`, and `schema` appear in prompt definitions.
- Unit test that schema aliases are used by parsed tool-call argument normalization.
- Unit test that Google-compatible OpenAI-style, flattened, and `functionDeclarations` tools all appear in generated prompts.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
for (const fn of googleFunctionDeclarations(group)) {
  toolDefs.push({ name: fn.name, parameters: fn.parameters || {} });
}
```

#### Correct

```typescript
const toolDefs = toolDefsFromTools(req.tools);
```

#### Correct For Request Hot Paths

```typescript
const bundle = createToolBundle(req.tools);
const policy = parseOpenAIToolChoicePolicy(req.tool_choice, bundle);
const filtered = filterToolBundleByPolicy(bundle, policy);
const toolDefs = filtered.defs.length ? filtered.defs : bundle.defs;
```

## Scenario: Structured Output JSON Validation

### 1. Scope / Trigger

Use this contract when changing `src/toolcall/structured.ts`, OpenAI `response_format`, Responses `text.format`, or any final-output JSON Schema validation path.

### 2. Signatures

- `buildStructuredOutputRequirement(responseFormat)` returns a structured-output requirement or validation error.
- `finalizeStructuredOutputText(text, requirement)` parses, canonicalizes, and validates the final model text.
- `validateStructuredOutputValue(value, requirement)` validates parsed JSON values.
- `jsonValuesEqual(a, b)` compares JSON values structurally.

### 3. Contracts

- `json_object` requires a parsed JSON object.
- `json_schema` validates the supported JSON Schema subset after full model output is available.
- Schema `const` and `enum` must compare JSON values structurally, not by `JSON.stringify` output.
- `uniqueItems` must treat objects with identical keys and values as duplicates even when insertion order differs.
- Final successful structured output is canonicalized with `JSON.stringify(parsed)` after validation.

### 4. Validation & Error Matrix

- Output is not parseable JSON -> `structured output was not valid JSON`.
- `json_object` output is array/null/primitive -> `structured output must be a JSON object`.
- `enum` object has same keys/values in different order -> accept.
- `const` object has same keys/values in different order -> accept.
- `uniqueItems` array contains structurally equal objects with different key order -> reject with `must contain unique items`.

### 5. Good/Base/Bad Cases

- Good: recursive JSON equality compares arrays by ordered elements and objects by key membership plus child equality.
- Base: O(n^2) `uniqueItems` comparison is acceptable for final model output validation.
- Bad: `JSON.stringify(a) === JSON.stringify(b)` because object insertion order changes validation semantics.

### 6. Tests Required

- Unit test for object `const` equality with different key order.
- Unit test for object `enum` equality with different key order.
- Unit test for `uniqueItems` duplicate detection with different key order.
- Existing structured output finalization tests should still pass.

### 7. Wrong vs Correct

#### Wrong

```typescript
JSON.stringify(schemaValue) === JSON.stringify(outputValue)
```

#### Correct

```typescript
jsonValuesEqual(schemaValue, outputValue)
```

## Scenario: OpenAI Responses Input Normalization

### 1. Scope / Trigger

Use this contract when changing `src/promptcompat/responses-input.ts` or any OpenAI Responses route behavior that converts `req.input` into chat-style messages.

### 2. Signatures

- `normalizeResponsesInputAsMessages(req)` returns an array of chat-style messages or `[]`.
- `normalizeResponsesInputValueAsMessages(input)` accepts string, array, and recognized object-shaped Responses input values.
- `normalizeResponsesInputItem(item, callNameByID)` converts one recognized Responses item into one chat-style message or returns `null`.

### 3. Contracts

- String `input` remains a user message.
- Recognized message shapes with `role` or `type: "message" | "input_message"` remain supported.
- Recognized item types remain supported: `function_call_output`, `tool_result`, `function_call`, `tool_call`, `reasoning`, `thinking`, `input_text`, `text`, `output_text`, and `summary_text`.
- Unknown object items must be ignored. Do not serialize unknown objects into prompt text with `JSON.stringify`, and do not treat bare `text` or `content` fields on unknown item types as user text.
- Known message content parts are still converted later by prompt/content helpers; this rule only forbids unknown top-level Responses input item fallback injection.

### 4. Validation & Error Matrix

- `input: [{ type: "input_text", text: "x" }]` -> user message containing `x`.
- `input: [{ type: "custom_event", text: "secret" }]` -> no message for that item.
- `input: [{ custom: "secret" }]` -> no message for that item.
- `input: [{ role: "user", content: "x" }]` -> user message containing `x`.

### 5. Good/Base/Bad Cases

- Good: add support for a new Responses item by naming its `type` explicitly in `normalizeResponsesInputItem`.
- Base: unknown future Responses metadata is ignored until the project intentionally supports it.
- Bad: fallback to `JSON.stringify(item)` for unrecognized items, which leaks opaque metadata into the model prompt.

### 6. Tests Required

- Unit test `normalizeResponsesInputAsMessages` for known `input_text` plus unknown object omission.
- Unit or route-level test that `handleResponses` prompt text includes known text and excludes unknown object `text`, nested `content`, and serialized metadata.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
try { return JSON.stringify(item); } catch (_) { return String(item); }
```

#### Correct

```typescript
const type = String(item.type || "").trim().toLowerCase();
if (type === "input_text" && typeof item.text === "string") return { role: "user", content: item.text };
return null;
```
