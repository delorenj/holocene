# iPad delivery plan

Planning only · holocene-pm · 2026-11-17

This is a proposed work sequence, not board state or an implementation dispatch. First deliver a reliable foreground iPad voice client; do not start a general platform migration. Estimates and dates wait until the device, Mac, and signing lane are known.

## 1. Preflight and prove the risky audio path

**Proposed lead:** Holocene client developer; PM owns routing and evidence. Specialist help for audio and identity is subject to verified ownership, not assumed staffing.

Before any implementation dispatch, establish:

- Jarad’s iPad model, iPadOS version, accessories, and device availability from authorized device inventory; request owner-only access only if discovery cannot establish it. Select a supported stable Xcode/SDK and minimum OS from that device, not from guesses or a beta documentation example.
- An authorized Mac/Xcode executor and existing mobile release procedure. This planning host is Linux and has no `xcodebuild`; no remote Mac or signing readiness was proved. Check the established mobile-deploy-hub lane before designing another. If iOS support is missing, specify a separately owned delivery-lane task rather than hand-uploading builds.
- Apple Developer Program membership, signing access, app identifier, and the Apple Account Jarad actually uses on this iPad. His Google Play tester Gmail is not evidence of an Apple tester identity. No enrollment purchase, account change, or invitation is authorized by this plan.
- Existing operator authentication, edge access, and bucket/read protections. Source shows no app-auth proof in the pad upload flow; inspect the actual access boundary before deciding that infrastructure is public or safe. Scope any change to this client and its data, not a fleet-wide security redesign.

**Then, under a future implementation authorization:** build a small Swift/WKWebView shell around the shared pad with native capture and playback. Timebox the spike to one working day after prerequisites; this is a planning cap, not a delivery promise. Prove:

1. A nonempty native recording reaches the existing backend and its actual reply plays on the target iPad. Default candidate input is AAC/M4A; verify transcription accepts it. The current native path hardcodes an `.ogg` key and the proxy validates the Ogg header: make actual content type/container and filename extension part of the bridge contract, with an M4A proxy/transcription test and unchanged Android Ogg tests. Test the current full Ogg/Opus reply and early `.opus` chunks. If either fails, negotiate or produce a supported representation at the delivery boundary; do not assume AVPlayer accepts every container or replace the synthesis stack.
2. The iPad uses an explicit platform/capability declaration. Do not identify it as `car` merely because a native bridge exists. Define versioned capture/playback/durable-state capabilities and verify the fast conversation route without changing Android behavior. Bind the declared client to its authenticated installation; headers alone are not trusted authority. Select an iPad-appropriate conversational prompt for both fast and full-agent paths: current `prompt_for()` prepends car/driver instructions even on the full-agent route. Test direct replies and delayed background follow-ups without in-car timing limits or references to a driver.
3. Native audio handles mic authorization, stop/cancel, barge-in, queue ordering, headphone removal, Bluetooth changes, a FaceTime/system interruption, app switch, screen lock, and Smart Folio closure where applicable. Native callbacks must remain truthful if the web view is suspended or recreated. No sound into a recording; no silent keepalive audio.
4. Relaunch preserves device identity, outbox ownership, and played markers. A web UI reload must not restart audio or discard recordings. Test foreground return while a reply completed in the background.
5. Responsive pad layout and identity integration work without leaking credentials into page scripts. Only trusted first-party content may call the native bridge. Open external links outside it. Prefer bundled/versioned web assets; if retaining hosted assets, pin a compatible bridge protocol and rollback path.

**Gate:** keep the shared-web-interface/native-audio approach only if these tests pass. If bridge lifecycle, auth, or layout remains unreliable, retain the same backend contracts and use a fully SwiftUI client. Record the measured reason; do not start both full clients or a Rust rewrite.

## 2. Build the first usable iPad client

After the spike, propose the following ticket-sized slices. These are names, not ticket keys or claims that anyone is working:

| Proposed slice | Scope and done evidence | Dependency |
| --- | --- | --- |
| Client capabilities and turn identity | Add truthful iPad eligibility for the fast path; preserve exact recipient and immutable capture ID. Use collision-resistant recording keys compatible with existing parsers; simultaneous same-agent turns must not overwrite. Prove no Android regression. | Phase 1 findings |
| Authenticated operator access | Reuse compatible existing login; authorize uploads, status, reply reads, and playback claims. Keep app credentials native, object/model/storage secrets server-side; test denied, expired, and revoked access. No broad hub exposure. | Preflight identity boundary |
| Native audio and durable state | Ship the spike’s proven recording/playback adapter, offline outbox, stable device ID, and replay ledger. Interrupted recording becomes a saved draft requiring deliberate send. Preserve chunk ordering and stop semantics. | Capability contract and identity |
| Foreground reply ownership | Extend the existing car/phone claim seam for a distinct iPad owner; a suspension, timeout, or disconnect must not cause concurrent phone/iPad speech. Reacquire before resuming; fail silent when ownership is uncertain. Prefer manual playback over falsely claiming exactly-once hearing. | Capability contract; coordinates with audio |
| Tablet conversation surface | Agent selection, recent text turns, explicit states, audio controls, adaptive layout and accessibility. Require an authenticated bounded read of authoritative per-agent session state/expiry and recent turns before promising accurate relaunch/resume. Retain a bounded local turn view; while the server cannot be reached, show context as unconfirmed, not known active or expired. | Core client/audio; identity and session-read contract |

