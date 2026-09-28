# @holocene/delohq-contracts

The only registry of browser-facing DeloHQ contracts (AD-11). Every `/hq/api/*`
projection, the adapters behind it, the `/hq` views, and their tests import
envelope types, canonical refs, freshness, error states, and evidence metadata
from here. The package has no runtime dependencies and does no IO.

```ts
import { classifyFreshness, okProjection, errorProjection, validateProjectionEnvelope } from "@holocene/delohq-contracts";

const freshness = classifyFreshness(observedAt, now, { max_age_seconds: policy });
const body = okProjection({
  surface: "company",
  source: { system: "flume", adapter: "org.ts" },
  generated_at, observed_at: observedAt, freshness,
  evidence: [{ evidence_ref, source: { system: "flume", adapter: "org.ts" }, observed_at: observedAt }],
  data
});

const parsed = validateProjectionEnvelope(await res.json(), validateCompany);
if (!parsed.ok) { /* render contract_violation, never a healthy default */ }
```

## Rules

- Wire fields are snake_case, and every `*_at` is ISO-8601 UTC ending in `Z`.
- A ref is `{ kind, id }`. The `id` is opaque and preserved byte-for-byte.
  Join on `refKey(ref)`, never on a label. Labels go in `Labeled<R>`.
- `ok` needs data, evidence, and `observed_at`. `degraded` needs the same plus
  an error. `unknown` and `error` need error detail and never claim `fresh`.
- Freshness budgets are policy. Callers pass `max_age_seconds`; this package
  picks none.
- Validators return `{ ok, value } | { ok: false, issues }` and never throw.
  Constructors throw `ContractViolationError` so an adapter cannot emit a bad
  payload.

## Migration rule

An incompatible change bumps the surface's `schema_version` major in
`src/registry.ts`. Adding a surface means adding a registry entry. Minor and
patch versions must be additive. The validator accepts any version with the
registered major.

## Checks

```bash
pnpm --filter @holocene/delohq-contracts build
pnpm --filter @holocene/delohq-contracts typecheck
pnpm --filter @holocene/delohq-contracts test   # includes the /hq dialect guard
```
