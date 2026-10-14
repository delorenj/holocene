# Hook observability

`/hooks` follows a native CLI hook through its normalized Bloodbank event to
the handlers it selects. The explorer and stacked topology panels preserve
the operator's `~/quickdrop/hooks.excalidraw` model.

The UX was refined with [Google Stitch](https://stitch.withgoogle.com/projects/16143358374491232683),
screen `919e509947ca4713abcbfbdc39c1e8cf`, using Holocene's existing color and
type system. The generated design's sample timings, commands, and receipts
are not application data.

Hook badges count configured handlers; the receipt table counts observed
invocations. Installed wiring is inspected independently of the registry.
The page distinguishes missing or duplicate wiring, a quiet CLI, handler
failure, and an unavailable feed. Receipt details show individual outcomes,
durations, duplicate suppression, lifecycle transitions, and publication
status. A publication marked `sent` is not a Candystore acknowledgment.

Holocene's host API proxies these read-only endpoints:

| Holocene route | Hook hub route |
| --- | --- |
| `/api/modules/hooks/status` | `/v1/hooks/status` |
| `/api/modules/hooks/invocations` | `/v1/hooks/invocations` |
| `/api/modules/hooks/invocations/:id` | `/v1/hooks/invocations/:id` |

`HOOK_HUB_URL` defaults to `http://127.0.0.1:8685`. Requests time out after four
seconds. The browser refreshes every four seconds while visible, supports
pausing, and retains the last snapshot with an explicit stale notice when a
request fails. Filtered history is paginated. Raw prompts and transcripts are
not sent to the page.

The hub owns the handler registry and durable receipt journal; the CLI
installer owns native configuration inspection. Holocene does not infer
successful execution from the presence of a command in a configuration file.

## Event store retention

The collected-event store (`~/.local/state/holocene/events.sqlite3`,
`HOLOCENE_EVENT_DB`) is a rebuildable read model, so it keeps a window, not
history. The API prunes it hourly (`apps/api/src/event-retention.ts`):

| Rows | Kept |
| --- | --- |
| Telemetry: `agent.hook.updated`, `system.hook.updated`, `agent.tool.*`, `llm.allowance.observed` | 3 days |
| `bloodbank.repo.*` (tickets, decisions; read by count, not age) | 365 days |
| Every other event type | 30 days |
| `hook_invocations` (hook-hub receipt history) | 7 days |

Tune with `HOLOCENE_RETENTION_TELEMETRY_DAYS`, `HOLOCENE_RETENTION_DAYS`,
`HOLOCENE_RETENTION_DURABLE_DAYS`, `HOLOCENE_RETENTION_HOOK_DAYS`,
`HOLOCENE_RETENTION_TELEMETRY_TYPES` (extra comma-separated types), or turn it
off with `HOLOCENE_RETENTION=off`. Freed pages are reused, so the file stays at
its steady-state size. `pnpm --filter @holocene/api maintenance
prune|stats|compact|vacuum-into <dest>` runs the same pass by hand; the header
of `apps/api/src/maintenance.ts` describes the snapshot-and-swap used to shrink
the file (26.6 GiB to 2.2 GiB on 2026-10-14).
