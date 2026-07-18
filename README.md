# Holocene

Holocene is a 33GOD control-plane dashboard that surfaces live fleet, tooling,
and pipeline health from API services, Redis-backed stats, and SSE/polling
feeds. Its UI is built around generic live data components, where specific
panels like Hook Health are just collection renderers over structured backend
payloads.

## Lifecycle surface (implemented)

Holocene renders Lifecycle truth from Candystore's read-only projection through
`GET /api/modules/lifecycle/:lifecycleId`. Missing observations render
`unknown`/`degraded`; stale observations retain the last authoritative values
while visibly degrading freshness. The UI displays identity, spec/state
versions, source and provenance, authority status/health/phase/fingerprint,
legal frontier, obligations, blockers/gates, and stable command verdicts.

High-level actions are accepted by
`POST /api/modules/lifecycle/:lifecycleId/actions`. The API refetches the
projection, requires a legal frontier item and matching capability grant, then
publishes the canonical version-checked command through Bloodbank. A queued
response is transport acknowledgement only: Holocene never advances local
state optimistically and waits for a later authoritative projection/verdict.

Lifecycle remains the only specification, transition, reconcile, frontier,
obligation, and capability authority. Candystore is read-only projection/history,
Bloodbank owns schemas and transport, Momo is a policy client, and Holocene does
not infer or persist lifecycle truth. Deployment topology and authority
bootstrap are owned by the root `33god-platform` Compose project.

Future work may add navigation and richer fleet-wide filtering; it must reuse
the same projection and command boundaries rather than introduce client-side
lifecycle semantics.
