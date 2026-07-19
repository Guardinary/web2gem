# Directory Structure

## Source Layout

- The root `package.json` / `src/` tree is the default `web2gem` package. The Cloudflare Worker build and architecture guard are scoped to this root package unless a task explicitly expands the scope.
- `src/app.ts` is the application composition root. It owns the declarative `APP_ROUTES` table (route matching, admin-exempt vs public ordering, per-route JSON body policy and error envelope, session requirements), CORS wrapping, the public auth gate, provider composition, and top-level error conversion using Web-standard `Request` / `Response` types. Adding a route means adding one table entry, not a new dispatch branch.
- `src/index.ts` is the thin Cloudflare Worker entrypoint. It delegates `fetch` to `handleApplicationRequest` and exports only stable public helpers; protocol route branches must not be added there.
- `src/worker-entry.ts` is the default-only production bundle entry used by Wrangler and Docker. Keep diagnostic/public helper exports in `src/index.ts` / `src/harness-exports.ts`; raw workerd entry bundles must not expose non-handler named exports.
- `src/http/` owns HTTP boundary concerns. Generic, protocol- and completion-neutral helpers live under `http/core/` (enforced by check:arch), stream framing helpers under `http/stream/`, protocol adapters under `http/openai/` and `http/google/`, and business-aware shared modules at the `src/http/` root: `route-body.ts` (completion-aware JSON body policy) and `generation.ts` (shared prepare/generate orchestration, stage logging, and the `GenerationProtocol` strategy consumed by both adapters).
- `src/http/openai/images.ts` owns OpenAI image route orchestration and generation response flow. JSON and multipart image-edit input normalization, upload-size enforcement, and image-part coercion belong in `src/http/openai/images-input.ts`; keep provider calls and response formatting out of that input owner.
- HTTP protocol adapters import `http/core/*`, `http/stream/*`, and `src/http/*` owner modules directly. There is no `src/http/index.ts` barrel; `src/app.ts` also imports owner modules directly. New generation endpoints run through `runPreparedCompletion`/`generateTextLogged`/`generateRichLogged` with their protocol's `*_GENERATION_PROTOCOL` constant instead of hand-rolling prepare/generate/log/error pipelines.
- `src/completion/` owns provider-neutral completion contracts and shared business behavior: prompt/context preparation, provider text-generation ports, empty-output handling, stream/tool-sieve event generation, one `CompletionStreamLifecycle` reducer plus terminal outcome classifier, and completion turn finalization. Protocol adapters must not mirror reducer-owned issue/empty/tool-call/policy/count state, and callback-style stream consumption APIs are not part of the contract.
- `src/promptcompat/` owns the typed `InternalMessage` boundary. `message-model.ts` owns canonical parts, the single raw content-part parser, and explicit prompt/history/latest-input/reasoning projections; `responses-input.ts` parses Responses items directly into that model; `attachment-inputs.ts` projects parsed messages plus request-level attachment channels into `AttachmentPlan`. HTTP adapters parse OpenAI Responses, OpenAI chat, and Google wire shapes once; prompt, history, attachment, and image-generation consumers receive the parsed model instead of re-walking raw content parts.
- `src/toolcall/` owns tool-call prompt formatting, parsing, policy validation, schema normalization, and streamed sieve state. Import concrete owners such as `toolcall/sieve`, `toolcall/tool-bundle`, `toolcall/policy-openai`, `toolcall/policy-google`, `toolcall/dsml`, or `toolcall/openai-format`; there is no broad compatibility barrel.
- `src/gemini/` owns Gemini Web protocol details, transport, and upload behavior. `gemini/client/index.ts` stays an orchestration layer; `client/same-account-attempt.ts` owns request-local active config, build-label/cookie recovery, retry classification, and the stream output-started gate; `client/stream-consumer.ts` owns WRB reader pulls, streaming UTF-8 decode, line buffering, fatal-first parsing, and bounded diagnostics. Model headers live in `client/model-headers.ts`, WRB envelopes/parts/images/cumulative delta extraction live in concrete `client/parse-*.ts` owners, and no catch-all parser barrel exists.
- `src/gemini/client/generated-images.ts` owns generated-image URL candidates, browser/cookie download headers, byte hydration, supported output-format mapping, and URL fallback. It must reuse MIME detection from `src/attachments/mime.ts` and encoding from `src/attachments/base64.ts`.
- `src/gemini/accounts/admin-input.ts` owns admin request normalization and validation. `admin.ts` owns account-admin use-case orchestration and depends on capability-specific admin/runtime store contracts.
- `src/gemini/accounts/domain.ts` is the single owner for account issue/state
  vocabularies, guards, derived-state rules, and the shared
  default/minimum/maximum account page limit. Admin input, runtime
  classification, and D1 summary projection must reuse this owner instead of
  maintaining parallel status arrays or limit clamps.
