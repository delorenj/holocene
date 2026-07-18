# Ticket Lifecycle Workflow Plan

## Approved correction

The 2026-07-18 Correct Course decision classifies the change as Major. The old
workflow embedded a local state machine and provider writes in Momo/Holocene.
The corrected workflow is a client protocol over one headless Lifecycle
authority.

## Current evidence

- No standalone Lifecycle repository, service, or root Compose entry exists.
- Bloodbank contains a tested deterministic controller embryo with leased
  reconcile work, atomic current state/history/outbox persistence, and a sweeper.
- Its default outbox publisher is unconfigured.
- Its emitted blocker event lacks a registered schema, and initial status
  payloads can violate the registered contract.
- Momo and Holocene contain planning/workflow surfaces but no conforming client.

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

## Extraction and cutover dependency

Freeze vocabulary and versions; close Bloodbank schema/outbox gaps; extract the
controller with git history; add missing spec/frontier/obligation/capability and
command behavior; back up and migrate state/history/outbox with row, key,
fingerprint, replay, and rollback checks; then cut Momo and Holocene clients over.
Only after those gates may root Compose add one Lifecycle service.

## Success criteria

The source and generated workflow copies are byte-identical. Validation proves
one writer, deterministic replay, idempotency, version conflicts, capability
denial, unavailable-service behavior, history continuity, and absence of direct
Momo/Holocene provider transitions. Documentation does not claim deployment.
