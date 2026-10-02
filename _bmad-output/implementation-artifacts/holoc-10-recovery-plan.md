# HOLOC-10 recovery 1 — isolated speech diagnostic

## Ownership and continuity

- Coordinator: momo:holoc10-manual-recovery; sole coder is original Codex thread 01a0fe43-970f-74b3-a175-81c61ea15439 resumed once.
- Carrier: installed Codex CLI, AutomaticAI gateway https://api.automaticai.io/v1, automaticai/intelliforia/claude-sonnet-5.5, xhigh; no account switch or credential/config change.
- Branch: holoc-10-isolated-speech-audio; base 41d9ba22bf97b55be2b7a50dccbec2e787abeee4.
- Original PM command 63cffece-b965-591f-a09b-81b2cda57573 naturally completed successfully at 2026-10-02T20:55:00.054960Z; turn ended at 20:54:18Z. Journal had no nonterminal Holocene invocation, lease was FREE, original worker/emulator dead, active Codex processes belonged to other repos, adb empty.
- Separate ignored spool: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-10-recovery-1. Original HOLOC-10 spool and original thread history remain preserved.

## Smallest sequence

1. Extend existing apps/auto diagnostic only: Android PCM RMS/peak, recognizer support/timing/final result gate, platform-local acknowledgement, generation-safe teardown/public key stop. Keep unknown/restricted host UX fail closed and half duplex.
2. Add canonical <=5s benign locally generated WAV and an isolated gRPC injection/output harness using installed SDK proto, existing tools/.venv and ignored generated stubs. Deterministic tests cover formats, auth, deadlines, cancellation and waveform calculations.
3. Build and run unit/lint checks before launching emulator, leaving no Gradle daemon competing for the emulator budget.
4. Within an owned <=4GiB worker budget use 1536MiB guest RAM first, at most 2048MiB, two cores, swiftshader_indirect. Monitor actual cgroup MemoryCurrent/peak and owned emulator RSS, stop only that emulator before the cap if needed. No widening/bypassing policy.
5. Read-only existing Honda AVD; owned serial 5590/gRPC8590 only if free. Private authenticated loopback with negative auth probe, host AudioEnabled=false, process-private Pulse null sink; no host mic/room playback or blanket no-audio.
6. Capture injected-mic/silence waveforms, real provider support/final transcript <=15s, result-derived local diagnostic guest output, screen/key cancellation and restrictions limitations. Report reproduced blockers rather than fixtures.
7. Preserve code/evidence and small feature-branch checkpoint. No merge/deploy/ticket close. Parent owns fresh independent spec/quality review.

## Initial AC matrix

| AC | State | Required proof |
|---|---|---|
| 1 | UNPROVEN | Canonical input provenance/format/duration, actual Android RMS/peak/sample count, silence control |
| 2 | UNPROVEN | Actual provider/support, ready/begin/endpoint/final matching transcript <=15s |
| 3 | UNPROVEN | Accepted final alone gates explicitly local diagnostic ack and actual streamAudio waveform |
| 4 | UNPROVEN | Screen/public-key prompt teardown, focus release, generation guards/no late effects/no publication |
| 5 | UNPROVEN | Fail-closed UX and half duplex regressions, qualified product gates/CAP-8 open |

## Verification

- Android: ./gradlew testDebugUnitTest lintDebug assembleDebug --console=plain with existing SDK/JDK.
- Python: python3 -B -m unittest discover -s tools/tests -v; baseline 27 tests/skips preserved.
- Harness focused deterministic checks and actual bounded emulator probes.
- Repo-provided API/web typechecks where runnable; no changes/deployment to those components.
- git diff --check; exact source HEAD, APK SHA256, feature publication and canonical handback structure.

## Known limitations before execution

The supported BMAD renderer was invoked once by the coordinator:

`uv run --no-cache /home/delorenj/code/33GOD/holocene/.worktrees/holoc-10-isolated-speech-audio/_bmad/scripts/render_skill.py --project-root /home/delorenj/code/33GOD/holocene/.worktrees/holoc-10-isolated-speech-audio --skill /home/delorenj/code/33GOD/.opencode/skills/bmad-build`

It failed: `Failed to spawn ... render_skill.py; No such file or directory (os error 2)`. This scoped plan records that limitation; no renderer/config repair or direct workflow execution is authorized.

Original terminal cause was 4GiB worker-scope OOM with 4096MiB guest RAM, not observed ASR/provider failure. Host snapshot: available 55020916736 bytes, physical free 6679654400 bytes, swap free 5378048 bytes; availability is not budget proof. Runtime peaks and cap margins must be measured in the recovery.