- `src/gemini/accounts/routes.ts` owns capacity-aware route tuples, keys, parsing, capability projection, catalog projection, and priority reconciliation. `pool.ts` is the account facade; lease lifecycle, pure selection, catalog projection, and snapshot transitions live in focused `lease.ts` / `pool-*.ts` siblings.
- `src/gemini/accounts/store-d1.ts` is the admin repository facade. Account-runtime/capability/route persistence lives in `store-d1-runtime.ts`, positional account insert SQL and row values live in `store-d1-codec.ts`, and admin projections live in `store-d1-admin.ts`; preserve SQL text and bind ordering across these owners.
- `src/gemini/transport/http.ts` owns the unified upstream HTTP entry. It may choose `cloudflare:sockets` first and fall back to `fetch` only when request semantics are preserved.
- `src/gemini/transport/socket.ts` is the public socket transport facade. If the socket implementation is decomposed, keep public exports compatible from this module and move internals into owner modules under `src/gemini/transport/`.
- `src/gemini/completion-provider.ts` is the thin Gemini adapter for `src/completion/ports.ts`. Cross-account acquisition/recovery/outcome ordering belongs in `completion-attempts.ts`; request-local upload recipes, aliases, replay, and opaque-reference detection belong in `upload-replay.ts`.
- `src/promptcompat/token-accounting.ts` owns prompt/completion token estimates, counters, and prepared-text accounting. `src/shared/text-metrics.ts` owns only provider-neutral UTF-8 byte, code-point, and continuation-overlap primitives.
- `src/shared/` must stay leaf-level and provider-neutral. Production code imports concrete owners such as `encoding.ts`, `logging.ts`, `abort.ts`, `errors.ts`, `crypto.ts`, `strings.ts`, `text-metrics.ts`, and `json-schema.ts`; broad `runtime.ts` / `tokens.ts` compatibility barrels do not exist. Generic string selection and JSON-Schema subset validation belong here, while completion-specific structured-output parsing belongs in `src/completion/structured-output.ts`. Gemini SAPISID hashing belongs to `src/gemini/auth.ts`.
- Media and attachment helpers live under `src/attachments/**`; do not add compatibility shims under `src/shared/`.

### Attachment owner dependency direction

`src/attachments/refs.ts` owns the recognized existing-file-reference vocabulary
(`file_id`, `fileId`, `file_ref`, `fileRef`, `ref`, and context-sensitive `id`).
Upload normalization may consume that owner, but `refs.ts` must not import the
upload-input owner. Shared filename metadata extraction belongs in a leaf helper
such as `src/attachments/metadata.ts` so reference collection and upload
normalization do not form a cycle.

Model-detail route matchers must catch `decodeURIComponent` failures and return a
non-match; malformed encoded IDs must reach the existing not-found response,
not the generic application 500 handler.
- `src/admin-ui/html.ts` is the authored compile-time HTML injection boundary; `build-admin-ui.mjs` returns HTML in memory and no generated source directory is tracked. `admin-ui/session.ts` owns browser session cancellation, stale-result guards, feedback, and confirmation lifecycle; `actions.ts` owns account/model/import/edit use cases.
- `server/docker-server.mjs` adapts Node HTTP requests to the Worker `fetch` entrypoint. It owns Node header/body/response-stream translation and propagates client disconnects into the Web `Request.signal`; `server/d1-http-binding.mjs` and `server/io.mjs` are its production runtime siblings. Development commands remain under `scripts/`.

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

- Good: add one `APP_ROUTES` entry in `src/app.ts` and cover its method/path/auth/body/account policy in route tests.
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
// server/docker-server.mjs
if (req.url === "/v1/models") return sendModels(res);
```

#### Correct

```typescript
// src/worker-entry.ts
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
- `streamPlainCompletionEvents` and `streamToolSieveCompletionEvents` convert provider deltas into explicit completion events. Google tool streaming reuses the shared sieved-text loop with its protocol-specific tail finalizer.

### 3. Contracts

- `src/app.ts` is the composition root: create the concrete Gemini provider there and pass it into HTTP handlers.
- HTTP handlers may depend on completion ports/events, but must not call `gemini/client` or `gemini/uploads`.
- Completion modules may depend on prompt compatibility, concrete tool-call owners, shared, config, and model types, but not `src/gemini/**`.
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
- Bad: a completion module imports `../gemini/client`, or HTTP stream code calls provider delta callbacks directly.

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
- `src/promptcompat/message-model.ts` owns `InternalMessage`, `MessagePart`, `parseOpenAIMessages(...)`, and the single `parseMessagePart(...)` raw content-part walker.
- `src/promptcompat/attachment-inputs.ts` owns `attachmentInputsFromMessages(...)`, `attachmentPlanFromMessages(...)`, `openAIAttachmentPlanFromRequest(...)`, and request-level `attachments`, `files`, `ref_file_ids`, `file_ids`, and Responses `input` reference-channel planning. Consumers import this concrete owner directly; `message-model.ts` does not re-export attachment planning.
- `src/attachments/refs.ts` owns recognized `file_id`, `fileId`, `file_ref`, `fileRef`, `ref`, and context-sensitive `id` extraction, naming, and dedupe keys. Raw message walking remains in `promptcompat`; completion may retain an opaque-object fallback after recognized-key lookup.
- `src/attachments/notes.ts` owns dropped-attachment records and deterministic prompt notes.
- `CompletionProvider.resolveAttachments(plan)` resolves request-local candidates to provider file refs and prompt notes.
- `CompletionProvider.uploadTextFile(text, filename)` uploads required large-context text files.
- `src/gemini/uploads/execute.ts` orchestrates request-local attachment execution; `attachment-execution-state.ts` owns limits, weighted scheduling, completed/pending/inline dedupe and counters; `attachment-candidate.ts` owns materialization plus authenticated/anonymous policy; `attachment-results.ts` owns error mapping, ordered partitioning, prompt notes, usage and stage telemetry.

