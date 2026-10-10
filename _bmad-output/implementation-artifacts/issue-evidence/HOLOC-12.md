# HOLOC-12 implementation handback

Status: **DONE_WITH_CONCERNS** — implementation and authorized emulator phase delivered; ticket review/distribution gates remain open.
Worker: codex-holoc12-1 (sole implementer). Generated UTC: 2026-10-10T21:56:16.602517+00:00.
Branch: holoc-12-auto-ux. Worktree: /home/delorenj/code/33GOD/holocene/.worktrees/holoc-12-auto-ux.
BASE_SHA: c7af66d64fff0be349be4f1362c80e1d4e54e3a3.
Implementation source SHA: 13456305c7a77ce5cee06d31979f11dc06a35300.
Final handback HEAD_SHA (includes this evidence commit): recorded in /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/worker-identity.json and /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/handback/HOLOC-12.handback.json after committing evidence.
PM owns fresh independent SPEC review, then fresh independent QUALITY review. No gate is approved or cleared by this handback.

## Exact ticket binding

HOLOC-12; workitem 5fccdc76-dc75-4fee-a1f1-34b412d42aec; workspace 33god; project 727a2b17-a1dd-46f6-b583-afa5a2d2cdae. No Plane calls or writes were made.

## Criterion-by-criterion verification

PASS below means implementer verification, not independent review approval.

| AC | Status | Evidence and remaining boundary |
|---|---|---|
| 1 | PASS | screenshots/final-honda-home.png; screenshots/final-constrained-home.png (current APK; clear home only) |
| 2 | PASS | AutoSurfaceTest matrix and permission tests; final-permission-dialog.png; final-honda-home.png; final-home-check-ended.png |
| 3 | PASS | final-honda-diagnostics.png; final-canned-preview.png; final-screen-cancel.png; final-fixture-evidence.png; final-constrained-about.png; runtime5-app.log |
| 4 | PASS | 46 JVM tests including 16 AutoSurface regressions; runtime5-app.log PID 4420 stop/cancel/late callback; restriction transition remains separately BLOCKED |
| 5 | PASS | final-honda-home.png/json (1280x720, font 1.0); final-constrained-home.png/json (1024x640, font 1.15); native diagnostics/about captures |
| 6 | BLOCKED | Android + Python checks PASS; worktree isolation PASS; independent SPEC and QUALITY remain PM-owned and pending |
| 7 | BLOCKED | Signing, fresh versionCode, Play track readback and physical Civic re-check pending; forbidden in this implementer phase |

### Acceptance criteria verbatim

1. Default app-owned viewport has a clear Holocene Auto title, concise human status explaining disconnected/diagnostic-only capability, meaningful grouping and legible car-distance typography. Raw runtime/session IDs, ISO timestamps, fixture feeds and probe plumbing are absent from home; no invented live agents, connectivity, responses or readiness.
2. There is at most one visually primary voice action, enabled only when the real available provider, microphone permission and unrestricted/known car-host state support it. If it is only a local voice check, label it as such and say it does not contact agents. Unsupported/unknown/restricted states explain why it is unavailable. No permission or host-restriction bypass, default-assistant change, live backend/broker/Vox integration or driving approval.
3. An explicit secondary Diagnostics path retains canned preview, microphone probe, final ASR/local acknowledgement, cancellation and useful raw fixture/runtime/provider evidence. System Back returns to home. Privacy/about stays accessible via a secondary truthful path respecting existing host restrictions rather than dominating home.
4. Navigation, home and diagnostics preserve actual capture/cancel/teardown, half-duplex focus/playback, generation/stale-callback handling and restricted/unknown host fail-closed behavior. Navigating away, lifecycle teardown and host restriction cannot strand recording/playback. Focused regression tests cover those paths; unavailable device-level restriction injection is reported separately, not waived or simulated as physical proof.
5. Apply dp/sp and semantic/native controls, usable touch targets, safe-area/host window insets. Capture authentic AAOS runtime screenshots at the Honda representative 1280×720 viewport and a second constrained car viewport/inset/font-scale configuration. Verify no clipped controls/status, hierarchy and readable labels; images must be adb/runtime captures with package/version/serial/viewport provenance, never mockups or reconstructed screenshots. Preserve Honda/OS-owned chrome.
6. Run focused Android tests, lint, APK build and relevant existing auto tooling; map results and limitations to ACs in ticket-scoped BMAD evidence. Keep unrelated dirt untouched; isolated branch/worktree; one implementer via codex exec; fresh independent SPEC review then fresh independent QUALITY review. PM writes no code and does not approve merges.
7. After independent gates, deliver through the established vault-backed signed Play internal-testing path only: fresh unconsumed versionCode, verified package/manifest/AAB hash/upload certificate, actual Console track readback. No public-track promotion/category disguise. Report emulator verification, signed-distribution verification and physical Civic verification separately. Physical re-check not available to agents is an explicit outstanding item, never inferred from old photo or emulator success.

