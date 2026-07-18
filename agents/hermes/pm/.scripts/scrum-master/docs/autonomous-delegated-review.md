# Autonomous Delegated Review

Status: review/evidence protocol; direct autonomous closure is legacy.

## Purpose

An independent reviewer evaluates completed work against locked intent when a
human reviewer is unavailable. The result is evidence and a PM recommendation
submitted to Lifecycle. It is not permission for the PM or script to close a
provider ticket directly.

## Trigger conditions

Run only when Lifecycle exposes a legal review action, the configured grace
window elapsed, complete evidence exists, and the reviewer is independent of
both implementer and PM. External credentials, paid actions, undecided product
intent, unmet acceptance criteria, and open dependencies remain blockers.

## Drift rubric

- Significant: unmet acceptance, capability/scope outside locked intent,
  architecture contradiction, premature later work, or new external dependency.
- Minor: internal refactor, extra tests, naming, cosmetics, or documentation.
- None: matches locked intent and acceptance evidence.

Only none/minor with no unresolved critical/high finding supports an acceptance
recommendation.

## Target decision flow

1. Run the close gate and independent adversarial review without --close.
2. Record reviewer identity, drift, findings, gate result, and immutable evidence.
3. Submit the verdict/observation and any accept/hold intent using the canonical
   versioned/idempotent Lifecycle command.
4. Refetch and render the authoritative result.

The existing issue-autonomous-review.sh --close and tp transition paths are
legacy direct writers. Do not use them in the target protocol.

## Outcomes

- Accepted recommendation: Lifecycle may accept or reject it based on current
  version, obligations, and capability.
- Held recommendation: submit findings and repair evidence; Lifecycle determines
  the resulting obligations/frontier.
- Stale/denied/unavailable: no mutation; refetch or report the blocker.

Decision events preserve reasoning and audit history only. They never enact the
review outcome.
