# Code Reuse Thinking Guide

> **Purpose**: Stop before creating code and verify that the behavior does not
> already have an owner.

---

## Before Writing New Code

### Search First

```bash
rg "functionName|typeName|constantName" src tests scripts
rg "protocol field|error code|config key" src tests scripts
```

Search by behavior and literals, not only by the name you intend to introduce.
Protocol adapters often express the same rule with different local names.

### Identify The Owner

| Question | Preferred action |
|----------|------------------|
| Does an owner module already expose this behavior? | Extend or reuse it |
| Do multiple consumers read the same external field? | Add one decoder or projection |
| Is the value part of a protocol or config contract? | Keep one typed source of truth |
| Is the logic provider-neutral? | Keep it out of provider and HTTP adapters |
| Is the proposed helper only used once? | Prefer local code until reuse is real |

Use the package directory spec to choose the owner. Do not put unrelated code
in `src/shared/` merely because more than one caller needs it.

---

## Common Duplication Patterns

### Repeated Constants

**Bad**: category lists, limits, error codes, or config keys are independently
declared in validation and persistence modules.

**Good**: define the typed value and its guard in the domain owner, then import
it from every boundary that validates or stores the value.

### Repeated Payload Field Extraction

**Bad**: multiple consumers cast the same external JSON fields locally.

```typescript
const status = (payload as { status?: string }).status;
```

**Good**: narrow `unknown` once at the boundary and expose a typed result.

```typescript
if (!isRecord(payload) || typeof payload.status !== "string") return null;
return { status: payload.status };
```

If the same untyped field is read in two places, search for an existing owner
before adding a third reader.

### Parallel State Transitions

When state is derived from action-like values such as `kind`, `status`, or
`phase`, prefer one reducer or dispatcher over scattered `if` branches.

```typescript
switch (event.kind) {
  case "delta":
    return recordDelta(state, event);
  case "issue":
    return recordIssue(state, event);
}
```

The owner should update all derived fields together so protocol writers do not
maintain partial copies of the transition model.

---

## When To Abstract

Abstract when:

- The same rule appears in three or more places.
- Two boundaries must interpret the same external value identically.
- The logic is complex enough to require focused tests.
- A change to one constant must propagate to validation, storage, and output.

Do not abstract when:

- The behavior is local and used once.
- The helper would hide an important boundary or trust decision.
- A generic record utility would weaken validation of provider payloads.

---

## After Batch Modifications

1. Search for the old value, symbol, and behavior.
2. Confirm every consumer imports the selected owner.
3. Remove compatibility aliases unless an external contract requires them.
4. Run type, architecture, and focused behavior checks.

## Checklist Before Commit

- [ ] Searched source, tests, and scripts before adding a helper or constant.
- [ ] One module owns each protocol field, config key, category, and limit.
- [ ] External payloads are narrowed from `unknown` once per boundary.
- [ ] Shared code remains provider-neutral and leaf-level.
- [ ] Reducer-owned state is not mirrored by protocol adapters.
- [ ] All old definitions and literals were searched after the change.
