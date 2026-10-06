# HOLOC-11 Evidence: Physical Civic Walking Skeleton

## Current head-unit compatibility repair (2026-10-06)

Status: **BUILD_VERIFIED_UPLOAD_BLOCKED**. Internal testing still serves version 7. Version 8 is signed and tested but has not been uploaded or published. Physical Civic installation and launch remain unverified.

### Demonstrated installation exclusion

- The enrolled tester's Play installation chooser marks Honda `IVI-SYSTEM` incompatible.
- Play Console's Honda `msmnile_au` catalog identifies the Android 12L / API 32 variant as unsupported by the app manifest. Its API 33 and 34 variants are supported.
- Version 7 / `0.2.5-internal` requires API 33. The physical vehicle's exact OS version has not been independently read; the registered Honda is incompatible and its API 32 catalog exclusion is demonstrated.
- Internal tester listing: <https://play.google.com/apps/internaltest/4701731390750096325>. Ordinary store search is not an acceptance check for this internal release.

### Version 8 artifact and source

- Application ID: `io.automaticai.holocene`
- Version: `0.2.6-internal`, version code `8`
- SDK: compile/target API 35, minimum API 32
- Signed AAB: `apps/auto/app/build/outputs/bundle/release/app-release.aab` (generated, not tracked)
- AAB SHA256: `f04dc636f897e5b3fa5e99d4506a05c01a87ff57f7a2df5b674c8325ab664c03`
- Upload certificate SHA256: `90d276cb82ddb16e72386c5d07c32de35396dc12723c61d9b9e5329703bfca17`
- Signing identity: `op://DeLoSecrets/Holocene Android Auto release signing/password`; secure signing wrapper resolves and removes temporary signing material.
- The provider query uses the compatible integer-flags overload. The API 33 speech-support preflight is guarded by SDK version; API 32 continues with normal recognition.
- Includes the already-published v7 source prerequisites: optional `android.car` library, isolated car-host adapter, fail-closed phone UI, and in-app privacy-policy access. These prerequisites were previously uncommitted.

### Validation and live propagation

- Single-worker Android `testDebugUnitTest lintDebug assembleDebug`: PASS (49 tasks).
- Python tooling: PASS (44 tests, 4 environment-dependent skips).
- API and web typechecks: PASS; web typecheck repeated after the policy edit.
- Secure signed release build: PASS; `jarsigner -verify`: verified.
- Bundletool inspected the signed AAB: version code `8`, minimum API `32`.
- Official API 32 AOSP ATD emulator: debug v8 installs and cold-launches successfully twice. Phone fallback renders with diagnostics disabled; no AndroidRuntime crash.
- Official Honda API 33 emulator: debug v8 installs and launches for foreground user 10. Car UX reports `requiresDO=false, mask=0; unrestricted=true`; rendered Honda UI shows fixture controls. No microphone capture was started. Both task-owned emulators were stopped after inspection.
- These emulator results cover the debug APK; they do not prove Play delivery or physical vehicle acceptance of the signed AAB.
- Live `holocene-web` was recreated through the owning parent `33god-platform` Compose service, is healthy, and serves the updated public policy at <https://holocene.delo.sh/auto/privacy>. Browser readback confirms version 8 and continued version 7/6 coverage, effective October 6, 2026.

### Remaining release and acceptance work

- Existing internal track: `4701731390750096325`; app Console ID: `4974023321468395687`.
- Version 8 draft: `releases/5/prepare`; release name and compatibility notes prepared.
- Documented browser file-chooser upload fails with `Not allowed`. Chrome's ChatGPT extension requires the operator to enable **Allow access to file URLs**. No version 8 artifact has been consumed by Play yet.
- After that setting is enabled: upload this exact signed bundle, verify API 32+ processing, publish only to the existing internal testing track, and read back active version 8.
- Then verify Honda API 32 catalog support and the tester's Honda installation option. Distinguish a queued remote install from a completed physical install and launch.

## Historical v6 release artifact

Status: **INTERNAL_TESTING_LIVE**. v6 is rolled out on the Internal testing track (Active, available to internal testers as of 2026-10-03 11:09 AM).

- Source branch: `holoc-11-play-version-6` (merged to `main`, `6384c3a`, pushed)
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

## Rollout (2026-10-03 11:09 AM)

- v5 draft discarded; fresh Internal-testing draft created (`releases/3`), v6 AAB (`holocene-auto-release-926b2a6b.aab`) uploaded and processed as `App bundle 6 (0.2.4-internal), API 33+, Target SDK 35`.
- The dedicated-AAOS-track error no longer appears at review; only the non-blocking R8-deobfuscation warning remains.
- `Save and publish` → confirm dialog → **Track Active**: `Latest release: 6 (0.2.4-internal)`, `Available to internal testers`, `Released on Oct 3 11:09 AM`, `Not reviewed`. App temporarily listed as `io.automaticai.holocene (unreviewed)` until store listing/review completes.

## Remaining external gates

Tester grant on the Internal testing track (up to 100 testers), Civic head-unit install via the head unit's Google Play path (actual-vehicle ADB unavailable per Honda), device-catalog check, and launch/verification on the vehicle. AAOS store screenshots (optional) and the AAOS quality-policy agreement remain open for dedicated-track opt-in later.
