# HOLOC-11 Evidence: Physical Civic Walking Skeleton

## Local release artifact

Status: **LOCAL_SIGNING_READY**. This is not vehicle proof and not a Play upload.

- Source branch: `holoc-11-play-version-4`
- Built with: `mise run auto:release-bundle`
- Signing identity: `op://DeLoSecrets/Holocene Android Auto release signing/password`
- Keystore alias: `holocene-auto-release`
- Application ID: `io.automaticai.holocene`
- Version: `0.2.2-internal` (`versionCode=4`)
- SDK: compile/target API 35, minimum API 33
- AAB SHA256: `f495241f5da7982affaf535fd9a8d3f1fed04bac7a53af243459ce26e2d7e04d`
- Retained ignored runtime artifact: `agents/hermes/pm/runtime/workers/HOLOC-11-recovery-1/holocene-auto-release-f495241f.aab`

Play Console rejected the first local AAB because its app record requires package `io.automaticai.holocene`. The corrected application ID is `io.automaticai.holocene`; the Kotlin namespace remains `sh.delo.holocene.auto`, and the signed bundle manifest was inspected to confirm both values. Play then reported that `versionCode=3` was already consumed, so this upload uses `versionCode=4`. The prior `9a49b657` and `4eb560b8` artifacts are superseded and must not be uploaded again.

The build resolves the keystore attachment and password from DeLoSecrets into a private temporary directory, never stores either value in Git, and cleans the temporary signing material after Gradle finishes. A release build without all four signing environment values fails with an explicit missing-input error.

The API 35 target follows Google Play's current Android Automotive OS new-app requirement effective 2026-08-31: <https://support.google.com/googleplay/android-developer/answer/11926878>.

## Verification

- `mise run auto:release-bundle`: PASS, 49 Gradle tasks.
- Corrected signed APK inspection: application-id `io.automaticai.holocene`, version-code `4`, version-name `0.2.2-internal`.
- `jarsigner -verify`: `jar verified` (self-signed release identity, expected for this private testing identity).
- `ANDROID_HOME="$HOME/Android/Sdk" mise run auto:check`: PASS.
- Python tooling: 44 tests passed, 4 environment-dependent skips.
- Android: `testDebugUnitTest`, `lintDebug`, and `assembleDebug` passed.
- Unsigned `bundleRelease` invocation: failed closed with all four missing signing variables named.

## Remaining external gates

No Play Console app record, Automotive form-factor opt-in, internal-testing track, tester grant, device-catalog check, upload, or Civic install/launch has occurred. Honda states that actual-vehicle ADB is unavailable, so those steps must use the head unit's Google Play path rather than a sideload assumption.
