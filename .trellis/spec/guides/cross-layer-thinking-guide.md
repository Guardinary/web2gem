# Cross-Layer Thinking Guide

> **Purpose**: Trace data across boundaries before changing a contract.

---

## Before Implementing Cross-Layer Features

### Map The Data Flow

Write the complete path before editing:

```text
Request → HTTP normalization → service/domain → provider or storage → response
```

For each arrow, identify the input shape, output shape, validation owner, error
shape, and whether sensitive data may cross the boundary.

### Identify Boundaries

| Boundary | Common risks |
|----------|--------------|
| HTTP ↔ completion | Protocol envelopes, aborts, streaming lifecycle |
| Completion ↔ provider | Provider-neutral ports, account lease ownership |
| Service ↔ D1 | Nullability, positional values, transaction/version updates |
| Worker ↔ Docker | Web/Node translation, disconnect propagation, env strings |
| Admin API ↔ UI | Sanitized DTOs, pagination, mutation summaries |
| Config ↔ deployment | Env key registration, examples, generated bindings |

### Define Contracts

- What exact type or payload crosses the boundary?
- Where is `unknown` narrowed?
- Which layer owns normalization and error conversion?
- What must never cross the boundary, such as cookies or raw D1 rows?
- Which tests prove the same behavior through every adapter?

---

## Common Cross-Layer Mistakes

### Implicit Format Assumptions

**Bad**: HTTP, service, and storage each interpret a field independently.

**Good**: normalize at the entry boundary and pass a typed domain value.

### Scattered Validation

**Bad**: route, service, and persistence code each clamp or default the same
input differently.

**Good**: one domain or input owner defines the accepted values and bounds;
defensive lower layers reuse that owner.

### Leaky Abstractions

**Bad**: HTTP handlers receive raw D1 rows, or provider modules construct
OpenAI/Google response envelopes.

**Good**: each layer knows only the adjacent contract and returns sanitized,
provider-neutral values where required.

### Repeated External Payload Parsing

**Bad**: each consumer casts raw JSON fields locally.

**Good**: one type guard or decoder owns normalization from `unknown`, and all
consumers use its typed projection.

---

## Config And Environment Consistency

When adding or changing a runtime config key, trace all applicable owners:

```text
CONFIG_ENV_KEYS → parser/defaults → wrangler/Compose → example env files
→ WorkerBindings generation → README/package binding metadata
```

- [ ] Search for the key before changing it.
- [ ] Preserve the distinction between Worker typed bindings and Docker string
      inputs.
- [ ] Regenerate or check `worker-configuration.d.ts` when binding inputs change.
- [ ] Verify cache keys include every environment value that affects parsing.
- [ ] Update runtime and release specs when the deployment contract changes.

---

## Checklist For Cross-Layer Features

Before implementation:

- [ ] Mapped the complete read and write flow.
- [ ] Identified every trust and serialization boundary.
- [ ] Selected one validation and normalization owner.
- [ ] Defined error and cancellation behavior.
- [ ] Identified sensitive fields that must be redacted or omitted.

After implementation:

- [ ] Tested null, empty, malformed, oversized, and aborted inputs.
- [ ] Verified data survives storage/provider round trips.
- [ ] Verified errors keep the correct protocol envelope.
- [ ] Verified Docker and Worker adapters preserve application behavior.
- [ ] Verified consumers import shared decoders instead of casting locally.
- [ ] Ran architecture checks for changed imports and owner boundaries.

## When To Add Flow Documentation

Add an executable code-spec scenario when a change introduces a new API,
storage, deployment, or three-layer data contract. Include signatures,
contracts, validation/error cases, tests, and wrong-versus-correct examples.
