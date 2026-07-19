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
legal frontier, obligation occurrence/activation identity, blockers/gates, and
stable command verdicts. A projection with missing or non-Lifecycle provenance,
schema identity, source actor, or causal metadata fails closed as
`unknown`/`degraded` and cannot authorize a command.

High-level actions are accepted by
`POST /api/modules/lifecycle/:lifecycleId/actions`. The API refetches the
projection, requires a legal frontier item and matching capability grant, then
derives the grant's canonical `capability_version` and the complete semantic
command identity, then publishes the version-checked command through Bloodbank.
The command inherits the authoritative snapshot's correlation lineage and names
that exact snapshot event as its cause; Holocene never fabricates causal IDs.
The current publisher uses core NATS. Its PING/PONG result proves server protocol
processing only; it is explicitly not a durable JetStream publish acknowledgment
or Lifecycle acceptance. Holocene never advances local state optimistically and
waits for a later authoritative projection/verdict. Gate-resolution actions stay
disabled until the client supplies an explicit resolution choice.

The machine-readable browser gate is `scripts/prove-lifecycle-browser.mjs`.
It opens the real `/lifecycle/:lifecycleId` page in Chromium, reads the selected
actor, current capability grant, allowed frontier, and expected state version
from semantic DOM attributes, accepts the Lifecycle-required confirmation, and
clicks the enabled UI action. The script observes the browser's unmodified POST
and HTTP 202 body, records the explicitly non-authoritative broker receipt, then
waits for Candystore's later projection to render the matching authority verdict,
resulting state version, and causal source before writing a JSON receipt plus
desktop and mobile screenshots. It does not route, replace, or predict any
Lifecycle response.

```bash
pnpm prove:lifecycle-browser -- \
  --base-url http://127.0.0.1:3001 \
  --lifecycle-id <id> \
  --frontier-id <confirmation-frontier-id> \
  --output /tmp/holocene-browser-receipt.json \
  --screenshots-dir /tmp/holocene-browser-screenshots
```

Lifecycle remains the only specification, transition, reconcile, frontier,
obligation, and capability authority. Candystore is read-only projection/history,
Bloodbank owns schemas and transport, Momo is a policy client, and Holocene does
not infer or persist lifecycle truth. Deployment topology and authority
bootstrap are owned by the root `33god-platform` Compose project.

Future work may add navigation and richer fleet-wide filtering; it must reuse
the same projection and command boundaries rather than introduce client-side
lifecycle semantics.
