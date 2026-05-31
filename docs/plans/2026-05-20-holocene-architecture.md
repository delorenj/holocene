# Holocene Architecture Plan

> For Hermes: execute with kanban-orchestrated codex workflow; enforce Bloodbank v1 naming contract.

Goal
- Rebuild Holocene from scratch as the control-plane dashboard for the 33GOD ecosystem, starting with Hermes PM fleet visibility/control.

Principles
- Keep only the name Holocene from v1 codebase.
- Event-native: UI state is derived from Bloodbank event streams.
- Modular: every view is a 33GOD module component implementing the same contract.
- Real-time first: each module consumes streams incrementally and renders windowed projections.
- Source-of-truth hierarchy: Bloodbank events > registry/config metadata > computed projections.

## 1) Top-level system shape

1. Holocene Shell
- Hosts layout, routing, auth, theme, module registry.
- Does not embed domain logic.

2. Module Runtime
- Base abstract class/interfaces for module lifecycle.
- Each module declares:
  - id, name, event subscriptions, projection reducers, commands/actions, health checks.

3. Event Plane Adapter
- Normalizes Bloodbank envelopes to internal typed stream records.
- Supports:
  - replay window
  - live tail
  - checkpoint/resume
  - backpressure + batching

4. Projection Store
- Per-module read-models/materialized views.
- Event-sourced reducers with deterministic replay.
- Cache + snapshot strategy for fast reloads.

5. Control Plane Actions
- Restart gateways/consumers
- Template sync across agents
- Run diagnostics
- Emits command events where possible; uses system actions where required.

## 2) Module contract (base 33GOD component)

ModuleDefinition
- meta: id, title, version, owner, tags
- subscriptions: list of Bloodbank subjects/types
- reducer: (state, event) -> state
- selectors: derived UI-ready slices
- commands: action descriptors (input schema + executor)
- health: required streams, stale thresholds, status rules

Runtime lifecycle
- init(context)
- hydrate(snapshot)
- consume(events[])
- render(model)
- dispose()

Performance defaults
- bounded event windows per module
- virtualized tables/lists
- reducer micro-batching (e.g. 50-200 events)
- stale-while-revalidate snapshots

## 3) First module: Hermes Agent Fleet

Data inputs
- Registry metadata: ~/.hermes/agents-registry.yaml
- Role manifests: */agents/hermes/*/role.yaml
- Runtime SOUL + config files
- Bloodbank streams:
  - bloodbank.evt.v1.system.heartbeat.received
  - bloodbank.evt.v1.agent.invocation.started
  - bloodbank.evt.v1.agent.invocation.completed
  - bloodbank.evt.v1.agent.invocation.failed
  - bloodbank.evt.v1.conversation.turn.started/completed

Projection outputs
- Fleet index (agent_id, repo, role, profile, runtime path)
- Presence state (online/degraded/offline via heartbeat freshness)
- Work state (idle/busy from invocation started/completed)
- PM active-work state from
  `agents/hermes/<role>/runtime/continuous-ticket-sentinel-state.json`, including
  active issue, session, worktree, blocker reason, heartbeat time, and log path.
- Last activity summary (last turn/invocation outcomes)
- Drift state (template/version/skill external dir mismatch)

Actions
- restart gateway (one/all)
- restart consumer (one/all)
- sync template defaults (one/all)
- open recent session summary

## 4) Event contract alignment note

Use Bloodbank v1 types (not legacy dotted short forms).
Examples:
- bloodbank.v1.system.heartbeat.received
- bloodbank.v1.agent.invocation.started
- bloodbank.v1.agent.invocation.completed
- bloodbank.v1.agent.invocation.failed

## 5) Suggested repo architecture (new Holocene)

holocene/
  apps/
    web/                    # dashboard shell
    api/                    # control-plane API + stream endpoints
  packages/
    module-sdk/             # abstract base module contract + runtime helpers
    bloodbank-client/       # event plane adapter, replay/tail, typed envelopes
    projection-core/        # reducer/snapshot/checkpoint primitives
    modules-hermes-fleet/   # first module implementation
    system-actions/         # safe wrappers for restart/sync operations
    shared-ui/              # presentational components only
  ops/
    compose/                # local dev topology
  docs/
    adr/
    plans/

## 6) Transport + runtime recommendation

- API stream: WebSocket (or SSE for simpler deployment) from api app.
- Event ingestion: dedicated ingest worker subscribing to bloodbank.evt.v1.>
- Projection persistence: SQLite first (fast bootstrap), upgradeable to Postgres.
- Frontend: module host pulls projection updates, not raw firehose.

## 7) Milestones

M1: Skeleton
- New clean repo structure
- module-sdk + shell + ingest worker stubs
- basic event viewer panel

M2: Hermes Fleet module
- registry discovery
- heartbeat/invocation presence projection
- status grid + detail drawer

M3: Control actions
- restart/sync actions with audit log
- action confirmations + result toasts

M4: Generalization
- module loader/registry
- add 2nd module (e.g. Bloodbank health)

## 8) Non-goals for v1

- Pixel-perfect design system
- Multi-tenant RBAC complexity
- Historical BI analytics over long retention

## 9) Immediate next execution plan

1. Initialize fresh branch in holocene; archive old code under /legacy or remove.
2. Scaffold monorepo layout above.
3. Implement module-sdk interfaces + test fixtures.
4. Implement bloodbank-client subscription/replay API.
5. Implement Hermes Fleet module projection + first dashboard view.
6. Add system action adapters for restart/sync.
7. Wire smoke tests with synthetic Bloodbank event fixtures.

Acceptance criteria
- Fleet page shows all known PM agents from registry.
- Agent presence flips based on heartbeat freshness.
- Agent busy/idle flips on invocation started/completed.
- One-click restart gateway works for single agent + all agents.
- One-click template sync applies canonical skill root + PM workflow defaults.
