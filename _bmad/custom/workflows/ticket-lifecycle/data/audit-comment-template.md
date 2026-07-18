# Lifecycle Client Audit Record

Use one record per consequential Momo decision or command attempt.

## Identity and versions

- Project ID:
- Lifecycle ID:
- Spec version:
- Observed state version:
- Snapshot provenance:
- Snapshot observed at:

## Policy decision

- Legal frontier action considered:
- Action selected or deferred:
- Pillar basis:
- Business reasoning:
- Alternatives rejected:

## Command or observation

- Command ID:
- Idempotency key:
- Expected state version:
- Capability/grant:
- Intent or observation kind:
- Evidence references:

## Authoritative result

- Outcome: accepted, rejected, stale, denied, duplicate, unavailable, or observation-recorded
- Resulting state version:
- Obligations/frontier summary:
- Bloodbank contract/schema ID:
- Candystore history reference, when available:

This record is audit provenance. It must never be used as proof that Momo wrote
or calculated lifecycle state.
