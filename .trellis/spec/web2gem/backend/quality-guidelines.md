# Quality Guidelines

## TypeScript Baseline

The package uses strict TypeScript with:

- `strict`
- `exactOptionalPropertyTypes`
- `noImplicitReturns`
- `noUncheckedIndexedAccess`
- `noUnusedLocals`
- `noUnusedParameters`
- `isolatedModules`

Run `pnpm typecheck` from `/workspace` after code changes.

## External Payload Types

Authored `src/` TypeScript has no explicit `any` types. Preserve that baseline
while retaining runtime compatibility with loose external JSON shapes.

Use these defaults:

- Prefer `unknown` at external boundaries.
- Narrow with `typeof`, `Array.isArray`, `isRecord`, or a local type guard before field access.
- Use `UnknownRecord` for JSON object-like payloads.
- Avoid broad exported aliases that hide unvalidated provider shapes. Do not
  introduce generic dynamic-record helpers for provider payloads; keep the loose
  shape local and narrow fields at the read site.

Good existing helpers:

- `src/shared/types.ts` exposes `UnknownRecord` and `isRecord`.
- `src/shared/json.ts` exposes `tryParseJson`, `parseJson`, and `parseJsonObject`.

### Test imports from untyped JavaScript modules

When a TypeScript test exercises an authored `.mjs` module that has no declaration
file, keep the module boundary honest instead of adding a broad ambient declaration
or suppressing `TS7016`:

- dynamically import through a non-literal specifier into `unknown`;
- validate that the module is a record and each required export is callable;
- assign each validated export a narrow test-local contract containing only the
  arguments and results exercised by that suite;
- keep decoded JSON and platform doubles narrow at their own read sites.

```typescript
async function importUnknown(specifier: string): Promise<unknown> {
	return import(specifier);
}

function moduleFunction<T extends (...args: never[]) => unknown>(
	moduleValue: unknown,
	name: string,
): T {
	if (!isRecord(moduleValue) || typeof moduleValue[name] !== "function") {
		throw new TypeError(`module export ${name} must be a function`);
	}
	return moduleValue[name] as T;
}
```

Do not use `declare module "*.mjs"`, an explicit `any`, or a double cast merely
to silence the import. Run the focused suite, `pnpm typecheck:tests`, and
`pnpm check:static` after introducing this boundary.

### Strict test doubles at platform boundaries

Gemini client, transport, and upload tests must keep platform doubles aligned
with the owner contract while remaining local to the suite:

- Model decoded WRB fixtures as `unknown[]` and build sparse nested paths with
  typed local arrays; do not assert provider payloads as a broad record.
- Type fetch callbacks with `RequestInfo | URL` and a narrow `RequestInit`
  extension when tests inspect header keys; use `new Headers(...)` when the
  callback receives the standard `RequestInit` shape.
- Type `ReadableStream`/`WritableStream` doubles with their byte chunk type and
  guard indexed values before using them under `noUncheckedIndexedAccess`.
- Capture thrown values as `unknown` and narrow them with an owner-local
  predicate before reading metadata such as `code`, `status`, or `reason`.

This keeps test behavior coupled to the same request, byte, and error contracts
as production code without weakening `tsconfig.tests.json` or introducing
test-wide ambient declarations.

### Account runtime test fixtures

Gemini account tests must keep their D1/runtime doubles aligned with the
production owner contracts:

- Account-row helpers return a complete `GeminiAccountRow`, including identity,
  status, refresh-attempt, and timestamp fields; optional test overrides use
  `Partial<GeminiAccountRow>`.
- Ordered runtime scripts are a discriminated `RuntimeCall` union derived from
  `GeminiAccountRuntimeStore`; each method keeps its production argument tuple
  and awaited result type.
- Account-pool tests pass a complete `RuntimeConfig` fixture. The neutral
  `TestRuntimeConfig` helper is intentionally partial and must not be widened
  or passed to production account services.
- Optional lease callbacks and nullable lease acquisitions are narrowed with a
  guard before use; do not restore hidden null assumptions with assertions.

This preserves SQL/runtime call order and makes fixture changes fail at the
same owner boundary as production contract changes.

### Admin UI strict test fixtures

Admin UI tests must keep browser and state doubles aligned with the authored UI
contracts instead of relying on implicit object and array shapes:

- Fixture factories return complete `GeminiAccount`, `AccountOverview`,
  `AccountStats`, `ModelRoutingOverview`, or `MutationResult` values; intentional
  overrides use `Partial<T>`.
- Fetch recorders accept `RequestInfo | URL` and `RequestInit`, normalize paths
  with `String(...)`, parse headers through `new Headers(init.headers)`, and
  require a string body before calling `JSON.parse`.
- Parsed request bodies remain `unknown` until narrowed with `isRecord` and
  element checks. Nullable signal state and indexed recorder entries use a
  reusable throwing guard before assertions.
- Submit handlers receive a real `Event` when the production callback expects
  one; do not replace browser event contracts with partial object literals.

These helpers preserve request payload, abort, selection, and state-transition
assertions while making owner contract changes visible to the test typecheck.

### Test deduplication helpers

Test helper extraction is allowed only when the complete owned diff, including
new support files, is physically net-negative:

