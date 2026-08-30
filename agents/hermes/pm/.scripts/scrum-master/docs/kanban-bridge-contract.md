# Kanban bridge contract for Scrum Master

Status: draft implementation contract (hybrid command plane + execution plane)

## Overview

This contract marries two systems without diluting either one:

- Scrum Master sentinel stays the command plane (policy, truth, closure).
- Hermes Kanban becomes the execution plane (worker dispatch, retries,
  heartbeats, dependency graph).

Core principle: board status is not proof. Close-gate evidence remains proof.

## Why this architecture

The existing Scrum Master rules are strong at governance:

- Provider-agnostic ticket adapter (`tp`) over Plane/Linear/Trello.
- WIP=1 expectation for active implementation work.
- Evidence-first close gate (`issue-close-gate.sh`).
- Autonomous delegated review path with drift protection.
- Bloodbank event trail for consequential transitions.

Hermes Kanban is strong at execution durability:

- Isolated workers with role-specific skills.
- Long-running queue semantics and retries.
- Explicit block/unblock lifecycle.
- Parent/child task graph for real dependencies.

Combining them gives policy discipline plus resilient throughput.

## In-scope

This bridge defines:

1. State ownership boundaries.
2. Mapping between ticket-provider states and Kanban task states.
3. Sentinel loop updates to create/monitor Kanban cards.
4. Closure policy (still gate-driven).
5. Required event emissions.

## Out-of-scope

- Replacing `tp` provider adapter with direct Kanban-only planning.
- Allowing workers to close provider tickets without close gate.
- Changing autonomous delegated-review drift rubric.

## Ownership model

### Scrum Master sentinel owns

- Ticket selection from provider board (milestone-aware).
- Transition intent in normalized states (`backlog|unstarted|started|in_review|completed`).
- Evidence file freshness and close-gate invocation.
- Decision to trigger delegated review after grace window.
- Final ticket closure through `tp transition <id> completed`.

### Kanban workers own

- Implementation execution against a scoped task body.
- Progress heartbeats and structured completion metadata.
- Blocking when action requires human or external dependency.
- Optional decomposition into child cards when instructed.

## Canonical mappings

### Ticket provider -> Kanban

- `backlog` / `unstarted` (provider) -> Kanban task `todo`.
- `started` (provider) -> Kanban task `ready` then `running` (claimed).
- `in_review` (provider) -> Kanban task `blocked` with
  `reason` prefixed `review-required:`.
- `completed` (provider) -> Kanban task `done` + provider transition,
  only after close gate passes.

### Kanban -> ticket provider

- Kanban `done` does not auto-close provider ticket.
- Sentinel re-validates evidence and gate, then transitions provider issue.
- Kanban `blocked` with external blockers leaves provider issue in
  `started` or `in_review` per current review posture.

## Data contract between systems

Each active provider issue maps to exactly one primary execution card in Kanban.

Required metadata on the Kanban card:

- `provider`: `plane|linear|trello`
- `provider_issue_id`: canonical provider issue id
- `provider_issue_key`: human key/sequence
- `milestone_id`: active milestone/cycle at enqueue time
- `evidence_file`: path to issue evidence markdown
- `implementer_profile`: assigned worker profile
- `wip_slot`: static value `implementation-1`

Optional metadata:

- `review_required`: boolean
- `close_gate_status`: `unknown|pass|fail`
- `delegated_review_eligible_at`: ISO-8601 timestamp

## Sentinel pass behavior (bridge mode)

1. Reconcile provider board + evidence + live worker activity.
2. If active healthy worker exists, monitor only.
3. If no active worker and ready issue exists:
   - ensure provider issue is `started`.
   - create or refresh a Kanban card tied to the issue id.
   - assign exactly one implementation profile.
4. On worker completion:
   - merge structured metadata into evidence draft.
   - run close gate.
   - if pass: transition provider issue to `in_review` or `completed`
     depending on review policy.
   - if fail: keep open and comment required evidence deltas.
5. On human-review-only blocker beyond grace window:
   - trigger independent reviewer task.
   - run `issue-autonomous-review.sh ... --close`.

## WIP and dependency rules

- Global implementation WIP remains 1 primary issue at a time.
- Within that issue, worker may create child cards only when they are true
  dependencies (no speculative fan-out).
- A child card must include parent linkage and inherited provider metadata.

## Event contract

Emit Bloodbank events for each consequential action, reusing existing types.
A type is exactly four tokens — `bloodbank.<domain>.<entity>.<action>` — and the
repo is **not** one of them; `holocene` goes in `data.repo`, the agent in
`actor.agent_id`. Schema revision lives in `schemaref`/`dataschema`, never as a
`v<n>` token.

- `bloodbank.repo.intake.triaged`
- `bloodbank.repo.task.created`
- `bloodbank.repo.decision.recorded`

Each carries `data.repo: "holocene"`. Subjects are the same names with the kind
infixed: `bloodbank.evt.repo.intake.triaged`, and so on.

There are no issue-level events. This section used to also list
`bloodbank.v1.repo.holocene.issue.{evidence.created,gate.passed|failed,
truthcheck.flagged}`; that whole `repo.issue.*` family was retired on
2026-08-28. It was never published to NATS and never consumed, and its shape was
invalid twice over — the repo slug sat inside the type and `issue` is not in the
Bloodbank §7 entity allowlist. There is no correct version to migrate to, so it
is gone rather than renamed. `bin/issue-close-gate.sh` and
`bin/issue-autonomous-review.sh` report their verdicts on stdout/stderr and via
exit codes; nothing depends on an event trail for them.

Before you add a family, check the name — `bb emit --check --type
bloodbank.evt.<domain>.<entity>.<action>` exits 1 on anything the contract
refuses, and `bb contract` prints the legal vocabulary. Shape-valid is not
contract-valid.

## Rollout plan

Phase 1: contract + tasking
- land this doc
- create implementation tasks

Phase 2: sentinel bridge
- add bridge mode in sentinel prompt/runner
- add provider<->kanban metadata mapping

Phase 3: close-gate integration
- ensure worker completion feeds evidence updates
- ensure sentinel remains sole closer via gate

Phase 4: autonomous review bridge
- map review-required blocks to delegated-review trigger
- verify independent reviewer constraints

Phase 5: hardening
- telemetry, failure drills, replay tests, rollback switches

## Acceptance checklist

- one active implementation issue max (WIP=1)
- every active provider issue has a linked Kanban primary card
- no provider ticket closes unless close gate passes
- autonomous close only via delegated-review protocol
- Bloodbank event trail present for all consequential transitions
