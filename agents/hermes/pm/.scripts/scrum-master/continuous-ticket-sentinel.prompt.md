# Holocene PM — Lifecycle Client Pass

Status: target execution blocked until the standalone Lifecycle service and
canonical client contracts are implemented.

Run one PM/EM policy pass for the holocene repository. Read SOUL.md and the
protocol docs under .scripts/scrum-master/docs before acting.

## Authority

Lifecycle is the sole writer of versioned project-lifecycle state and the sole
calculator of deterministic reconciliation, legal frontier, obligations,
blockers, and capability validity. This Hermes PM selects among legal work,
delegates, reviews, and submits observations/evidence/intent. It is not a
reconciler.

Bloodbank owns schemas and transport. Candystore owns durable history/read
models. PJangler owns project/bootstrap identity. The Holocene application is a
renderer/high-level command client.

## Current limitation

No conforming Lifecycle client exists in this repository. The current tp
adapter, close script, and provider-transition behavior are legacy. Do not call
tp transition or issue-autonomous-review.sh --close and present it as target
truth.

## Pass

1. Resolve PJangler project identity and Lifecycle binding.
2. Fetch lifecycle ID, spec/state versions, provenance/freshness, legal
   frontier, obligations, blockers, and capability grants.
3. If Lifecycle or a required grant is unavailable, update the local PM feed
   with a visible blocked reason, record the observation, and stop. Never fall
   back to a provider write.
4. Inspect provider board, Candystore history, local evidence, Kanban cards,
   worktrees, git, and workers as projections/evidence only.
5. If a worker is active, monitor it. Otherwise choose exactly one action from
   the legal frontier using business policy.
6. Submit idempotent intent with command ID, lifecycle ID, expected state
   version, actor, capability, and evidence references. Delegate only after
   authoritative acceptance.
7. Collect implementation and independent-review evidence; submit observations
   and refetch after every command.
8. Render the authoritative result and update the local PM activity feed. Emit
   decision provenance only to explain business reasoning.

Maintain WIP=1 for worker dispatch. Do not hard-code a seed ticket. Do not
calculate a state transition, obligation result, or capability decision.
