# HOLOC-11 Evidence: Physical Civic Walking Skeleton

## Local release artifact

Status: **LOCAL_SIGNING_READY**. This is not vehicle proof and not a Play upload.

- Source branch: `holoc-11-play-package-id`
- Built with: `mise run auto:release-bundle`
- Signing identity: `op://DeLoSecrets/Holocene Android Auto release signing/password`
- Keystore alias: `holocene-auto-release`
- Application ID: `io.automaticai.holocene`
- Version: `0.2.1-internal` (`versionCode=3`)
- SDK: compile/target API 35, minimum API 33
- AAB SHA256: `4eb560b8f11a5e77829dd908f35d362a4ce506999ca7d9789d781c0118632cdd`
- Retained ignored runtime artifact: `agents/hermes/pm/runtime/workers/HOLOC-11-recovery-1/holocene-auto-release-4eb560b8.aab`

Play Console rejected the first local AAB because its app record requires package `io.automaticai.holocene`. The corrected application ID is `io.automaticai.holocene`; the Kotlin namespace remains `sh.delo.holocene.auto`, and the signed bundle manifest was inspected to confirm both values. The prior `9a49b657` artifact is superseded and must not be uploaded to that app record.

The build resolves the keystore attachment and password from DeLoSecrets into a private temporary directory, never stores either value in Git, and cleans the temporary signing material after Gradle finishes. A release build without all four signing environment values fails with an explicit missing-input error.

The API 35 target follows Google Play's current Android Automotive OS new-app requirement effective 2026-08-31: <https://support.google.com/googleplay/android-developer/answer/11926878>.

## Verification

- `mise run auto:release-bundle`: PASS, 49 Gradle tasks.
- Corrected manifest inspection: `io.automaticai.holocene` and `sh.delo.holocene.auto.MainActivity` present.
- `jarsigner -verify`: `jar verified` (self-signed release identity, expected for this private testing identity).
- `ANDROID_HOME="$HOME/Android/Sdk" mise run auto:check`: PASS.
- Python tooling: 44 tests passed, 4 environment-dependent skips.
- Android: `testDebugUnitTest`, `lintDebug`, and `assembleDebug` passed.
- Unsigned `bundleRelease` invocation: failed closed with all four missing signing variables named.

## Remaining external gates

No Play Console app record, Automotive form-factor opt-in, internal-testing track, tester grant, device-catalog check, upload, or Civic install/launch has occurred. Honda states that actual-vehicle ADB is unavailable, so those steps must use the head unit's Google Play path rather than a sideload assumption.
