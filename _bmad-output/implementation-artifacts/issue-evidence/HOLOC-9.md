# Evidence: HOLOC-9 — Honda 9-inch AAOS feasibility

## Issue
- Ticket: HOLOC-9; child owner: Holocene.
- Milestone / horizon: bounded Honda emulator feasibility; parent `33GOD:I-2.1`. CAP-1 through CAP-8 remain product requirements.
- Worker: opencode-holoc-9-recovery-1 (automaticai personal sol carrier).
- Orchestrated by: momo.
- Request: `/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-9/dispatch.md:38–48`; parent authoritative `_bmad-output/specs/spec-holocene-auto/SPEC.md` and its three companions. SDK authorization `c6ed9929df55b3db34d1c716745cd1e17c0eb13a`; corrected spec `fbf6bb387b950b08c8c9ae93f7fc916106df2c8f`.
- Current authorization: focused source remediation of the three reproduced tooling findings, scoped tests/evidence and feature-only commit/push. This same sole implementer has no board, main-merge, deploy, live SDK/AVD repair or product-feature authority. Independent focused quality rereview remains required.
- Detailed source evidence: [holoc-9-feasibility-evidence.md](../holoc-9-feasibility-evidence.md), updated for tooling repairs; child BMAD plan: [holoc-9-recovery-plan.md](../holoc-9-recovery-plan.md), preserved.
- Independent specification review: `/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-9-recovery-1/spec-review.md:1–127`, PASS for all five bounded criteria, expressly separate from code-quality approval and driving acceptance.

## Acceptance Criteria
1. **Delivered; independent spec PASS.** Reproducible native Kotlin fixture build, checksum-qualified Honda image setup, install and launch identify tooling/API/ABI/revision. Two read-only harness fixtures and bounded lifecycle/tool/message/unrecognized-event presentation are explicitly synthetic; previews cannot publish. Initial shared-library install failure and its corrected manifest requirement are recorded. Independent cold install/launch on serial `emulator-5582` reproduced the exact APK; reviewer stopped its emulator.
2. **Delivered assessment; independent spec PASS.** Actual category eligibility, Automotive testing/distribution/device compatibility and Civic installation are separate gates. Category-eligible in-app CarAudioRecord and genuine VIA/default-assistant integration are independent branches. No established legitimate category fit is claimed, and no software-agent-as-IoT, speech-as-media, navigation/messaging disguise or host bypass exists. Internal testing has no car form-factor review; closed review is non-blocking; neither establishes eligibility or privileges. No Play upload or vehicle install occurred.
3. **Delivered capability ledger and reproduced limitations; independent spec PASS for this spike.** Explicit app launch, public unrestricted UX callback, runtime microphone grant, focus acquisition/release and bounded silent PCM capture are demonstrated. ASR reached provider-ready then ERROR_NO_MATCH=7, without a final transcript. Parked screen cancel and independent in-flight mic/ASR pause cancellation are demonstrated, not hands-free voice cancel. ACTION_ASSIST fails resolution; injected voice key provides no active-session proof. Role available=true/held=false, Google remains selected. Moving UX injection is blocked by the Honda user-image SecurityException; call/navigation focus loss, spoken confirmation and non-screen capture/stop require further proof. Zero-screen driving remains mandatory.
4. **Delivered current read-only owner assessment; independent spec PASS.** Holocene/Bloodbank/Candystore identity and source freshness joins, dedicated runtime logical-route continuity, processing-versus-answer receipts, authenticated mobile ingress, HeyMa/infra ASR and Voxxy synthesis/playback/cancel are source-backed. Finalized canonical Wax transcript fields now exist; the older missing-fields claim is superseded. Gateway post-claim rejection closure improved, but answer content is still discarded. Narrow owner requests are recorded; sibling sources were not changed.
5. **Delivered handoff; independent spec PASS.** Child plan, detailed evidence, exact reviewed application range, artifact identity, route decision and owner next actions are retained. Emulator feasibility is demonstrated; distribution confirmation, Civic installation, live integration and verified driving usability remain separate beyond-spike gates. CAP-8 is not closed. Independent quality evidence is still required before an acceptance recommendation.

