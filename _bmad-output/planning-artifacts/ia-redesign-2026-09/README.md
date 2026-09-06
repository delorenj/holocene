# Holocene IA redesign — 2026-09-06

Design canvas: <https://claude.ai/code/artifact/9566554f-0184-4186-930d-cda24ca71a75>

## What this is

A ground-up reorganization of Holocene's information architecture, decided from
three independently-authored IAs scored by two adversarial judges, on top of
reconnaissance measured against **live services** rather than read from docs.

## Read in this order

| file | what it is |
|---|---|
| `DECIDED-IA.md` | **The decision.** Severity ladder, routes, landing surface, deletions, future seams. Where the three proposals conflicted, this file decides. |
| `VERIFIED-GROUND-TRUTH.md` | Every live data surface, with locators. **Read the CORRECTIONS section at the end — it overrides the first half**, and it is where the judges caught real errors. |
| `CURRENT-STATE-AUDIT.md` | First-hand tour of the app as it stands, with the concrete failures the redesign exists to fix. |

## The one-line principle

**Present tense on top, past tense underneath, and the machine must pay for its
silence.** Redis is authoritative for "now". Candystore is authoritative for
"what happened". Nothing renders as healthy that has not proved it, and an empty
alarm state is a claim that must be itemized, not a blank.

## Live defects this work surfaced (independent of any redesign)

These are measured, not inferred. None of them are visible in the current UI.

1. **Silent data loss.** `candystore.dead_letter` — 285 rows in 7 days and still
   growing. `hermes-agent` emits non-UUID correlationids, so part of the PM
   fleet's own trail reaches NATS and never reaches Postgres. Reachable only by
   `psql`; no endpoint exposes it.
2. **The Plane bridge is down** — `hermes-plane-webhook-bridge.service` inactive,
   `healthOk: false`, `projectsMapped: 0`, nothing on `:8477` — while 26 agents
   carry a "bridge-bound" badge whose tooltip says they react to their board.
3. **Gates on codex are structurally invisible.** `agent-hook-telemetry` already
   computes `codex|attention → {verdict: silent, lastSeenAgo: never,
   agentsAlive: 41}`. A permission prompt on any of those 41 agents produces no
   row anywhere in the product.
4. **Ticket Velocity is fabricated.** `velocity_history` returns 0 rows; the
   Candystore join measures zero because live events carry
   `actor.agent_id = 'bloodbank.agent.claude'`, never a Hermes registry id.
   Every bar is synthesized client-side at `page.tsx:403`.
5. **`/api/clock/state` returns HTTP 500**, which is why the Orwell card reads
   "Last state: unknown" permanently.
6. **174 of the fleet table's 261 buttons target units that do not exist**
   (`consumer_unit` is unset, so `fleet.ts:775` invents a name), and
   `page.tsx:573-604` never checks `response.ok` — a failed restart is
   indistinguishable from a successful one.

## Stale claims corrected here

- The ASM `stale`/`gone` sweeper **is** built and running (`core/sweep.py` on
  `asm-sweep.timer`, 15s). There is also a live `asm:transitions` Redis pub/sub
  channel and a per-scope `asm:t:<scope>` STREAM carrying a `reason` per edge.
- **Krebs owns zero executable code.** Its four "implementation" directories each
  contain one README describing software that does not exist. The running
  pipeline is n8n + the Hermes sentinel loop.
- **Flume is not the org-chart owner.** The repo exists but is 6.5 months cold
  and not checked out; its only real contribution is vocabulary, already vendored
  into `packages/org-model`.
- **`tp_band` has no `in_review` value** — it occurs zero times. Review lives in
  `ticket.state.name`.
- **`.stitch/DESIGN.md` specifies an 8-scale Inter type system that has never
  once rendered** — Inter is named at `globals.css:30` and loaded nowhere.
  This document supersedes it; delete or reconcile it before it misleads again.

## Status

Design and plan only. No application code has been changed.
