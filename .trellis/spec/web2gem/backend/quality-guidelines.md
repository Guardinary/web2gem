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
