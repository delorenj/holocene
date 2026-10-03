# Evidence: HOLOC-10 - isolated Honda emulator speech-to-audio diagnostic

## Issue

- Ticket: HOLOC-10; parent 33GOD:I-2.3. Branch `holoc-10-isolated-speech-audio`; implementation base `41d9ba22bf97b55be2b7a50dccbec2e787abeee4`.
- Current status: **PARTIAL PASS / NOT READY TO CLOSE**. The isolated emulator now proves real injected speech, Android capture, recognizer transcript, result-gated local TTS, guest output capture, and public-key teardown. Screen-button teardown on the emulator and restricted-host transition remain unproved; CAP-8 remains open.
- Runtime spool: `holocene/agents/hermes/pm/runtime/workers/HOLOC-10-recovery-1/emulator/runtime3-*` and `runtime2/`.

## Acceptance Criteria

1. **PASS.** The canonical asset remains mono PCM16, 16 kHz, 24,240 samples, 1.515 s, peak 22,973, RMS 5525.9, SHA256 `66fb4170674a0986d4d608e9d1ec4a4e04a020233f6df44dcfa88185be01e84b`. Authenticated `injectAudio` sent 164 packets / 104,480 bytes in 2.312 s with host `realAudioEnabled=false`. During injection, Android `AudioRecord` measured 96,000 samples, RMS 2776.7, peak 22,973, readError 0, with the 100 ms envelope rising into the utterance and returning to silence. A separate no-injection control measured 96,000 samples, RMS 4.8, peak 8, readError 0.
2. **PASS.** Provider identity was `com.google.android.tts/com.google.android.apps.speech.tts.googletts.service.GoogleTTSRecognitionService`. `checkRecognitionSupport` first returned error 14, then reported supported on-device `en-US` among many locales. Ready occurred 314 ms after start, speech begin 2,069 ms, endpoint 3,994 ms, and final transcript 4,024 ms: `"summarize recent work"`.
3. **PASS.** The accepted final result alone requested the labelled platform-local acknowledgement. Runtime TTS provenance reported bound engine `com.google.android.tts` and default preference `com.google.android.tts`; speak queued successfully, `tts_start` occurred 261 ms after the request, and `tts_done` occurred 4,409 ms after it. Concurrent `streamAudio` returned 132,592 PCM samples (8.287 s), RMS 164.1, peak 1,355, 51,880 nonzero samples across 897 packets; active output spans 2,900–6,600 ms, aligned to TTS start/done. Captured WAV SHA256 `f71eb9d0987496a2a30ad3b89d713a1ffc52f7dfba510d4e71882607a07bd4e0`. This is not Vox and not an agent reply.
4. **PARTIAL.** A real `KEYCODE_MEDIA_STOP` during active ASR called the common teardown 21 ms after the key event (`cancel` to `released`), with no later ASR callback in the five-second observation window. Screen-button click, per-resource release timing, focus loss, and pause remain covered by source/JVM generation-guard tests rather than emulator measurements because this Honda image returns a null UiAutomator root and its screencap path hung.
5. **PARTIAL.** The emulator host reported baseline UX `requiresDO=false, mask=0; unrestricted=true`, and capture followed that gate. Unknown/restricted fail-closed behavior and half-duplex refusal remain source/JVM-proved. The Honda user image still cannot inject a UX transition (unchanged HOLOC-9 limitation). CAP-8, category/OEM/VIA eligibility, distribution, actual Civic installation, and driving readiness remain separate open gates.

## Source Repairs Since Blocked Recovery 1

- Oversized WAV headers are rejected before `readframes` loads samples.
- A blocked `injectAudio` RPC keeps a cancellable future handle; caller cancellation reaches the active RPC, and an emulator server that consumes packets but never returns is cancelled and reported as `deadline_exceeded`.
- Recognition-support callbacks carry and check their originating generation/engine; stale callbacks log as ignored.
- TTS diagnostics separate the runtime-bound engine from the configured default preference.
- The harness discovers the running emulator's generated port-specific gRPC token and retains token masking.
- Mutually exclusive `RUN_MIC` / `RUN_ASR` intent extras start the existing gated diagnostic paths because UiAutomator is unavailable on this image.

## Verification

- Python: 44 tests OK, 3 environment-dependent skips (`runtime2-python-final.log`).
- Android: 26 JVM tests, 0 failures/errors/skips; lint has 0 errors and 6 existing warnings; `testDebugUnitTest lintDebug assembleDebug --rerun-tasks` succeeded with 49 tasks (`runtime2-android-final.log`).
- Runtime-proof APK SHA256 `a60b9fd9573be5a28a3b07cf92d2ebbce7b3af51dcb982b29c6834450d628f5d` (`holocene-auto-holoc10-repaired.apk`), including the diagnostic intent extras. The final deterministic rebuild after moving queued intent start onto the cancellable timer handler has SHA256 `e258b7b26f8f4dbf0c3ed78d2679c5b3cb97a0fd03c9149b237e62bade72087d`; clean force-stopped runtime starts used that same scheduling path without the transient install pause seen during an in-place package replacement.
- gRPC negative-auth probe returned `UNAUTHENTICATED`; authenticated status returned `booted=true`, and `setMicrophoneState(false)` read back false.
- Runtime 3 scope: `MemoryMax=8GiB`, `MemoryHigh=7GiB`, `TasksMax=1536`, two cores, 2,048 MiB guest RAM, `swiftshader_indirect`, read-only AVD, no snapshot. Boot completed in 33.127 s. Measured peaks: scope current 4,482,781,184 bytes, pinned 3,645,695,352 bytes, emulator RSS 3,660,402,688 bytes. AVD `config.ini` hash unchanged.
- Runtime 2 with `TasksMax=700` booted but exhausted its thread budget during the first audio RPC (`Thread: failed to create a thread`). Runtime 3 raised only the owned task ceiling and completed the audio path.
- A later second injection after the completed transcript/TTS/key-stop sequence ended `UNAVAILABLE (Stream removed)` and QEMU exited; memory remained below cap and the monitor recorded `emulator exited`, not an owned stop. Treat repeated injection into one Honda emulator process as unproven/unsafe until investigated.

## Ledger Update

- No board state change in this pass.

## Close Recommendation

- Do not close HOLOC-10 yet. The real emulator speech/audio diagnostic is now demonstrated, but parent review should verify the source repairs and decide whether partial AC4/AC5 evidence is sufficient for this diagnostic ticket or whether a separate on-screen/restriction ticket is required.
