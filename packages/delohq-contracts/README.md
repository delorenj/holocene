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
- `ok` may carry `stale` or `expired` freshness. `state` says the read
  succeeded; it says nothing about age. Views must render `freshness.state`
  and never infer "current" from `state: "ok"`.
- `observed_at` and every evidence `observed_at` may not postdate
  `generated_at` (60s skew), and a known `freshness.age_seconds` must match
  `generated_at - observed_at`. A self-reported age cannot hide old data.
- Freshness budgets are policy. Callers pass `max_age_seconds`; this package
  picks none.
- Validators return `{ ok, value } | { ok: false, issues }` and never throw.
  Constructors throw `ContractViolationError` so an adapter cannot emit a bad
  payload. Constructors stamp `schema_version`; consumers never write it.

## Migration rule

The envelope and every nested object in it (`freshness`, `error`, `evidence`,
`source`, refs) have a fixed key set per major version, and validators reject
unknown keys. So adding, removing, or renaming any of those fields is a
**major** bump of the affected surfaces in `src/registry.ts`, shipped to web
and API together. Minor and patch versions may change only a surface's `data`,
and only additively. The validator accepts any version with the registered
major. Adding a surface means adding a registry entry.

## Dialect guard

`src/dialect-guard.test.ts` scans `apps/web/app/hq/**` and any `apps/api/src`
file about hq/delohq. It fails on a local `schema_version`, a local
`*Envelope`/`*Projection` type, `generatedAt` + `observedAt`, un-imported
`generated_at` + `observed_at`, the legacy `{ ok, error | status }` dialect, and
browser payload types imported from `@holocene/org-model` or
`@holocene/modules-hermes-fleet`. Importing this package does not exempt a
file. Files that still violate today are listed in `LEGACY_DIALECT_ALLOWLIST`
with their reasons. The list can only shrink: when a file is migrated, the
test fails until its entry is removed.

## Checks

```bash
pnpm --filter @holocene/delohq-contracts build
pnpm --filter @holocene/delohq-contracts typecheck
pnpm --filter @holocene/delohq-contracts test   # includes the /hq dialect guard
```
