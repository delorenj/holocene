# HOLOC-11 Evidence: Physical Civic Walking Skeleton

## Local release artifact

Status: **PLAY_UPLOAD_PENDING_V6**. The dedicated-AAOS-track feature error is resolved for the v6 bundle; the upload needs to be retried in the console.

- Source branch: `holoc-11-play-version-6` (local, unpushed)
- Built with: `mise run auto:release-bundle`
- Signing identity: `op://DeLoSecrets/Holocene Android Auto release signing/password`
- Keystore alias: `holocene-auto-release`
- Application ID: `io.automaticai.holocene`
- Version: `0.2.4-internal` (`versionCode=6`)
- SDK: compile/target API 35, minimum API 33
- AAB SHA256: `926b2a6b4538a3eb83c3d33305a1dd56a78844545486006bd8e48876ad9fe302`
- Retained ignored runtime artifact: `agents/hermes/pm/runtime/workers/HOLOC-11-recovery-1/holocene-auto-release-926b2a6b.aab`

Play Console rejected the first local AAB because its app record requires package `io.automaticai.holocene`. The corrected application ID is `io.automaticai.holocene`; the Kotlin namespace remains `sh.delo.holocene.auto`, and the signed bundle manifest was inspected to confirm both values. Play then reported that `versionCode=3` was already consumed, so this upload uses `versionCode=4`. The prior `9a49b657` and `4eb560b8` artifacts are superseded and must not be uploaded again. versionCode 4 was permanently consumed by Play when the bundle was dropped into a draft release (later discarded); drafts do not free consumed version codes, so the upload now uses versionCode 5.

The build resolves the keystore attachment and password from DeLoSecrets into a private temporary directory, never stores either value in Git, and cleans the temporary signing material after Gradle finishes. A release build without all four signing environment values fails with an explicit missing-input error.

The API 35 target follows Google Play's current Android Automotive OS new-app requirement effective 2026-08-31: <https://support.google.com/googleplay/android-developer/answer/11926878>.

## Verification

- `mise run auto:release-bundle`: PASS, 49 Gradle tasks.
- Signed AAB `bundletool dump manifest` inspection: application-id `io.automaticai.holocene`, version-code `6`, version-name `0.2.4-internal`, and `<uses-feature android:name="android.hardware.type.automotive" android:required="false"/>`.
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

### Resolution: feature requirement relaxed for v6

- The v5 dedicated-AAOS-track error was resolved by taking option (b): `android.hardware.type.automotive` now declares `android:required="false"` (`apps/auto/app/src/main/AndroidManifest.xml:2`), shipped in versionCode 6 / `0.2.4-internal` (AAB `926b2a6b`).
- Per Google's docs, bundles that **require** `android.hardware.type.automotive` are only allowed on the AAOS dedicated track; mobile tracks reject them regardless of form-factor opt-in (<https://developer.android.com/training/cars/distribute> — "Choose a track type for Android Automotive OS" restriction table). Relaxing `android:required` lets the same bundle pass mobile-track validation.
- Head-unit installability is kept: a non-required feature claim only softens the store-level "requires automotive hardware" filter; the AAOS form-factor opt-in remains in place and the app remains installable on the head unit.

## Remaining external gates

AAOS policy agreement (or manifest relaxation), successful internal-track release save + rollout, tester grant, device-catalog check, and Civic install/launch. Honda states that actual-vehicle ADB is unavailable, so install must use the head unit's Google Play path rather than a sideload assumption.