## Repo Changes
- Branch: `holoc-9-aaos-feasibility`; worktree `/home/delorenj/code/33GOD/holocene/.worktrees/holoc-9-aaos-feasibility`.
- Reviewed application BASE: `1c0d76009ac757508584ba494112ecc1b3555a7f`.
- Previously reviewed application HEAD: `13e040f374c6ea4b789e16054f2061172510a0c8`; both independent reports are locked to that range.
- Patched application HEAD: `8a5aa9ac0cb6ee2bd2926c115e9de85647fdc6e5`; focused remediation range `13e040f374c6ea4b789e16054f2061172510a0c8` → `8a5aa9ac0cb6ee2bd2926c115e9de85647fdc6e5`. Source/tests are published on the feature branch. The following documentation checkpoint records this exact code range without claiming independent quality acceptance.
- The previous specification PASS is not a quality acceptance of the new patch. Independent focused quality rereview must use the published patch commit and its exact diff.
- Reviewed application changes:
  - `apps/auto/` — isolated native Kotlin/platform diagnostic app, fixture state tests, Android manifest/resources, pinned Gradle wrapper/plugins and emulator/image tools.
  - `mise.toml` — four bounded Android task entrypoints.
  - `_bmad-output/implementation-artifacts/holoc-9-recovery-plan.md` and `holoc-9-feasibility-evidence.md` — child plan and detailed findings.
- Focused repairs: `apps/auto/gradle/wrapper/gradle-wrapper.properties` correct64 pin; `apps/auto/tools/install_honda_image.py` fail-closed staged payload/member verification and selected SDK-normalized license; `apps/auto/tools/tests/` stdlib/JVM regressions; `mise.toml` tooling tests in auto:check and dedicated test task; detailed evidence and this canonical document.
- Android Kotlin/resources/manifest, incumbent APIs, host SDK/receipt and AVD remain unchanged.
- Migrations / schema: none. No incumbent API/web source or workspace dependency refactor, sibling/root source change, production deploy, board mutation or default-assistant change.

