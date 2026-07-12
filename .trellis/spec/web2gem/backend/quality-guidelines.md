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

## Replacing `any`

The codebase currently has legacy `any` in provider-payload paths. Reduce it incrementally and preserve runtime compatibility with loose external JSON shapes.

Use these defaults:

- Prefer `unknown` at external boundaries.
- Narrow with `typeof`, `Array.isArray`, `isRecord`, or a local type guard before field access.
- Use `UnknownRecord` for JSON object-like payloads.
- Avoid broad exported aliases that hide unvalidated provider shapes. Do not reintroduce generic dynamic-record helpers for provider payloads; keep the loose shape local and narrow fields at the read site.

Good existing helpers:

- `src/shared/types.ts` exposes `UnknownRecord` and `isRecord`.
- `src/shared/json.ts` exposes `tryParseJson`, `parseJson`, and `parseJsonObject`.

## Change Size

When reducing `any`, prefer small, behavior-preserving batches by module. Validate each batch with `pnpm typecheck` and `pnpm check:arch`.

Avoid combining type tightening with protocol behavior changes unless the task explicitly requires both.

## Provider Adapter Coverage

Treat provider adapters as argument-order and metadata boundaries, even when the underlying client already has integration coverage.

- `src/gemini/completion-provider.ts` must maintain at least 95% line coverage and 85% branch coverage in `scripts/check-coverage.mjs`.
- Tests must assert the exact client argument order for text, rich, and streaming calls, including model IDs, thinking mode, extras, file refs, model headers, options, and abort signals.
- Cover unresolved-model errors, request-routing metadata, empty stream delta filtering, attachment resolution, and text-file upload delegation.
- Keep dependency injection test-only: expose the injected factory through `src/test-exports.ts`; do not add it to the public Worker exports or production bundle.
- When the adapter gains a new delegated field or method, update its direct contract test and file-level coverage gate in the same change.
