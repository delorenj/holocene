# Continuous PM/EM Policy Orchestration

Status: corrected target protocol; blocked on Lifecycle implementation.

## Invariant

When Lifecycle exposes legal executable work, exactly one implementation worker
is active or the PM records why no legal action was selected. WIP=1 prevents
duplicate workers. Command idempotency, expected state versions, and capability
validation prevent duplicate/conflicting state writes.

## Source order

1. PJangler project/bootstrap identity.
2. Authoritative Lifecycle snapshot: identity, spec/state versions, provenance,
   freshness, frontier, obligations, blockers, and grants.
3. Local evidence and live worker/Kanban state.
4. Provider board and Candystore history as projections only.

When sources disagree, submit the discrepancy as an observation. Lifecycle
remains authoritative; the PM does not choose or write a winning state.

## Policy pass

1. Fetch the authoritative snapshot.
2. Monitor an existing healthy worker, if any.
3. Otherwise rank only legal frontier items by product/business policy.
4. Submit idempotent work-start intent with expected state version.
5. Delegate exactly one worker only after acceptance.
6. Collect evidence and independent review; submit both as observations.
7. Refetch and follow only the new legal frontier.
8. Render accepted, rejected, stale, denied, duplicate, blocked, or unavailable
   outcomes in the PM feed.

## Current adapter boundary

The tp adapter may read provider projections and post signed notes during
migration. Its transition operation and the existing --close script are legacy
direct writers and cannot satisfy the target protocol.

## Stop conditions

Stop without dispatch when Lifecycle/grants/contracts are unavailable; no legal
action exists; a worker is already healthy; every legal candidate needs an
external/paid/destructive action; or business intent is genuinely undecided.
Never invent a provider transition to escape a blocker.

Board status is not proof. Evidence is an input. Lifecycle deterministically
evaluates that input and owns the resulting state.
