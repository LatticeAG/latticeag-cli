# Versioning

Envelope `schema_version` is 1.

TypeScript uses a closed union of first-class event names plus `extension`.
Runtime parse stays open: an unknown `name` becomes `UnknownLatticeEvent`.
`latticeag events --strict-names` exits 1 on unknown names.

First-class names have no dots. Extension names use `product.event`, for example `axion.loop_detected`.

Adding a first-class name is a MINOR release. The PR must update `EVENT_NAMES`, `PayloadMap`, Zod, JSON Schema, then run:

```
pnpm --filter @latticeag/events codegen
```

Removing a field, renaming a field, or changing a field type is a MAJOR release and requires a new `schema_version`.

`codegen.test.ts` hashes `types.ts` and `zod.ts` against `schemas/` and `python/`. Drift fails CI.