## Final behavior and changed files

- `apps/auto/app/src/main/java/sh/delo/holocene/auto/MainActivity.kt`: distinct truthful Home, Diagnostics, About/privacy; one filled voice action; provider/permission/host/foreground/busy gates; explicit permission request; native Back on both API 32 and API 33+ paths; dp/sp controls, theme colors and host window insets. Existing recognizer, PCM capture, acknowledgement, timers and generation checks remain in place. Capture resources detach before teardown, and stale focus callbacks check generation and request identity. Raw results stay in Diagnostics; passive navigation retains the last result.
- `apps/auto/app/src/main/java/sh/delo/holocene/auto/AutoSurface.kt`: pure presentation/navigation/lifecycle boundary used by the actual Activity. Every navigation/pause/destroy/restricted boundary releases resources and invalidates active generations; idle transitions retain diagnostic results.
- `apps/auto/app/src/test/java/sh/delo/holocene/auto/AutoSurfaceTest.kt`: 16 focused tests for the host/provider/permission matrix, navigation, Back, pause/destroy, capture/playback half duplex, stale generations, restricted/unknown host, privacy policy gating and result retention.
- `apps/auto/tools/capture_auto_ui.py`: actual adb screencap only, installed-vs-built APK SHA256 parity, resumed activity check, version/package/serial/user/viewport/density/font/build/inset provenance, no overwriting prior evidence. Explicit system-dialog captures are marked and excluded from unobscured layout acceptance.
- `apps/auto/tools/emulator_probe.py`: existing probe navigation/permission labels adapted to Diagnostics; canned preview remains covered by the harness. Its audio smoke flow was not invoked in this run.
- This ticket-scoped BMAD file is the only tracked evidence change. Generated build output, reports, caches and PNGs remain ignored; durable copies are in the spool.

## Checks on the final source

From `apps/auto`, with `ANDROID_HOME=/home/delorenj/Android/Sdk` and `JAVA_HOME=/home/delorenj/.local/share/android-studio/jbr`:

```sh
./gradlew testDebugUnitTest lintDebug assembleDebug --console=plain --max-workers=1 --rerun-tasks --no-daemon -Dorg.gradle.jvmargs='-Xmx1024m -Dfile.encoding=UTF-8' -Pkotlin.compiler.execution.strategy=in-process
python3 -m unittest discover -s tools/tests -v
python3 -m py_compile tools/capture_auto_ui.py tools/emulator_probe.py
git diff --check
```

Android: PASS, 49 tasks freshly executed in 22 seconds; 46 tests, zero failures/errors/skips. Lint: zero errors, four warnings in unchanged platform/manifest or existing TTS reflection concerns. APK built successfully. Logs: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/android-check-final.log; /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/artifacts/TEST-*.xml; /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/artifacts/lint-results-debug.xml.

