# Lifecycle Contract Requirements

Bloodbank owns the canonical schema IDs and transport subjects. This workflow
must not invent executable event names or publish an unregistered payload.

## Snapshot/read contract

Required data includes lifecycle/project identity, spec/state versions,
provenance, observation time, legal frontier, obligations, blockers, and
capability grants.

## Intent command contract

Required data includes command ID, idempotency key, lifecycle ID, expected state
version, actor identity, capability/grant context, intent, and evidence
references. Delivery is single-consumer.

## Result contract

Required data distinguishes accepted, rejected, stale, denied, duplicate, and
unavailable outcomes and includes the authoritative resulting state version.

## Observation/evidence contract

Observations never mutate state directly. They identify the lifecycle, source,
observation/evidence kind, causation/correlation, and immutable evidence
references so Lifecycle can reconcile deterministically.

## Momo decision provenance

The existing Bloodbank repo decision event may audit Momo's business reasoning.
It cannot serve as an intent command, capability grant, obligation result, or
state transition.

Before execution is enabled, every contract above must be registered and pass
Bloodbank schema, runtime, naming, producer, consumer, and replay validation.