Do not copy a credential into JavaScript to make WebView requests work. Prefer a native-mediated authorized transport for protected data; if the existing edge instead supports secure HttpOnly sessions, prove the compatible cookie flow. Reuse existing identity/session services; do not invent a new auth platform or registration funnel.

Use the iPad’s stable device identity with the current per-device/per-agent desk session. Preserve current short-session expiry semantics unless a separately justified change is accepted. Do not conflate memo IDs, desk session IDs, and Hermes invocation threads. Support visible recent-turn recovery without claiming synchronized, permanent history across devices.

**Gate:** a complete foreground conversation and contextual follow-up work against the real existing services, with reliable native audio and no duplicated automatic playback on the phone/car. Independent spec review precedes independent quality review. A full-agent delayed answer remains valid when the fast route is legitimately unavailable, but that fallback must be visible and cannot silently stand in for fast-path acceptance.

## 3. Validate and install the daily-use build

The following is future release work, not authorization to deploy now.

**Device acceptance matrix, gathered by agents:**

- Select agent A, begin recording, attempt agent switch, cancel, then send another turn. Verify only the deliberate send reaches the bound recipient, with matching text and audio result. A cancellation after confirmed submission must say whether work has already started; do not promise to undo it.
- Complete multiple contextual turns, change agents, relaunch, and cross the configured idle expiry. Verify bounded context survives when appropriate, never crosses recipients, and resets honestly when expired.
- Lose network before send and after server acceptance; restore it and relaunch. Verify audio is retained, retry identity is stable, duplicate dispatch is suppressed, and an uncertain acknowledgement is shown honestly rather than “not sent.”
- Start two same-agent recordings on separate devices at nearly the same time. Prove unique recording objects and reply ownership; never deliver one turn to the other device’s local conversation by accident.
- Interrupt recording/playback, remove headphones, change Bluetooth route, lock/switch apps, close the cover, and force-quit/reopen. Prove draft recovery, no surprise loudspeaker speech, no output into mic, and no replay of already-heard replies. Explicitly document any not-supported case.
- Check portrait, landscape, narrow split-window, software keyboard, larger text, VoiceOver labels, and reduced motion on the target device. Record upload-to-first-audible and stop-to-mic timing against an Android baseline; investigate material regression without inventing a latency guarantee.
- Verify unauthenticated/expired access is denied for private data, sign-out stops protected requests/playback, and the full private hub remains inaccessible through the pad.

Run applicable existing pad/API/web checks as well as new iOS unit, integration, simulator, and physical-device checks. `pad:build` and building the canonical mounted `dist` can publish live assets here: use an isolated build output for spike/testing, never casually invoke the production pad build. Regression tests use controlled fixtures locally; final end-to-end proof must identify its real memo and real audio, not mock output.

**Install route:** use the established mobile delivery procedure, not manual version bumps/tags/uploads. Prefer internal TestFlight if Jarad is an eligible App Store Connect user on an existing paid team; otherwise record the required owner-controlled account step or evaluate the existing paid development/ad-hoc lane. External TestFlight needs the first beta review; it is not the default shortcut for one owner. Free Personal Team provisioning expires after seven days and is suitable only for the spike. TestFlight builds expire after 90 days, so document the update path; it is beta distribution, not indefinite private distribution.

When ready, provide Jarad one short device guide: install Apple’s TestFlight, accept the actual verified invitation, tap Install for the build, open Holocene, complete login, then allow the microphone on first Record. Do not invent an invite link, assume an Apple Account, send a console walkthrough, or ask him to sign off engineering acceptance. Ordinary use is not a substitute for agent-owned tests.

## Orchestration, follow-on work, and authority

Before future board writes, check for existing overlapping tickets, acquire the board-driver lease with one literal owner for that pass, and keep all work in this repo’s scope. Use a parent epic only if the decomposition earns it. Order Todo, complete triage labels, express real blocking relations, and leave dispatch to Krebs. Never set `agent:working` or start implementation workers directly; use independent implementer/spec-review/quality-review roles. Release the short lease before waiting.

After the iPad release: evaluate Android phone/tablet layout in the existing Android shell, then desktop web/packaging. Revisit shared Swift/Kotlin/Rust code only for a concrete second implementation or measured bottleneck. Cross-device conversation handoff needs an authenticated session/resume contract; notifications need APNs registration and a privacy-safe ready-reply alert. Wingman remains a separate feature and backend dependency, not an iPad prerequisite.

No tickets, release actions, recurring schedules, production builds, or implementations were created by this planning pass. Money, passkeys, signing access, and unavailable device access remain owner-only steps with no purchase or access bypass by default.