Python tooling: 44 tests PASS, four environment-dependent skips (actual legal-feed input, cold Gradle archive inputs, installed gRPC harness environment). Log: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/python-tooling-final.log. Syntax checks PASS. Android checks were rerun after each affected source change; earlier logs are retained. API/web deployment and pnpm lint stubs are not applicable.

Lint warnings: OldTargetApi: Not targeting the latest versions of Android; compatibility modes apply. Consider testing and updating this version. Consult the `android.os.Build.VERSION_CODES` javadoc for details.; PrivateApi: Accessing internal APIs via reflection is not supported and may not work on all devices or in the future; DataExtractionRules: The attribute `android:allowBackup` is deprecated from Android 12 and may be removed in future versions. Consider adding the attribute `android:dataExtractionRules` specifying an `@xml` resource which configures backups and device transfers on Android 12 and higher.; MissingApplicationIcon: Should explicitly set `android:icon`, there is no default; SetTextI18n: Do not concatenate text displayed with `setText`. Use resource string with placeholders.; SetTextI18n: String literal in `setText` can not be translated. Use Android resources instead.; SetTextI18n: String literal in `setText` can not be translated. Use Android resources instead.; SetTextI18n: String literal in `setText` can not be translated. Use Android resources instead.

## Authentic screenshots and provenance

Final APK: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/artifacts/holocene-auto-holoc12-debug.apk. SHA256 `87acfe992bd804c42a28bc3712a5d9ebd6dc9536e43bcc783ff952e64c52535e`. Package `io.automaticai.holocene`, versionCode 8, versionName `0.2.6-internal`, min SDK 32, target/compile SDK 35. This is a debug artifact, not a signed Play release. Version 8 is already consumed for Play; a later upload requires a fresh, independently verified versionCode.

Existing AVD: HOLOC_9_Honda_API33, worker-owned serial emulator-5588, console 5588, gRPC 8588, foreground user 10, Android API 33. Runtime 5 PID 2411755; command and boot evidence: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/runtime5/runtime-start.json and runtime-booted.json. Every final image is native `adb exec-out screencap -p`; its adjacent JSON records package/version/serial/viewport/font scale and verifies the installed base.apk hash equals the final build. /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshot-manifest.json indexes all final captures and their hashes.

- Honda representative home: [1280x720 home](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-honda-home.png), font scale 1.0, density 160. All app-owned home controls and status fit; host top/side bars remain intact.
- Second configuration: [1024x640 home](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-constrained-home.png), font scale 1.15, density 160, same authentic Honda top/side bars. App-owned title/status/actions fit and labels wrap without truncation. The Honda clock/avatar are clipped by Honda's own fixed bar in this artificial narrower viewport; app code does not modify that chrome.
- [Diagnostics](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-honda-diagnostics.png), [constrained Diagnostics controls](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-constrained-diagnostics.png), [canned preview](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-canned-preview.png), [screen cancel](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-screen-cancel.png), [raw fixture/provider evidence](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-fixture-evidence.png), [About/privacy](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-constrained-about.png). Diagnostics is intentionally a native scrolling secondary screen; long evidence and controls can be brought fully into view. Scroll-edge portions of content are not claims that all diagnostics fit simultaneously.
- [Permission dialog](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-permission-dialog.png), [ended check on home](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-home-check-ended.png), [retained result after Back/reopening Diagnostics](/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/screenshots/final-retained-result.png). Permission was granted through the actual Android dialog, never with `pm grant`; permission grant did not automatically start capture.

Earlier images without the `final-` prefix are iteration evidence only. Some show an inherited 800x1280 guest override, an OS device-connect dialog or a frame captured before navigation settled; none is used as final AC5 acceptance. The operator photo is launch evidence only; it provides no installed-version proof.

## Runtime safety, resource budget and limitations

No emulator occupant or ADB device existed at startup. Each launch verified free ports and no existing AVD process. Runs were read-only/no-snapshot; no AVD definition, SDK image or license receipt was changed. The config.ini SHA256 stayed `aa3a8223634a8a43e0943cb5bcf8a33012f0edd54434d22c9c0ce49bda696aa6`.

