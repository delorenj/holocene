# HOLOC-11 Evidence: Physical Civic Walking Skeleton

## Local release artifact

Status: **PLAY_UPLOAD_BLOCKED_AAOS_TRACK**. The bundle itself is accepted; the save is gated on Android Automotive OS track policy.

- Source branch: `holoc-11-play-version-5` (merged to `main`, 61a8c84, pushed)
- Built with: `mise run auto:release-bundle`
- Signing identity: `op://DeLoSecrets/Holocene Android Auto release signing/password`
- Keystore alias: `holocene-auto-release`
- Application ID: `io.automaticai.holocene`
- Version: `0.2.3-internal` (`versionCode=5`)
- SDK: compile/target API 35, minimum API 33
- AAB SHA256: `72bdb442a936a56210224804b4ce5220cd24ad717ee6c2f13166f69e0d1c261e`
- Retained ignored runtime artifact: `agents/hermes/pm/runtime/workers/HOLOC-11-recovery-1/holocene-auto-release-72bdb442.aab`

Play Console rejected the first local AAB because its app record requires package `io.automaticai.holocene`. The corrected application ID is `io.automaticai.holocene`; the Kotlin namespace remains `sh.delo.holocene.auto`, and the signed bundle manifest was inspected to confirm both values. Play then reported that `versionCode=3` was already consumed, so this upload uses `versionCode=4`. The prior `9a49b657` and `4eb560b8` artifacts are superseded and must not be uploaded again. versionCode 4 was permanently consumed by Play when the bundle was dropped into a draft release (later discarded); drafts do not free consumed version codes, so the upload now uses versionCode 5.

The build resolves the keystore attachment and password from DeLoSecrets into a private temporary directory, never stores either value in Git, and cleans the temporary signing material after Gradle finishes. A release build without all four signing environment values fails with an explicit missing-input error.

The API 35 target follows Google Play's current Android Automotive OS new-app requirement effective 2026-08-31: <https://support.google.com/googleplay/android-developer/answer/11926878>.

## Verification

- `mise run auto:release-bundle`: PASS, 49 Gradle tasks.
- Corrected signed APK inspection: application-id `io.automaticai.holocene`, version-code `5`, version-name `0.2.3-internal`.
- `jarsigner -verify`: `jar verified` (self-signed release identity, expected for this private testing identity).
- `ANDROID_HOME="$HOME/Android/Sdk" mise run auto:check`: PASS.
- Python tooling: 44 tests passed, 4 environment-dependent skips.
- Android: `testDebugUnitTest`, `lintDebug`, and `assembleDebug` passed.
- Unsigned `bundleRelease` invocation: failed closed with all four missing signing variables named.

## Play Console state (2026-10-03)

- v5 AAB (`holocene-auto-release-72bdb442.aab`) uploaded to the Internal testing draft via the console file input; Play processed it and shows `App bundle 5 (0.2.3-internal), API 33+, Target SDK 35`. Release name set to `5 (0.2.3-internal)`.
- Save is blocked at Preview-and-confirm with exactly one error: `APKs and bundles must not require following features: android.hardware.type.automotive. Some features can only be required in dedicated tracks.` The manifest declares `<uses-feature android:name="android.hardware.type.automotive" android:required="true" />` (`apps/auto/app/src/main/AndroidManifest.xml:2`).
- The Android Automotive OS form factor is already opted in (Advanced settings → Form factors → Android Automotive OS, dedicated-release-track mode saved). Its remaining checklist: upload AAOS store screenshots (optional), release an AAOS bundle to a testing track (link currently routes back to the same mobile internal-testing editor), and agree to the AAOS quality-guidelines policy review (locked).
- Non-blocking warning: no R8 deobfuscation file uploaded; ignorable for internal testing.
- Unblock options: (a) complete the AAOS policy agreement so AAOS-specific track selection unlocks, or (b) set `android:required="false"` on the automotive uses-feature so the bundle passes mobile-track validation (weaker claim, still installable on the head unit).
- versionCode 4 is permanently consumed; `f495241f` and all prior artifacts must never be re-uploaded.

## Remaining external gates

AAOS policy agreement (or manifest relaxation), successful internal-track release save + rollout, tester grant, device-catalog check, and Civic install/launch. Honda states that actual-vehicle ADB is unavailable, so install must use the head unit's Google Play path rather than a sideload assumption.
