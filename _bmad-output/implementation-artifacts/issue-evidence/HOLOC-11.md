# HOLOC-11 Evidence: Physical Civic Walking Skeleton

## Local release artifact

Status: **LOCAL_SIGNING_READY**. This is not vehicle proof and not a Play upload.

- Source branch: `holoc-11-physical-civic-skeleton`
- Built with: `mise run auto:release-bundle`
- Signing identity: `op://DeLoSecrets/Holocene Android Auto release signing/password`
- Keystore alias: `holocene-auto-release`
- Application ID: `sh.delo.holocene.auto.feasibility`
- Version: `0.2.0-internal` (`versionCode=2`)
- SDK: compile/target API 35, minimum API 33
- AAB SHA256: `9a49b65790c0df8f7fffc3d09a27e17a734e20e7acfe41226353a45a51cc51ac`
- Retained ignored runtime artifact: `agents/hermes/pm/runtime/workers/HOLOC-11-recovery-1/holocene-auto-release-9a49b657.aab`

The build resolves the keystore attachment and password from DeLoSecrets into a private temporary directory, never stores either value in Git, and cleans the temporary signing material after Gradle finishes. A release build without all four signing environment values fails with an explicit missing-input error.

The API 35 target follows Google Play's current Android Automotive OS new-app requirement effective 2026-08-31: <https://support.google.com/googleplay/android-developer/answer/11926878>.

## Verification

- `mise run auto:release-bundle`: PASS, 49 Gradle tasks.
- `jarsigner -verify`: `jar verified` (self-signed release identity, expected for this private testing identity).
- `ANDROID_HOME="$HOME/Android/Sdk" mise run auto:check`: PASS.
- Python tooling: 44 tests passed, 4 environment-dependent skips.
- Android: `testDebugUnitTest`, `lintDebug`, and `assembleDebug` passed.
- Unsigned `bundleRelease` invocation: failed closed with all four missing signing variables named.

## Remaining external gates

No Play Console app record, Automotive form-factor opt-in, internal-testing track, tester grant, device-catalog check, upload, or Civic install/launch has occurred. Honda states that actual-vehicle ADB is unavailable, so those steps must use the head unit's Google Play path rather than a sideload assumption.
