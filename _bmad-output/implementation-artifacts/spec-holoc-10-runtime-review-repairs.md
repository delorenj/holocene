---
title: 'HOLOC-10 runtime review repairs and isolated emulator proof'
type: 'bugfix'
created: '2026-10-02'
status: 'in-progress'
route: 'oneshot'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/holoc-10-recovery-plan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** HOLOC-10 has passing deterministic checks but four parent-review source defects and no Honda emulator acceptance evidence; the prior run stopped safely before boot completed under its 4 GiB scope.
**Approach:** Repair the cancellation, callback-generation, TTS-provenance, and bounded-input defects with focused regressions, then run the unchanged diagnostic APK/harness in a separately owned measured emulator scope and record only observed evidence.

</frozen-after-approval>

## Implementation Notes

- Repaired WAV header validation so oversized inputs fail before `readframes` allocates sample data.
- Kept the injection RPC handle alive and added a watcher that cancels the active call when caller cancellation is requested; the fake server now proves a blocked stream cancels before deadline.
- Guarded recognizer support callbacks by their originating generation and engine, while preserving that origin in ignored/current support diagnostics.
- Separated TTS provenance into the runtime-bound engine reported by the framework's engine accessor and the configured `defaultEngine` preference; if that accessor is unavailable on the image, it reports `unreported` rather than substituting the default.
