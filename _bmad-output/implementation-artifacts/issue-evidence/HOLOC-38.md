# HOLOC-38: Earshot battery cost, read-only snapshot (2026-11-17)

## Scope correction (Crank, 2026-11-17)

The S26 is **read-only**. Resetting batterystats counters is a device write, so it
needs explicit operator approval, and that approval has not been given.

- Comparative runs, such as 2 s vs 5 s polling, go on an emulator or a spare device.
- The original ticket allowed a counter reset. This supersedes it.

## What was read

| Item | Detail |
|---|---|
| Commands | `dumpsys batterystats --charged sh.delo.earshot`, `--checkin --charged`, `dumpsys battery`, `dumpsys deviceidle whitelist` |
| Writes | None. No reset, no settings change, no app change. |
| Raw files | `~/.local/state/holocene-auto/battery/holoc38-readonly-20261117T182609Z-*` (not committed) |
| Device | SM-S948U |
| Battery | Estimated capacity 5000 mAh. On AC at 100% when read. |
| App | Earshot 0.1.9, uid u0a807 (appId 10807) |
| Window | 1 h 9 m on battery since the last full charge, of which 44 m was screen-off |

## Findings (BatteryStats model estimates, on-battery only)

| Measure | Earshot | Device | Earshot share |
|---|---|---|---|
| Total discharge in window | ~13.5 mAh | 200 mAh | ~7% |
| Screen-off discharge | ~11.9 mAh | 45 mAh | **~26%** |
| Screen-off: mobile radio | 5.87 mAh | | |
| Screen-off: wake lock | 5.80 mAh (13 m 52 s) | | |
| Screen-off: CPU | 0.26 mAh | | |
| `earshot:poll` partial wake lock | held for the whole service life (actual 44 m 8 s screen-off; 15 m 48 s blamed) | | |
| Mobile radio active | 3 m 0 s, 20.1% of the device's radio-active time | | |
| Deep doze | | 0 mAh, never entered (screen doze only 45 s) | consistent with a held wake lock |

Ranked by estimated power across all of the device's apps, Earshot (u0a807, 15.2 mAh) comes 5th. It is in Doze's deviceidle whitelist.

**Naive extrapolation (low confidence):**

| Basis | Rate | Per day | Share of battery |
|---|---|---|---|
| Screen-off | ~16 mAh/h | ~390 mAh | ~8% of 5000 mAh |
| Blended | ~12 mAh/h | ~280 mAh | ~5.6% |

**Reading:** the cost is the radio and the wake lock, not the CPU. This matches the
audit's prediction (`earshot docs/launch/2026-11-17-paid-launch-brief.md`, Risks):
a 2 s poll keeps the cellular radio and the CPU from idling.

## Gaps (not resolved here)

- **Short window.** 69 minutes since the last charge is too short for a daily figure. A longer read needs either a full day off the charger, read without a reset (the operator's choice of when), or the reset approval.
- **Estimates only.** BatteryStats gives modelled numbers, not measured ones. Battery Historian on a full bugreport would give a timeline. A bugreport is a read, but it captures personal data, so the PM should decide whether one is acceptable.
- **No comparison yet.** The 2 s vs 5 s (single-channel) comparison has not been run. It needs an emulator or a spare device. An emulator's radio model is not a real cellular radio, so a spare physical device is the better evidence.

## Status

Evidence only. No launch, beta, pricing, publishing, spending, deletion or
implementation decision is implied. Those holds stay with Jarad.
