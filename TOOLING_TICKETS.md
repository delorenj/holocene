# Holocene Tooling tickets

This backlog breaks the Tooling tab into implementation slices that can ship
independently while keeping Redis as the Holocene-facing stat contract.

## TOOL-1: Tooling tab foundation

Status: done

Add the first-class Tooling tab and the shared stat-card component family.

- [x] Add a top-level `Tooling` tab beside the existing fleet view.
- [x] Add `BaseStatCard` for shared stat-card presentation.
- [x] Add `PollingStatCard` for interval-driven Redis stat reads.
- [x] Add `SSEStatCard` for server-sent stat updates.
- [x] Keep the existing Hermes fleet view intact under the Fleet tab.

## TOOL-2: Redis-backed tooling stat API

Status: done

Expose typed stat definitions and snapshots through the Holocene API, with Redis
as the read path and a 30-day TTL on stat entries.

- [x] Add a tooling stat registry.
- [x] Add Redis read helpers for stat snapshots.
- [x] Add Redis write helpers that set `EX 2592000`.
- [x] Add stat definitions, per-stat reads, and all-stat reads.
- [x] Add an SSE endpoint for Redis-backed stat snapshots.
- [x] Add a refresh endpoint for collector-backed stat updates.

## TOOL-3: Agent Hook Health stat

Status: done

Dogfood the Tooling tab with the first pipeline health stat.

- [x] Track the primary agent CLIs: `claude`, `codex`, `hermes`, `opencode`,
  `gemini`, and `kimi`.
- [x] Collect configured hook commands from each CLI's current local config.
- [x] Resolve Bloodbank publisher hooks to normalized `bloodbank.v1...` event
  types.
- [x] Mark unsupported publisher hook arguments and missing command paths as
  failing rows.
- [x] Render each row with CLI, Bloodbank normalized hook, hook, command, and
  `ok`.
- [x] Show missing or empty hook configuration instead of hiding a CLI.

## TOOL-4: Prometheus and Loki bridge

Status: planned

Move beyond direct config health by feeding Redis snapshots from the canonical
observability stack.

- [ ] Add a Prometheus query bridge for numeric health stats.
- [ ] Add a Loki query bridge for recent error or trace-card stats.
- [ ] Keep high-cardinality details out of Loki labels.
- [ ] Write bridge output into the same Redis stat snapshot shape.

## TOOL-5: Stat extensibility contract

Status: planned

Make new pipeline stats cheap to add without custom frontend plumbing.

- [ ] Move stat definitions into a registry file or structured config.
- [ ] Add validation for stat snapshot shape.
- [ ] Add renderers for number, status, duration, table, and text stat kinds.
- [ ] Add fixtures for local UI development when Redis is unavailable.
