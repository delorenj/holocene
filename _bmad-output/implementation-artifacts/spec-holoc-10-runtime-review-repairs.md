---
title: 'HOLOC-10 runtime review repairs and isolated emulator proof'
type: 'bugfix'
created: '2026-10-02'
status: 'done'
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
- Added port-specific discovery of the running emulator's generated gRPC token, with fallback to the legacy console token and token masking retained.
- The real emulator can consume every packet without returning the client-streaming RPC; timeout handling now cancels that call and reports `deadline_exceeded` while preserving the packet/waveform evidence.
- Guarded recognizer support callbacks by their originating generation and engine, while preserving that origin in ignored/current support diagnostics.
- Separated TTS provenance into the runtime-bound engine reported by the framework's engine accessor and the configured `defaultEngine` preference; if that accessor is unavailable on the image, it reports `unreported` rather than substituting the default.
- Added mutually exclusive diagnostic launch extras for microphone or ASR because the Honda image returns no UiAutomator root; the existing permission, host-UX, focus, half-duplex, and teardown gates still run before capture.
- Moved intent-triggered start onto the cancellable timer handler so pause/teardown cancels a queued diagnostic before it can begin.

## Review Triage Log

- medium — Parent review's inactive injection cancellation finding was real; the generated future call is now watcher-cancelled, and fake-server tests prove both explicit cancellation and deadline cancellation.
- medium — Parent review's stale recognition-support callback finding was real; support callbacks now check originating generation/engine and log stale delivery as ignored.
- medium — Parent review's default-TTS mislabel finding was real; runtime logs separate the bound engine from the configured default and report `unreported` when unavailable.
- medium — Parent review's late oversized-WAV allocation finding was real; header bounds are validated before `readframes`, with a regression proving no sample read occurs.
