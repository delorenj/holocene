# Step 4: Request Work Start and Delegate

## Goal

Start one implementation worker only after Lifecycle accepts the work-start
intent.

## Actions

1. Confirm WIP capacity, legal action, expected state version, and capability.
2. Create a stable command ID/idempotency key and submit work-start intent.
3. On stale, denied, rejected, or unavailable, do not dispatch; refetch/report.
4. On accepted, reserve WIP=1 and delegate exactly one implementer.
5. Record worker/evidence references as observations, not state writes.

## Prohibition

Do not call tp, Trello, Plane, or another provider transition directly.