## Verification
- Focused tooling repair verification: **21 stdlib tests, zero failures/errors/skips**. Official64 Gradle pin matches the published checksum and the retained official ZIP. The exact wrapper verifier and isolated offline cold wrapper start succeed; no extracted host cache bypass explains these results.
- Installer regressions prove complete fresh staging, idempotent all-member matching rerun unchanged, partial system.img refusal, preserved preexisting ramdisk, same-size content/metadata conflict refusal, interrupted-stage cleanup, checksum/path/symlink/incomplete archive refusal before SDK mutation and acceptance-flag enforcement. Every payload file, including non-required members, is checked before unchanged success.
- Actual installed SDK JAXB parser/License.checkAccepted on temporary fake SDKs returns true for both selected saved-feed and generated-package license, actual-Honda hash `6adc41d89657f43cd09a826aa4e383d8bf4208e4`. CR references preserve legal text semantically; unrelated license is not accepted and existing receipt bytes are not overwritten. Historical host Honda receipt remains untouched and is not claimed corrected.
- Reproduction from apps/auto: `JAVA_HOME=<jbr> ANDROID_HOME=<sdk> HOLOCENE_HONDA_FEED=<saved-feed> HOLOCENE_GRADLE_ZIP=<verified-zip> /usr/bin/python3 -B -m unittest discover -s tools/tests -v`. Evidence: recovery spool `repair-tool-tests-final.log`, `gradle-official.sha256`, `gradle-8.11.1-bin.zip`. Without optional actual-file inputs, three integration tests explicitly skip; this executed run supplied both and skipped none.
- Repair reruns: ten Android JVM tests, substantive Android lint zero errors/six warnings, APK build; nine uncached TS checks plus direct API/web checks; pnpm lint remains nine stubs. Logs: `repair-android-checks.log`, `repair-typecheck.log`, `repair-api-typecheck.log`, `repair-web-typecheck.log`, `repair-pnpm-lint.log`. Exact APK hash below is unchanged. No emulator repeat for tooling-only changes; earlier independent runtime proof remains distinct.
- Existing implementer execution: `./gradlew tasks --all`; `./gradlew testDebugUnitTest lintDebug assembleDebug --rerun-tasks --console=plain` succeeded. Ten Android JVM tests, zero failures/errors/skips; substantive Android lint passed with six warnings and zero errors; debug APK built.
- Existing TypeScript execution: nine cache-bypassed checks via `pnpm exec turbo run typecheck --force`, plus direct API/web typechecks passed after local ignored declaration builds. `pnpm exec turbo run lint --force` completed nine placeholder scripts; this is not substantive lint evidence.
- Parent reports independent reruns of ten Android tests/lint/build, the same APK hash, nine uncached TypeScript checks, direct API/web checks and 89 contract tests. The 89 contract tests are parent execution evidence, not additional implementer execution; no command or result is fabricated here.
- Independent spec review inspected source, artifact identity and test XML, then cold installed/launched on `emulator-5582`, observed all four event kinds and fixture preview, reproduced silent mic/no-match ASR and actual in-flight pause cancellation. It independently reproduced user-build UX injection denial. Its serial was stopped; original implementer serial `emulator-5580` was also stopped at handback.
- PNGs exist, with valid dimensions corroborated by the reviewer; visual input is unsupported. XML/control-state evidence does not constitute aesthetic approval.
- Toolchain: Gradle 8.11.1 with distribution checksum, AGP 8.9.2, Kotlin 2.1.20, JUnit 4.13.2; Studio JBR 21.0.10; SDK command-line tools20, emulator36.5.10, platform-tools37.0.0, build-tools35.0.0.
- Image: official Honda `system-images;android-33;Honda-ivi-9inch-LHD`, API33/x86_64, feed revision `25.03.120114`. Archive size2723426521 bytes/SHA1 `c1862179041240cf9a698bd5ee716eba68769824`; archive `Pkg.Revision=1` preserved and separately disclosed. This is not exact Civic firmware.
- AVD: `/home/delorenj/.android/avd/HOLOC_9_Honda_API33.avd`; name `HOLOC_9_Honda_API33`, Honda9-inch LHD, 1280×720/density160. Existing phone AVD unchanged.
- Exact build APK: `/home/delorenj/code/33GOD/holocene/.worktrees/holoc-9-aaos-feasibility/apps/auto/app/build/outputs/apk/debug/app-debug.apk`.
- Retained identical APK: `/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-9-recovery-1/holocene-auto-fixture.apk`.
- APK SHA256: `88f74c255a50d91b87b100cf4d4c5fa03ba656f68673ee7f93d9a69328ad5381`; application ID `sh.delo.holocene.auto.feasibility`, versionCode1/versionName `0.1.0-fixture`, min/target/compile API33, debug-signed. No network publication capability or broker/engine credentials.
- Durable ignored evidence root: `/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-9-recovery-1/`. Records include `android-checks-final.log`, `android-test-results.xml`, `android-lint-results.xml`, `pnpm-typecheck-final.log`, `api-typecheck-2.log`, `web-typecheck-2.log`, `pnpm-lint-final.log`, `emulator-probe-commands.json`, `mic-asr-probe.log`, `ux-transition-attempt.log`, `checks-summary.txt`, PNG/XML fixtures and `spec-review.md`. The original `workers/HOLOC-9` bundle remains untouched.
- Reproduction commands below document the original emulator work; no emulator/SDK/AVD action was performed during this tooling remediation. From the reserved worktree, after confirming no emulator owns the named AVD or port:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export JAVA_HOME="$HOME/.local/share/android-studio/jbr"
W=/home/delorenj/code/33GOD/holocene/.worktrees/holoc-9-aaos-feasibility
E=/home/delorenj/code/33GOD/holocene/agents/hermes/pm/runtime/workers/HOLOC-9-recovery-1
"$W/apps/auto/gradlew" -p "$W/apps/auto" tasks --all
"$W/apps/auto/gradlew" -p "$W/apps/auto" testDebugUnitTest lintDebug assembleDebug --rerun-tasks --console=plain
"$ANDROID_HOME/emulator/emulator" -avd HOLOC_9_Honda_API33 -port 5580 -no-window -no-audio -no-snapshot -no-metrics -gpu swiftshader_indirect -memory 4096 -cores 4
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 wait-for-device
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 install -r "$W/apps/auto/app/build/outputs/apk/debug/app-debug.apk"
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 shell am start -W -n sh.delo.holocene.auto.feasibility/sh.delo.holocene.auto.MainActivity
/usr/bin/python3 "$W/apps/auto/tools/emulator_probe.py" --adb "$ANDROID_HOME/platform-tools/adb" --serial emulator-5580 --evidence "$E"
"$ANDROID_HOME/platform-tools/adb" -s emulator-5580 emu kill
pnpm --filter @holocene/org-model --filter @holocene/bloodbank-client build
pnpm exec turbo run typecheck --force
pnpm --filter @holocene/api typecheck
pnpm --filter @holocene/web typecheck
pnpm exec turbo run lint --force
```

- Emulator boot is a long-lived process; perform subsequent commands in a separate terminal only after boot completion. Image/license setup commands and official feed/archive provenance are in the detailed evidence; do not reinstall or overwrite another AVD during review.
- AC1 → exact artifact/toolchain, build/test/lint records, independent cold launch and labeled fixture XML. AC2 → detailed route/distribution assessment and independent spec AC2. AC3 → mic/ASR/permission logs, blocked activation/UX evidence and independent spec capability ledger. AC4 → detailed owner-qualified source table and independent source reread. AC5 → child references, application provenance and explicit stage-separated handoff.

## Ledger Update
- Ledger updated: yes
- Parent-reported actual board QA update and Bloodbank decision: `d2e53c61-60f8-4786-acdd-b8227f524903`.
- Request reference: original `workers/HOLOC-9/dispatch.md:38–48`, backlink `33GOD:I-2.1`, and the parent's documentation-only normalization request associated with that QA/decision receipt.
- Attribution: momo owns the board/decision write and evidence readback. This implementer performs no ledger mutation or new board query; the existing receipt is supplied by the parent, not an inferred write. Parent-directed QA-to-implementation recovery is separate from the retained QA receipt.

## Known Gaps
- Independent quality review held HEAD13e040f for three tooling findings. The focused repairs now pass their regression checks, but independent focused rereview has not accepted the resulting patch. Specification PASS alone is not code-quality approval, acceptance, merge or close authority.
- Real intentional speech, endpointing/final ASR and latency are not demonstrated. Microphone permission, silent PCM acquisition and focus do not prove speech recognition or a conversational loop.
- Supported non-screen activation/capture, verbal frozen-target confirmation and non-screen stop/mute/cancel remain undetermined. Screen controls and Home/pause are diagnostic evidence only.
- Moving host UX callbacks, actual concurrent call/navigation focus loss, playback interruption and echo prevention require supported Honda/OEM tests. User-build shell injection denial is a reproduced limitation, not permission to bypass restrictions.
- Legitimate product category, OEM VIA qualification/selection/grants, Automotive Play/device eligibility, target-policy compliance and actual Civic firmware/install remain separate confirmation gates. No default switch, upload or vehicle change occurred.
- Final correlated agent-answer publication, authenticated mobile ingress, truthful runtime/session/freshness joins, declared continuity and live Vox synthesis/playback/cancellation remain owner integration gates. Wax finalized transcript fields exist; mobile start/correlation and short-utterance integration still require proof.
- These are explicit beyond-spike product gates, not concealed incomplete acceptance of the bounded feasibility assessment. All five spike criteria have independent spec PASS; CAP-8 and the complete zero-screen driving loop remain open.
- Existing pnpm lint consists of placeholder scripts. Android lint is substantive but retains six disclosed warnings. Child `_bmad/scripts/render_skill.py` is absent; the attempted renderer failure is recorded, with no root-loop substitute or configuration repair. Mutation testing was not executed. Image viewing is unsupported; no aesthetic signoff.
- No placeholder evidence is used. Undetermined behavior is described as a limitation with its demonstrated boundary, owner and next proof.

## Close Recommendation
- Close recommendation: hold
- Rationale: canonical evidence records previous specification PASS, reproduced tooling defects and passing focused repairs; independent focused quality acceptance of the patched commit has not yet arrived. Do not set acceptance or close eligibility before that rereview.
- Expected gate result: hold because the required affirmative close recommendation is intentionally absent. The gate is neither weakened nor represented as passed.
- Next action: parent independently rereviews the exact published repair commit, resolves any further actionable finding through explicit authorization, then directs final evidence disposition. Seek category/OEM-VIA confirmation and narrow cross-owner seams for product progression; do not close CAP-8 from this spike.
