# Holocene Auto: consistent parked/driving layout

Author: holocene-pm
Request: operator voice memo, 2026-11-11 (America/New_York).

## Verified source findings

- `apps/auto/app/src/main/java/sh/delo/holocene/auto/HostUx.kt:51-57`: `PadModes.of` selects DRIVING for a car that is not provably unrestricted; Diagnostics remains parked-only.
- `AgentPad.kt:82-85,303-307`: passes the real mode and host restrictions to the web page. `driving` also prevents runtime microphone permission dialogs (`351-357,501-505`). Do not falsify that flag to get a different visual layout.
- `apps/agent-pad/src/main.tsx:1893`: driving mode applies an app-imposed five-agent limit via `driveTiles`, further reduced by positive host maxItems.
- `main.tsx:1902-1911`: driving adds a separate oversized hero and `drive` class.
- `main.tsx:2048-2074`: `.drive` CSS forces one row, makes the bar grow and the recording button fill its height, and hides `.status`, `.unlock`, and `.silent`.
- `DriveControls.kt`: wheel/rotary state machine, debounce, recording/arming selection lock and protected keys. It does not select the visual layout.
- No dedicated `toast` component was identified in the inspected source. The parked `.status` area is an aria-live status region; the operator's observed toast notifications still need device-level identification.

## Implementation acceptance criteria

1. Use the same responsive grid and bounded record-control sizing in parked and driving modes, without the driving-only oversized hero/bar overrides.
2. Retain truthful DRIVING/host UX state. Do not report PARKED, zero the restriction mask, change trusted-installer behavior, or bypass OS restrictions.
3. Remove the arbitrary five-agent cap, retaining host content/label limits when active, and preserve selected/replying agent visibility. Unknown restricted hosts remain conservative; a host with LIMIT_CONTENT and no positive item count needs an explicit conservative bound rather than an unlimited fallback.
4. Show concise permitted operational status in both modes, excluding restricted transcript/message content when noText is active. Do not blindly expose the parked status region: it contains diagnostics, memo/reply keys and arbitrary status strings. Confirm the actual notifications on the device.
5. Preserve motion suppression/no-video behavior, parked-only Diagnostics/setup and permission prompts, protected wheel keys, recording recipient lock, arming and pause/cancel behavior.
6. Test parked, DRIVING with no content restriction, positive content/label limits, fully restricted/unknown hosts, mid-recording transitions, selected/replying visibility, status filtering and motion suppression. Include browser-rendered geometry/interactions; existing pure helper tests do not prove CSS layout parity.
7. Preserve existing silent-audio handling (currently mode-dependent) unless explicitly changing and testing that separate policy. A visual unification must not accidentally alter audio delivery behavior.

## Executed baseline verification

- `node --test apps/agent-pad/src/*.test.ts`: 75 tests passed; zero failures, cancellations or skips.
- From `apps/auto`: `ANDROID_HOME=${ANDROID_HOME:-$HOME/Android/Sdk} ./gradlew testDebugUnitTest lintDebug assembleDebug --console=plain`: BUILD SUCCESSFUL (33 seconds).
- Parsed JUnit XML: 200 tests in 20 suites; zero failures/errors/skips.
- Existing compiler warning: MainActivity.kt:883 overrides a deprecated member without a deprecation annotation.
- Debug APK: `apps/auto/app/build/outputs/apk/debug/app-debug.apk`, 2,693,398 bytes, SHA-256 `15625f0deb183866ed6bbf82fc1c43151ae38589cdd0bf0a6136d45b3528da1a`. This is the unchanged baseline, not a fixed release.
- Agent Pad Vite production build succeeded (26 modules) with output redirected to `$TMPDIR/holocene-pad-layout-audit-build`; live `apps/agent-pad/dist` was not touched.
- `adb devices -l`: no connected devices. No on-device visual or interaction proof was obtained.

## Delivery boundaries

- `apps/auto/tools/pad_build.sh` runs Vite into `apps/agent-pad/dist`; its own source documents this as an immediate production deployment. Do not use it as a supposedly local check. Build to a scratch outDir instead.
- The native WebView loads `https://agent-pad.delo.sh/`; web-only visual fixes can take effect without a new Android binary. Changes to Kotlin/native host behavior need the established signed Play internal-testing path.
- `apps/auto/tools/build_release_bundle.sh` retrieves signing inputs from 1Password and builds the AAB. Current checked-out native version is 13 / 0.2.11-internal; source version alone does not establish the latest Play version.
- No application code changes, new regression tests, worker invocation, independent review, release, installation, push, service restart or live deployment were performed in this pass. Existing unrelated checkout changes were preserved.
- PM role forbids direct application-code changes; the continuation explicitly prohibits delegation. Implementation cannot proceed under that combination. Do not label the request delivered based on passing baseline checks.
- Board read confirmed HOLOC binding and no identically titled existing ticket. No ticket mutation/claim was performed. The repo-local `.scripts/momo-wip-lock.py` entrypoint is absent; a canonical helper exists under `~/code/33GOD/momo/skill/scripts/` but was not invoked.

Decision rationale: Pillar 2 (Dogfood the Platform) favors repairing the existing Agent Pad rather than a second UI; Pillar 3 and its Rule of Three favor a single responsive layout with host policy kept separate, without speculative framework work.