### 3. Contracts

- `src/attachments/**` is provider-neutral and may depend on `src/shared/**`, but must not import `src/gemini/**`, HTTP adapters, or completion modules.
- Implementation modules import Base64 helpers from `src/attachments/base64.ts`, MIME/filename helpers from `src/attachments/mime.ts`, and upload-input normalization from `src/attachments/input.ts`; there is no broad attachment compatibility facade.
- `src/completion/**` must call provider ports for upload and must not import Gemini upload modules.
- Chat/Responses image generation parses messages at the HTTP edge and passes `readonly InternalMessage[]` into completion. Completion image preparation must not accept or dispatch raw content-part arrays.
- `src/gemini/uploads/**` owns Gemini Web upload protocol details. Preferred content-push upload is multipart and must not include Gemini cookie or SAPISID authorization headers.
- Request-local candidate dedupe is scoped to one request and keyed by MIME/content type, filename, and bytes.
- Install a pending upload before awaiting it and delete that exact promise in `finally`. Successful duplicates reuse the same ref while preserving per-reference byte accounting; only the first successful upload contributes unique uploaded bytes and multipart count.
- Large-context `message.txt` / `tools.txt` uploads use the upload transport but keep hard-failure semantics through `prepareContextFiles`.

### 4. Validation & Error Matrix

- Invalid base64/data URL request-local attachment -> continue as text-only with deterministic prompt note.
- Remote `http://` / `https://` URLs are not upload sources. Match `ds2api`: only inline base64/data URL payloads are materialized for request-local upload.
- Explicit file inputs that provide only a remote URL and no existing file reference -> continue as text-only with deterministic invalid-file prompt note; do not fetch the URL.
- Preferred multipart upload rejection, invalid multipart file refs, ambiguous exceptions without a status, network-like failures, aborts, and local validation failures -> do not auth fallback; request-local attachments degrade with a deterministic prompt note and required context-file uploads fail.
- Resumable upload is not part of the current upload fallback path; do not reintroduce cookie-backed auth fallback without a spec update and explicit user-facing security review.
- Required large-context text upload failure -> return `large_context_file_upload_failed`; do not fall back to oversized inline context.

### 5. Good/Base/Bad Cases

- Good: prompt conversion emits markers, attachment planning owns candidates/refs, completion calls `resolveAttachments(plan)`, and the Gemini executor coordinates state, candidate policy, and ordered result aggregation without reimplementing them.
- Bad: `src/completion/context.ts` imports `src/gemini/uploads`.
- Bad: add a broad attachment barrel instead of importing the concrete owner.
- Bad: adding a second resolver path for images or files outside `AttachmentPlan`.
- Bad: sending `Cookie` or `Authorization` to `https://content-push.googleapis.com/upload` on the preferred multipart path.

### 6. Tests Required

