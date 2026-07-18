# Ticket Lifecycle Client Implementation Record

## Approved correction

The 2026-07-18 Correct Course decision classifies the change as Major. The old
workflow embedded a local state machine and provider writes in Momo/Holocene.
The corrected workflow is a client protocol over one headless Lifecycle
authority.

## Implemented current slice

- Lifecycle is the standalone state/reconcile authority and is deployed by the
  root Compose topology from an immutable image.
- Bloodbank contains the canonical versioned lifecycle schemas and NATS/JetStream
  transport.
- Candystore durably consumes lifecycle events/replies and exposes a read-only,
  freshness-aware projection.
- Momo filters authoritative frontier/obligations and emits canonical
  skill-invocation and lifecycle command intent through Bloodbank.
- Holocene renders Candystore's projection and publishes high-level canonical
  commands without optimistic local transition state.

## Target responsibilities

- Lifecycle: spec/state versions, deterministic reconcile, frontier,
  obligations, blockers/gates/checkpoints, capability validation, idempotency.
- Bloodbank: canonical command/event/reply schemas and transport.
- Candystore: immutable event history and rebuildable projections.
- PJangler: stable project/bootstrap identity and binding inputs.
- Momo: rank legal work, delegate, review, submit observations/evidence/intent.
- Holocene: render provenance/freshness and submit high-level intent.

## Create sequence

1. Resolve project identity, capability, and authoritative snapshot.
2. Choose a legal frontier item using business policy; assess AC readiness.
3. Delegate refinement and submit resulting observations/evidence.
4. Submit work-start intent and delegate only after acceptance.
5. Collect implementation and independent review evidence.
6. Submit QA evidence; retry only when the new frontier permits it.
7. Render the authoritative result and decision audit.

## Contract invariants

- Every command has a command ID, idempotency key, lifecycle ID, expected state
  version, actor, requested capability, and intent payload.
- Duplicate command IDs return the prior result.
- A stale expected version or denied capability rejects without state mutation.
- A decision event records why Momo chose an action; it is never the action.
- Provider projections cannot override Lifecycle state.
- An unavailable authority is a visible blocker, never an empty/healthy state.

## Operational boundary

Clients always refetch after intent and treat queued transport acknowledgement as
non-authoritative. Lifecycle rejection, stale data, missing grants, or transport
outage remains visible and fail-closed. Provider state, board state, local files,
and UI clicks never substitute for the authoritative projection.

## Success criteria

The source and generated workflow copies are byte-identical. Validation proves
one writer, deterministic replay, idempotency, version conflicts, capability
denial, unavailable-service behavior, history continuity, and absence of direct
Momo/Holocene provider transitions.
