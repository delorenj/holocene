# Kanban Execution Bridge Contract

Status: corrected target contract; implementation is not complete.

## Overview

The bridge connects three distinct responsibilities:

- Lifecycle is the state/command authority.
- The Momo/Hermes PM is the business-policy and delegation client.
- Hermes Kanban is the worker execution plane.

Neither the PM nor Kanban calculates lifecycle truth. Provider boards are
projections behind Lifecycle's adapter boundary.

## Ownership

### Lifecycle owns

- versioned spec/state and deterministic reconciliation;
- legal frontier, obligations, blockers, gates, and checkpoints;
- capability validation, command idempotency, and provider projection writes.

### PM client owns

- selecting among legal actions using business policy;
- WIP=1 dispatch policy;
- delegation, evidence collection, independent review, and intent submission;
- decision provenance explaining why an action was selected.

### Kanban workers own

- scoped implementation execution;
- progress heartbeats and completion metadata;
- dependency cards when explicitly required;
- external/human blocker observations.

## Data contract

Each active implementation maps to one primary Kanban card with project ID,
lifecycle ID, source state version, provider issue identity, evidence path,
implementer profile, command ID, and WIP slot. Kanban states describe worker
execution only; they never map directly into lifecycle transitions.

## Bridge behavior

1. Fetch Lifecycle and choose one legal work item.
2. Submit work-start intent.
3. After acceptance, create/refresh one linked Kanban card and assign one worker.
4. Submit worker progress/completion as observations.
5. Submit close-gate and independent-review evidence.
6. Refetch and render Lifecycle's result.

No Kanban done state, provider lane, close-gate pass, or review verdict
automatically closes lifecycle work.

## Bloodbank contract

Use only registered canonical command/event/reply schemas. Local repo-lane
events may retain diagnostic provenance but are not executable transition
contracts. A decision event audits PM reasoning only.

## Acceptance

- one Lifecycle writer;
- one primary implementation card per active work item;
- no direct provider transition from PM/Kanban;
- idempotent/versioned/capability-checked commands;
- immutable evidence references and independent review;
- visible stale, denied, rejected, duplicate, and unavailable outcomes;
- provider/Candystore projections never substituted for authoritative state.