- Freeze the owned-file line count and `vitest list --json` full IDs before the
  refactor. Afterward compare physical LOC, `git diff --numstat`, and IDs; a
  helper that does not delete more consumer code than it adds is rejected.
- Keep protocol-specific payload indexes, SSE frame fields, SQL/runtime call
  order, lease lifecycle, retry decisions, and error assertions at the call
  site. A helper may construct a stable fixture, but it must not become a
  generic harness that hides the behavior being tested.
- Share only byte-identical or contract-identical setup. Preserve explicit local
  overrides when account identity, headers, body bytes, stream events, error
  variants, or timing differ.
- Each child owns a disjoint support/test set and reports its focused tests,
  forbidden-pattern scan, typecheck, static, architecture, and diff checks
  before commit. Full discovery and test IDs must remain unchanged.

Good: a typed `createPool` helper removes repeated default service wiring while
ordered runtime scripts remain in each test. Bad: a universal request/router
fake replaces visible status, frame, or payload assertions merely to shorten a
suite.

### Production export surface and test-only hooks

- Production barrels re-export only what production modules import. Examples:
  `src/gemini/transport/index.ts` exports `httpFetch` + `cancelResponseBody`;
  `src/http/openai/index.ts` exports the route handlers `app.ts` needs;
  `src/gemini/uploads/index.ts` exports production upload APIs only.
- Do not re-export shared helpers through adapter/core barrels when consumers
  already import the owner (`http/core/json` must not re-export `shared/json`).
- Module-private helpers used only inside their defining file stay non-exported.
  Production-unused helpers that exist only for unit tests should be deleted
  (tests assert through public APIs) rather than kept as public exports.
- `*ForTest` / `_set*ForTest` hooks may remain on owner modules for unit
  isolation of module-level caches or connect injection. They must not appear on
  production barrels, `public-exports.ts`, or the Worker default entry. The smoke
  / bench harness may re-export symbols it actually calls.
- Context attachment filenames (`message.txt`, `tools.txt`) are owner constants,
  not `CONFIG_SPEC` / Worker binding keys. Prefer constants over env knobs when
  the value has no operational product surface.

### Prompt and tool contract tests

Prompt compatibility, completion, and tool-call tests must preserve the same
discriminants as their production owners:

- Narrow `ResponsesInputParseResult` through its `error` discriminant before
  reading `messages`; require indexed messages and parts with a local guard.
- Narrow `MessagePart` through `kind` before reading text, image, file, or
  reasoning fields.
- `normalizeResponsesInputAsMessages` intentionally returns unknown records for
  wire compatibility. Tests must validate nested records and arrays before
  reading legacy `tool_calls`/`function` fields.
- Tool-choice and sieve state fixtures use complete production contracts. Do
  not revive stale partial shapes with casts when a source owner adds required
  fields.
- Invalid JavaScript boundary calls may use `Reflect.apply` after the valid
  typed path is covered; they must not weaken the callable's authored type.

Run all three focused directories together after shared prompt/tool owner
changes so ordering, formatting, policy, and completion projections stay
compatible.

## Change Size

When tightening external payload types, prefer small, behavior-preserving
batches by module. Validate each batch with `pnpm typecheck` and
`pnpm check:arch`.

Avoid combining type tightening with protocol behavior changes unless the task explicitly requires both.

## Provider Adapter Coverage

- `src/gemini/completion-provider.ts` maintains at least 95% line and 85% branch coverage.
- Direct delegate tests assert exact text, rich, stream, attachment, and upload argument order, including account-selected config, model metadata, options, and abort signals.
- Cover empty delta filtering, unresolved models, routing logs, lease success/failure, and no-account behavior.
- Reuse the provider's existing `client` and `uploads` injection surface; do not introduce a second test-only dependency mechanism.

## Scenario: Positional D1 Insert Codecs

### 1. Scope / Trigger

Use this contract when adding or reordering fields in a D1 insert with many bound
parameters, especially `gemini_accounts`.

### 2. Signatures

- `ACCOUNT_INSERT_COLUMNS` is a typed ordered tuple of `keyof GeminiAccountRow`.
- SQL columns, placeholders, and bound values derive from that tuple.

### 3. Contracts

- Never maintain SQL column order and row-value order independently.
- Single and bulk inserts must use the same codec and conflict semantics.
- This pattern changes no D1 schema or stored representation.

### 4. Validation & Error Matrix

- Missing/renamed row key -> TypeScript failure.
- Column count mismatch -> structurally impossible when SQL is tuple-derived.
- Cookie conflict in bulk import -> existing `DO NOTHING` behavior remains.

### 5. Good/Base/Bad Cases

- Good: append one typed column and populate the normalized row.
- Base: map tuple keys to row values at bind time.
- Bad: manually edit a placeholder list and a separate positional value array.

### 6. Tests Required

- Cover single creation and bulk import through the generated statement.
- Run typecheck, account tests, architecture, and coverage gates.

### 7. Wrong vs Correct

#### Wrong

```typescript
const sql = "INSERT INTO t (id, label) VALUES (?, ?)";
statement.bind(row.label, row.id);
```

#### Correct

```typescript
const columns = ["id", "label"] as const satisfies readonly (keyof Row)[];
statement.bind(...columns.map((column) => row[column]));
```