- Unit tests for attachment planning, max count, existing ref consolidation, dedupe, invalid base64, remote URL non-fetch behavior, multipart request construction, upload failure degradation, upload protocol telemetry, and final file-ref ordering.
- Cover completed and in-flight dedupe, failed-pending cleanup, FIFO weighted scheduling, oversized-alone progress, unique-versus-per-reference bytes, anonymous text inline policy, and one safe failure log per dropped candidate.
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
const groups = {
  context: contextFileRefs,
  existing: existingFileRefs,
  generic: genericFileRefs,
  image: imageFileRefs,
};
const fileRefs = mergeFileRefs(...dialect.fileRefOrder.map((key) => groups[key]));
```

## Architecture Guard

`scripts/check-architecture.mjs` is the source of truth for import boundaries. It checks forbidden imports plus authored `.ts` / `.tsx` file and top-level owner cycles. Top-level owners are discovered from `src/` instead of maintained as a hard-coded allowlist; generated sources are excluded from the owner graph. Run `pnpm check:arch` after moving modules or changing imports.

Current enforced rules include:

- `src/shared/**` must not import feature layers such as `gemini`, `http`, `promptcompat`, or `toolcall`.
- `src/attachments/**` may depend on its own modules and provider-neutral `src/shared/**` helpers, but must not depend on completion, Gemini, HTTP, prompt compatibility, model, config, or tool-call owners.
- `src/admin-ui/**` may depend on its own modules and external browser packages, but must not import backend source owners through parent-relative paths.
- `src/completion/**` must not import `src/gemini/**`; use `src/completion/ports.ts` plus `src/gemini/completion-provider.ts`.
- `src/gemini/**` may import completion port types only through the provider adapter path.
- HTTP adapters must not call `gemini/client` directly.
- `promptcompat` and `completion` must not depend on HTTP adapters.
- `promptcompat` internals must not depend on `completion`; only the compatibility barrel may re-export legacy completion context helpers.
- OpenAI and Google HTTP adapters must not import each other.
- `toolcall` must not depend on prompt compatibility, HTTP adapters, or Gemini uploads; its sieve is tool-call domain state.
- HTTP adapter barrels should not re-export lower-layer completion, prompt compatibility, tool-call, or Gemini client internals. Export protocol handlers/formatters from HTTP packages and import lower-layer owner modules directly when needed.
- Implementation modules under `src/completion/`, `src/promptcompat/`, and `src/http/` import the specific tool-call owner module; bare `src/toolcall` / `src/toolcall/index` imports are invalid because no barrel exists.
- Directory-level source dependency cycles are also rejected; compatibility-only barrels are excluded where explicitly documented.
- Architecture-script tests must execute the real checker against temporary fixture roots and include TSX rejection plus dynamically discovered owner-cycle cases.

### Design Decision: Owner-Module Toolcall Imports

**Context**: A former `src/toolcall/index.ts` barrel hid which parsing, policy, formatting, schema, or sieve owner a caller depended on and made refactors harder to review.

**Decision**: Delete the barrel and require every production, public, harness, and test surface to import the concrete owner. The architecture guard rejects exact bare-barrel imports while allowing imports such as `../toolcall/openai-format`.

**Example**:

```typescript
// Good
import { validateRequiredToolCalls } from "../toolcall/policy-openai";
import type { ParsedToolCall } from "../toolcall/dsml";

// Bad
import { validateRequiredToolCalls, type ParsedToolCall } from "../toolcall";
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
- `_setConnectForTest(connect)` resets socket state for unit tests; tests import it directly from `src/gemini/transport/socket.ts` and it must never be re-exported from `src/index.ts` or `src/public-exports.ts`.

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
- `socket.ts` is the compatibility facade. Splitting implementation into `byte-queue.ts`, `pool.ts`, `timeout.ts`, `http-parse.ts`, `body-stream.ts`, or `decompression.ts` must not require callers to change imports outside `src/gemini/transport/`.
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

## Scenario: Production Bundle And Test Seam

### 1. Scope / Trigger

Use this contract when changing build outputs, public exports, smoke/bench harness, or local unit tests. Production deployments must not expose local-only test helpers, and unit tests must import authored source directly.

### 2. Signatures

- `src/index.ts` is the production Worker entrypoint and exports only stable public helpers from `src/public-exports.ts`.
- `src/harness-exports.ts` is the smoke/bench harness entrypoint. It re-exports the Worker default plus only the internal helpers `scripts/smoke.mjs` and `scripts/bench.mjs` consume; it is never imported by `src/index.ts`, unit tests, or production code.
- `scripts/build.mjs` emits:
  - `dist/worker.js` from `src/index.ts` (always)
  - `dist/harness.js` from `src/harness-exports.ts` (only with `--harness-bundle` or `BUILD_HARNESS_BUNDLE`)
- `pnpm check:size` builds `dist/worker.js` and gates its level-9 gzip size
  through `scripts/check-bundle-size.mjs`; the default gzip ceiling is 3 MiB and
  `BUNDLE_GZIP_SIZE_LIMIT_BYTES` may override it.
- `wrangler.jsonc` deploys `dist/worker.js`.
- `tests/unit/**/*.test.ts` are recursively Vitest-discovered files that import authored `src/**` modules directly (owner modules, bypassing compatibility barrels) plus narrow support modules owned under `tests/unit/_support/` or the relevant domain's `_support/` directory.
- `tests/unit/assertions.js` provides Vitest-backed assertion helpers.

### 3. Contracts

- Unit tests import internal helpers straight from their owner module (e.g. `import { buildPayload } from "../../src/gemini/client/protocol"`); there is no hand-maintained internal-export barrel. `pnpm unit` is plain `vitest run` with no pre-build.
- A helper that only smoke/bench needs is added to `src/harness-exports.ts`, not to `src/public-exports.ts`. Keep that list minimal — it exists only so the two Node harness scripts can load one bundle.
- Do not add `export * from "./harness-exports"` (or any test/harness surface) to `src/index.ts`.
- Smoke tests import the production bundle for public exports and health checks, and the harness bundle for internal compatibility checks, and must assert that representative internal helpers are absent from the production bundle.
- Bundle-size output reports raw bytes, gzip bytes, the configured gzip ceiling,
  and remaining headroom. Raw bundle bytes are observational and are not the
  release gate.

### 4. Validation & Error Matrix

- `dist/worker.js` exports `buildPayload` -> fail smoke; test helpers leaked into production.
- A unit test imports a symbol the owner module does not export -> fail typecheck/unit; fix the import or the export, do not add a barrel.
- `wrangler.jsonc` points to `dist/harness.js` -> invalid deployment config.
- Missing/empty production bundle -> `pnpm check:size` fails.
- Level-9 gzip bytes exceed `BUNDLE_GZIP_SIZE_LIMIT_BYTES` (or the 3 MiB
  default) -> `pnpm check:size` fails even when raw size is otherwise readable.

### 5. Good/Base/Bad Cases

- Good: a unit test imports the helper it needs directly from the owner module under `src/`.
- Base: add a stable user-facing helper to `src/public-exports.ts` only when it is intentionally part of the package surface.
- Bad: recreate a catch-all internal-export barrel so tests can import everything from one module.
- Bad: import a harness/test surface from `src/index.ts` to make a test pass.
- Bad: make smoke validate only the harness bundle; that misses production export leaks and route wiring regressions.
- Bad: gate raw bundle bytes with the legacy `BUNDLE_SIZE_LIMIT_BYTES`; release
  size is the compressed artifact budget.

### 6. Tests Required

- Run `pnpm build` after changing build entrypoints.
- Run `pnpm unit` after changing any file under `tests/unit/` or a helper's exports.
- Run `pnpm smoke` after changing `src/index.ts`, `src/public-exports.ts`, `src/harness-exports.ts`, `scripts/build.mjs`, or `scripts/smoke.mjs`.
- Run `pnpm check:arch` after adding imports between source layers.
- Run `pnpm check:size` after changing build inputs or runtime dependencies.

### 7. Wrong vs Correct

#### Wrong

```typescript
// src/index.ts
export * from "./harness-exports";
```

#### Correct

```javascript
// tests/unit/gemini/client/protocol.test.ts
import { buildPayload } from "../../../../src/gemini/client/protocol";
```

## Scenario: Unit Test Ownership And Support

### 1. Scope / Trigger

Use this contract when adding, moving, splitting, merging, or deleting unit
tests, or when promoting setup, fixtures, doubles, global patches, caches,
timers, or concurrency coordination into reusable test support.

### 2. Signatures

- `tests/unit/<owner>/**/*.test.ts` contains focused owner behavior.
- `tests/unit/<owner>/**/*.contract.test.ts` contains an intentional stable
  boundary spanning immediate collaborators.
- `tests/unit/_support/` contains only proven owner-neutral mechanisms such as
  deferred gates, scoped global patches, stream iterables, and base runtime
  config.
- `deferred()` returns `{ promise, settled, resolve(value), reject(error) }`;
  only the first resolve/reject call settles the promise.
- `chunks(items, throwAfter = null)` returns an `AsyncIterable` that yields in
  input order and may throw immediately after the configured zero-based item.
- `withPatchedGlobal(name, value, run)`, `withFetch(fn, run)`, and
  `withConsoleLog(fn, run)` await `run` and restore the original property
  descriptor in `finally`.
- Domain support stays with its owner, for example:
  - `tests/unit/attachments/_support/result.ts`
  - `tests/unit/gemini/_support/cache.ts`
  - `tests/unit/gemini/transport/_support/socket.ts`
  - `tests/unit/http/_support/provider.ts`
  - `tests/unit/http/_support/sse.ts`
- `vitest.config.mjs` discovers only `tests/unit/**/*.test.ts`; support files
  do not use the `.test.ts` suffix.
- Vitest uses the `threads` pool with file isolation and file parallelism left
  enabled. Owner-granular suites must not pay one child-process module-graph
  startup cost per file, and tests must still restore every mutable global or
  module owner they touch.

### 3. Contracts

- A test file has one primary observable seam and one fixture lifecycle. Mirror
  production ownership for navigation, but keep coherent facade/protocol/runtime
  behavior together when the boundary itself is the contract.
- A support module has one incidental mechanism. Do not create a root helper
  barrel that loads unrelated provider, cache, socket, database, or browser
  state into every consumer.
- An unconfigured interaction fails immediately. Output-oriented tests may use
  a small strict stub; interaction contracts record only calls, arguments, or
  order that are observable requirements.
- Mutable state cleanup is owner-specific and runs before and after where a
  failed test could leak state. Global property patches restore descriptors in
  `finally`; fake timers restore real timers in `afterEach`.
- Concurrency tests wait on explicit started/release deferred gates. Scheduler
  sleeps and bare microtask yields are not proof that an operation started.
- File size is a review signal, not an owner boundary. A large suite remains
  valid when it has one contract and one lifecycle; unrelated debugging paths
  or reset requirements require a split.
- Mechanical moves reconcile disk paths and full IDs through a generated
  manifest. Split/merge/rewrite/delete/new semantic decisions use a ledger that
  names every surviving observable target.

### 4. Validation & Error Matrix

- Disk `tests/unit/**/*.test.ts` differs from `vitest list --filesOnly` -> fail
  the migration; nested tests are missing or unrelated files are discovered.
- Duplicate `file + describe path + test name` -> fail the manifest check.
- Default parallel execution fails while serial execution passes -> treat as a
  shared-state or resource-lifecycle defect; do not disable parallelism.
- Thread-pool execution fails while fork-pool execution passes -> identify the
  process-global assumption and restore or isolate that owner; do not silently
  switch the whole suite back to forks.
- A provider/socket/store double accepts an unconfigured call -> make the
  double fail at that interaction before accepting the test.
- A test imports a compatibility projection or private mutable value instead of
  the current owner contract -> rewrite it against the typed/public seam.
- A removed or renamed case lacks a ledger target -> migration evidence is
  incomplete even when the suite is green.

### 5. Good/Base/Bad Cases

- Good: `http/openai/responses-stream.contract.test.ts` owns Responses SSE
  failure envelopes and uses a strict HTTP provider double.
- Good: a shared deferred gate is promoted only after independent domains need
  the same start/release mechanism.
- Base: a pure owner test imports one concrete `src/**` module and the assertion
  adapter, with no global reset.
- Bad: keep HTTP streaming, completion context files, and tool prompt assembly
  in a historical `toolcall.test.ts` bucket.
- Bad: add a universal `helpers.ts` whose import transitively loads Gemini
  cookie, upload, cache, and socket test seams.
- Bad: split a coherent scripts/runtime invariant suite only because it crossed
  a line-count threshold.
- Bad: disable file isolation or merge unrelated owners only to reduce runner
  startup time.

### 6. Tests Required

- Run focused owner/contract tests after every semantic move or support change.
- Run `pnpm unit`, serial Vitest, and a fixed-seed shuffled run after changes to
  globals, module state, timers, sockets, caches, or account/session lifecycle.
- Run `pnpm coverage:ci` after semantic merges/deletions and compare critical
  owner gates for lost contracts.
- Run `pnpm check:static`, `pnpm typecheck`, `pnpm check:arch`, and `pnpm smoke`
  before completing a repository-wide test architecture migration.
- Capture final disk/list/test manifests, full-ID uniqueness, semantic ledger
  reconciliation, largest test/support modules, and warm discovery/unit/coverage
  medians.

### 7. Wrong vs Correct

#### Wrong

```javascript
import { fakeProvider, resetTestState } from "../helpers.js";

beforeEach(resetTestState);
const provider = fakeProvider(); // Unexpected calls silently succeed.
```

#### Correct

```javascript
import { deferred } from "../_support/deferred.js";

const started = deferred();
const release = deferred();
const provider = {
  async *streamText() {
    started.resolve();
    await release.promise;
    yield "done";
  },
};
```

## Scenario: TypeScript Unit Test Graph

### 1. Scope / Trigger

Use this contract when adding or moving unit tests, changing Vitest discovery,
or changing the test TypeScript project and its CI/release gates.

### 2. Signatures

- Discovery: `tests/unit/**/*.test.{ts,tsx}`.
- Test type check: `pnpm typecheck:tests` -> `tsc --noEmit -p tsconfig.tests.json`.
- Production type check remains `pnpm typecheck`; neither command emits files.

### 3. Contracts

- `tsconfig.tests.json` extends the production strict baseline and adds Node plus
  test sources without weakening `tsconfig.json`.
- Unit support modules use `.ts`; JSX tests use `.tsx` only when JSX syntax is
  present. Relative `.js` specifiers may target authored `.ts` support under
  bundler resolution, but no JavaScript support file remains on disk.
- CI and release checks run both production and test type checks.
- Mechanical extension migrations preserve file count, full test IDs, coverage,
  and direct imports from authored `src/**` owners.

### 4. Validation & Error Matrix

- Disk `.test.ts` count differs from `vitest list --filesOnly` -> discovery is
  incomplete; fix the glob before proceeding.
- Duplicate full test IDs -> stop and reconcile renamed paths or suite names.
- `typecheck:tests` fails only in a support helper -> type the shared helper
  before adding leaf-local casts.
- Unit or coverage behavior changes after an extension-only migration -> treat
  it as a regression and compare against the pre-migration manifest.

### 5. Good/Base/Bad Cases

- Good: rename an owner batch, keep its direct imports, and run its focused suite.
- Base: `pnpm unit` discovers all TypeScript suites without a build step.
- Bad: keep mixed `.mjs`/`.ts` discovery indefinitely or add a generated test bundle.

### 6. Tests Required

- Run `pnpm typecheck`, `pnpm typecheck:tests`, and `pnpm check:static`.
- Reconcile disk paths with `pnpm exec vitest list --filesOnly` and full IDs with
  `pnpm exec vitest list --json`.
- Run full, serial, fixed-seed shuffled, coverage, smoke, and bundle-size gates
  after a repository-wide migration.

### 7. Wrong vs Correct

#### Wrong

```javascript
test: { include: ["tests/unit/**/*.test.mjs"] }
```

#### Correct

```javascript
test: { include: ["tests/unit/**/*.test.{ts,tsx}"] }
```

## Scenario: Coverage Reports

### 1. Scope / Trigger

Use this contract when changing test coverage commands, CI quality gates, or the local unit runner. Coverage must report authored `src/**/*.ts(x)` locations directly.

### 2. Signatures

- `pnpm unit` and `pnpm unit:quick` both run `vitest run` over authored sources (no build step).
- `pnpm coverage` runs `vitest run --coverage` via `scripts/coverage.mjs`.
- `pnpm coverage:ci` uses the same execution path, then runs `node scripts/check-coverage.mjs`.
- `vitest.config.mjs` owns the V8 coverage provider, report formats, and
  include/exclude paths (`all: true`, `include: ["src/**/*.ts", "src/**/*.tsx"]`);
  percentage thresholds belong to `scripts/check-coverage.mjs`.
- `scripts/check-coverage.mjs` owns aggregate source thresholds plus a small set of
  critical-path directory/file gates using `coverage/coverage-summary.json`.

### 3. Contracts

- Coverage instruments authored `src/**` directly; there is no coverage build and no sourcemap remapping.
- The coverage `exclude` list covers `src/generated/**`, the pure re-export barrels (`src/harness-exports.ts`, `src/public-exports.ts`), and the browser-only admin-ui view modules (`main.tsx`, `app.tsx`, `components/**`, `sections/**`, `icons.tsx`) whose behavior is validated by route/smoke assertions rather than the Node unit suite. Admin-ui logic modules (`logic.ts`, `state.ts`, `schemas.ts`, `api.ts`, `selectors.ts`) stay covered.
- Coverage thresholds are regression floors, not aspirational 100% targets. No directory or aggregate threshold should be 100%; stable areas should normally retain 2–5 percentage points of measured headroom.
- The gate ledger is intentionally small: four global gates plus critical-path gates for high-risk owners (`src/completion`, `src/gemini/accounts`, `src/gemini/completion-provider.ts`, `src/gemini/transport`, `src/http/openai`, `src/http/google`, `src/promptcompat`, `src/toolcall`). Do not reintroduce a per-file gate for every module; the global gate is the default floor.
- Generated coverage output belongs under `coverage/` and must stay git-ignored.
- Do not change `src/index.ts`, `src/public-exports.ts`, or `wrangler.jsonc` to make coverage work.

### 4. Validation & Error Matrix

- `pnpm coverage:ci` reports zero `src/` files -> coverage include/exclude is wrong; fix `vitest.config.mjs`.
- `pnpm coverage:ci` collects a report but `scripts/check-coverage.mjs` fails ->
  a global or critical-path gate regressed; add focused tests or intentionally
  ratchet the gate with evidence.
- A zero-coverage `node_modules` row changes aggregate percentages -> restrict
  source gates to normalized `src/` paths.
- A brittle 100% floor blocks unrelated work -> lower to the measured baseline with headroom.
- Production bundle exports test helpers -> smoke must fail; restore the production entrypoint boundary.

### 5. Good/Base/Bad Cases

- Good: instrument `src/**` directly and keep browser-only view modules excluded.
- Good: use an 80% line floor for a directory measured near 83% instead of a brittle 100% floor.
- Base: Vitest V8 coverage over sources with `json-summary` output plus a few critical-path gates.
- Bad: reintroduce a coverage-only build bundle and sourcemap remapping.
- Bad: add a per-file gate for every module so the ledger has to be re-tuned on every refactor.
- Bad: lower a gate only until the current command turns green without recording the measured baseline.

### 6. Tests Required

- Run `pnpm coverage` after changing Vitest coverage config or the unit runner.
- Run `pnpm coverage:ci` after changing aggregate or critical-path thresholds.
- Coverage script fixture summaries must include every gated target so missing-data failures remain tested.
- Run `pnpm unit` to confirm the non-coverage test workflow still passes.
- Run `pnpm smoke` after changing `scripts/build.mjs` because production/harness bundle separation is part of smoke coverage.

### 7. Wrong vs Correct

#### Wrong

```javascript
// vitest.config.mjs
coverage: { include: ["dist-coverage/worker.test.js"] };
```

This instruments a build artifact and needs sourcemap remapping to be readable.

```javascript
const lineGates = [["src/http/stream", 100]];
```

This makes a single uncovered defensive line fail unrelated development.

#### Correct

```javascript
// vitest.config.mjs
coverage: { all: true, include: ["src/**/*.ts", "src/**/*.tsx"] };
```

```javascript
const lineGates = [["src/toolcall", 90]];
```

This remains a meaningful regression floor for a directory measured near 93% while preserving maintenance headroom.

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
- `src/toolcall/sieve.ts` consumes `syntax-probe.ts` directly and owns stream buffer state transitions.

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
- Bad: the sieve retaining everything after any `<` until a large maximum-candidate threshold.

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
- For hot paths, build one `ToolBundle` per request and pass it through policy, filtering, prompt definition, stream sieving, formatting, and schema normalization instead of rebuilding tool metadata from raw arrays.

### 4. Validation & Error Matrix

- Google `functionCallingConfig.mode=ANY` with no normalized tool names -> `invalid_tool_choice`.
- Google `allowedFunctionNames` containing no declared normalized name -> `invalid_tool_choice`.
- OpenAI `tool_choice=required` with no normalized tool names -> OpenAI tool choice validation error.
- Parsed tool calls with available schemas -> normalize argument values through the shared schema index.

### 5. Good/Base/Bad Cases

- Good: add a new schema alias by updating `tool-meta.ts` and reusing it from prompt and schema-normalization code.
- Base: the endpoint boundary calls `createToolBundle(req.tools)` once; downstream completion and tool-call helpers receive `ToolBundle | null`.
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

Use this contract when changing `src/completion/structured-output.ts`, `src/shared/json-schema.ts`, OpenAI `response_format`, Responses `text.format`, or final-output JSON Schema validation.

### 2. Signatures

- `buildStructuredOutputRequirement(responseFormat)` returns a structured-output requirement or validation error.
- `finalizeStructuredOutputText(text, requirement)` parses, canonicalizes, and validates the final model text.
- `validateStructuredOutputValue(value, requirement)` validates parsed JSON values.
- `validateJsonSchemaSubset(value, schema, path)` is the provider-neutral schema validator in `src/shared/json-schema.ts`.
- `jsonValuesEqual(a, b)` compares JSON values structurally.

### 3. Contracts

- `json_object` requires a parsed JSON object.
- `json_schema` validates the supported JSON Schema subset after full model output is available.
- Schema `const` and `enum` must compare JSON values structurally, not by `JSON.stringify` output.
- `uniqueItems` must treat objects with identical keys and values as duplicates even when insertion order differs.
- Final successful structured output is canonicalized with `JSON.stringify(parsed)` after validation.
- `src/shared/json-schema.ts` stays leaf-level and contains no completion, HTTP, or tool-call imports; response-format extraction, JSON document recovery, canonicalization, and user-facing errors stay in completion.

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
- Bad: move completion response-format or error-message policy into the shared validator.

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

Use this contract when changing `src/promptcompat/responses-input.ts` or any OpenAI Responses route behavior that parses `req.input` into the canonical typed message model.

### 2. Signatures

- `parseResponsesInput(req, mode)` returns `InternalMessage[]` or a parse error, where mode is `completion | image-generation`.
- `normalizeResponsesInputAsMessages(req)` remains a harness/test compatibility projection; production routes do not consume its chat-style wire records.
- `parseToolCallArguments(value)` preserves object arguments and parses string arguments once into the internal object shape.
- `generateOpenAICompletionTail(args)` owns the shared Chat/Responses non-stream `generateTextLogged -> finalizeOpenAICompletionResult -> protocol error` sequence; endpoint adapters still own IDs, payloads, usage, and timestamps.

### 3. Contracts

- String `input` remains a user message.
- Recognized message shapes with `role` or `type: "message" | "input_message"` remain supported.
- Recognized item types remain supported: `function_call_output`, `tool_result`, `function_call`, `tool_call`, `reasoning`, `thinking`, `input_text`, `text`, `output_text`, and `summary_text`.
- Unknown object items must be ignored. Do not serialize unknown objects into prompt text with `JSON.stringify`, and do not treat bare `text` or `content` fields on unknown item types as user text.
- Completion mode rejects top-level `input_image` with `unsupported_responses_input`; image-generation mode retains it as a typed user image part.
- Reasoning/call/result order, pending reasoning, call-name lookup, generated IDs, instruction prepend, role normalization, and adjacent call merging are part of the parser contract.
- Tool argument objects do not cross an internal stringify/parse boundary.
- Production and compatibility Responses paths reuse the pure recognizers in `responses-semantics.ts` for item types, function-call inputs, reasoning text, call-name lookup, and pending-reasoning joins. Compatibility stringifies arguments only when projecting its final wire record.
- Recognized message content parts (`text`, input/output/summary text, reasoning/thinking, image, and file) have the same typed result whether supplied as one object or a one-element array.
- Generic message content retains the legacy unknown-singleton fallback for compatibility. This does not weaken the Responses top-level rule: unknown Responses items remain ignored.

### 4. Validation & Error Matrix

- `input: [{ type: "input_text", text: "x" }]` -> user message containing `x`.
- `input: [{ type: "custom_event", text: "secret" }]` -> no message for that item.
- `input: [{ custom: "secret" }]` -> no message for that item.
- `input: [{ role: "user", content: "x" }]` -> user message containing `x`.
- Completion `input: [{ type: "input_image", ... }]` -> parse error; image-generation mode -> typed image part.

### 5. Good/Base/Bad Cases

- Good: add support for a new Responses item by naming its `type` explicitly in the direct typed parser.
- Base: unknown future Responses metadata is ignored until the project intentionally supports it.
- Bad: convert typed input back to OpenAI wire messages and parse it a second time.
- Bad: fallback to `JSON.stringify(item)` for unrecognized items, which leaks opaque metadata into the model prompt.

### 6. Tests Required

- Unit test `parseResponsesInput` for known text, direct object/string tool arguments, unknown omission, and both image modes.
- Unit test singleton versus one-element-array equivalence for every recognized message part type, plus the explicit unknown-singleton compatibility fallback.
- Keep the compatibility normalizer covered as a harness contract.
- Unit or route-level test that `handleResponses` prompt text includes known text and excludes unknown object `text`, nested `content`, and serialized metadata.
- Run `pnpm typecheck`, `pnpm check:arch`, `pnpm unit`, and `pnpm smoke`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const wire = normalizeResponsesInputAsMessages(req);
return parseOpenAIMessages(wire);
```

#### Correct

```typescript
const parsed = parseResponsesInput(req, "completion");
if (parsed.error) return protocolError(parsed.error);
return prepareCompletion(parsed.messages);
```
