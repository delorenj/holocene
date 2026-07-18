# PM Client Events and Commands

Status: corrected contract guidance; canonical Lifecycle schemas remain an
implementation dependency.

## Authority

Bloodbank owns canonical schema IDs, CloudEvents envelopes, NATS/Dapr subjects,
and command delivery rules. Lifecycle owns the domain result. Candystore stores
durable event history/read models. The PM does not turn a local event into a
state transition.

## Local diagnostic spool

The current emit-event.py script appends repo-lane events to
_bmad-output/implementation-artifacts/bloodbank-events.jsonl. Those entries are
diagnostic/audit observations. They are not canonical Lifecycle commands and
may not be used as proof of current state.

## Target command requirements

Every state-changing intent must use a registered Bloodbank command contract
with command ID, idempotency key, lifecycle ID, expected state version, actor,
capability/grant context, intent, and evidence references. Delivery is
single-consumer.

The result must distinguish accepted, rejected, stale, denied, duplicate, and
unavailable outcomes and include the authoritative resulting state version.

## Observations and evidence

Evidence-created, gate, review, truth-check, worker, and blocker reports are
observations. Lifecycle may reconcile them; their emission alone never changes
state. Promote a local type only after schema, naming, runtime, producer,
consumer, replay, and compatibility validation in Bloodbank.

## Decision provenance

A repo decision event records the PM's business choice, pillar basis, and
reasoning. It cannot serve as a capability grant, obligation result, intent
command, or transition.

If Bloodbank or Lifecycle is unavailable, preserve the local diagnostic record,
surface the outage, and stop the target state-changing pass.