The scope's kernel `memory.max` stayed 4294967296 (4 GiB). Early host-GPU launch could not initialize without DISPLAY; a headless attempt stopped at the conservative total-memory guard because it counted reclaimable file cache. A measured subsequent attempt booted but hit 3.3 GiB pinned after app/viewport changes. The final configuration used `-no-window -no-audio -read-only -no-snapshot -gpu swiftshader -feature -Vulkan -memory 1024 -qemu -m 1536`, two cores, same 4 GiB kernel cap and a 3.3 GiB pinned-memory guard sampled every 100 ms. Guest MemTotal was 1497196 kB in the same final configuration. Runtime 5 booted in 24.6 seconds, peaked at 2837774336 pinned bytes / 2563624960 emulator RSS, and stopped by worker request; OOM and OOM-kill counters remained zero. Full accounting is in runtime1–runtime5 memory-samples/outcome logs, not inferred from RSS alone.

The final APK's PID 4420 obtained exclusive capture focus, started AudioRecord, received the public MEDIA_STOP event at elapsed 106847 ms, cancelled the generation, released resources at 106912 ms (65 ms), and ignored the late microphone callback at 106917 ms. No audio was persisted or uploaded; host audio was disabled and no ASR/room-mic/hostmicon test ran. Back returned to Home, idle navigation preserved that actual stop result, and screen Cancel cleared the canned preview. Runtime log: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/runtime5-app.log; commands: /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/runtime-actions.jsonl. Runtime 4 separately observed active-mic Back cancellation and a late 4800-sample callback; that is iteration evidence, not a claim about the final APK's bytes.

Actual device-level host restriction injection remains BLOCKED. A current read-only `cmd car_service help` returned SecurityException: “The command 'help' requires non-user build” (/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/restriction-command-capabilities.log). No permission bypass or injected physical proof was attempted. Restricted/unknown transitions and playback/capture half-duplex/stale callbacks have deterministic JVM evidence; this run did not freshly exercise ASR/TTS end to end or device focus-loss injection. HOLOC-10's partial diagnostic acceptance and HOLOC-11's missing real-agent integration remain open. API 32 Back/library guards are source/lint checked here; runtime screenshots are API 33, not a fresh API 32 hardware test.

Physical Civic verification is **OUTSTANDING**. No physical ADB device was attached; exact installed Civic version remains UNKNOWN. This run's emulator debug artifact, a future vault-backed signed internal-distribution artifact, and the physical Civic installation are three separate verification boundaries. One Android SystemUI resource exception occurred at emulator cold startup outside the Holocene process; no Holocene crash was observed in the exercised paths.

## Isolation and no-action boundaries

Only the isolated source worktree and authorized ignored spool were written. Main's modified bloodbank-events.jsonl, deleted ss.png and untracked _bmad-output/holoc11 remain untouched. The HOLOC-10 sibling worktree was never used. No extra implementer/reviewer was spawned. No provider/fleet/gateway/credential/agent/hook configuration changes; no independent LLM probes; no secrets or vault access; no default-assistant change; no live backend/broker/Vox integration; no event publication; no Plane state/comment/label writes; no self-approved gates; no merge/push/signing/store operations.

Inference identity and the matching verified AutomaticAI request receipt are in /home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-12/worker-identity.json; that receipt verifies its matching request, not every request in the session.

## Next owner action

PM: fresh independent SPEC review of BASE_SHA..implementation SHA, then fresh independent QUALITY review. Keep review gates open until those independent outcomes exist. After both pass, arrange scoped integration/push and the established vault-backed signed Play internal-testing workflow with a fresh unconsumed versionCode, manifest/package/AAB hash/certificate checks and actual track readback. Arrange an operator re-check on the Civic; do not infer it from these images or the old photograph.
