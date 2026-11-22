---
title: Holocene on iPad — product brief
status: draft
created: 2026-11-17
updated: 2026-11-17
owner: holocene-pm
---

# Holocene on iPad

> “It’s so good that when I’m not driving I wonder why can’t I use it still.” — Jarad

## The next version

Bring the Holocene Auto voice-agent experience to Jarad’s iPad: pick an existing agent, talk naturally, hear its real reply, and keep the conversation going at home or at a desk. **iPad is the next release; a multi-platform rewrite is not.**

**Recommendation:** reuse the React Agent Pad and existing transcription, agent-routing, and voice services. Add a thin Swift iPad shell with native recording, playback, and durable device state around a tablet-friendly web interface. Prove this bridge on-device before committing to it; a fully SwiftUI interface is the fallback if the bridge cannot meet the audio and layout gates. Rust is an option for a later proven shared component, not a first-release requirement.

## First-release experience

- **Recording:** select an agent; tap Record, then Stop & Send, or Cancel. Show microphone level and elapsed time. Freeze the recipient at recording start. Selection alone sends nothing; cancellation before send never dispatches. Stop reply audio before opening the microphone. Permission denial, silence, interrupted capture, and failed uploads get truthful recovery states.
- **Spoken replies:** keep assigned agent voices and the fast conversation path, including delayed results from delegated work. Separate “heard,” “working,” and the actual answer. Provide Stop, Replay, and a quiet mode. Never play a reply while recording or play the same automatic reply on both iPad and phone/car.
- **Continuity:** preserve the iPad’s device identity, per-agent recent turns, pending uploads, and heard/unheard markers across relaunch. Resume the same unexpired server conversation; show clearly when it has expired and start fresh. This requires a narrow authenticated session-state/recent-turn read that today’s per-memo status does not provide. When offline, label server context as unconfirmed. Mid-conversation handoff from the car is a later feature, not something today’s backend already guarantees.
- **Tablet layout:** an agent sidebar/grid alongside the selected conversation in landscape; a compact agent picker above the conversation in narrow windows. Keep normal-sized record controls reachable, the selected agent prominent, and recent transcript/reply text readable. Support portrait, split-window resizing, larger text, VoiceOver labels, and reduced motion. Do not transplant driving restrictions or the entire Holocene dashboard.
- **Authentication:** reuse the existing operator identity system where compatible. Authenticate both reads and writes; a device header is not a login. Keep service keys server-side and app credentials in Keychain/native storage, not JavaScript. Reuse the narrow pad activity projection; never make the private hub public to populate this screen.
- **Installation:** use the existing authorized Mac/mobile delivery lane if it supports iOS. Prefer internal TestFlight when the developer membership and Jarad’s tester account are already available. Free Xcode installation is a short-lived development alternative, not the daily-use plan.

**Background contract:** first release prioritizes conversations while the app is open. An already-playing reply may continue under Apple’s legitimate audio background mode if device tests pass. Locking during recording safely stops and saves a recoverable draft; it does not silently send. Returning to the app recovers pending results. Notifications that invite reopening are a later slice; waking a suspended or force-quit app to speak an arbitrary reply is not promised.

## What “done” looks like

On Jarad’s actual iPad, an agent-owned test records a memo, receives a correlated real spoken answer, and completes a contextual follow-up. It also proves cancel, denial, offline retry, relaunch, interruption, and no duplicate phone/car speech. The UI works in portrait, landscape, and a narrow window. A reviewed signed build is installed through the established release procedure, with its update/expiry instructions recorded. No simulator-only or browser-only result counts as device delivery.

## Cut line and assumptions

**Later:** Android phone/tablet polish using the existing Android shell; desktop packaging; explicit cross-device conversation handoff; notifications; Wingman integration; public distribution, subscriptions, offline agents, and always-listening voice. None blocks the first iPad release.

**[ASSUMPTION]** This is a private, single-operator client, not a public product launch. Foreground-first use and separate per-device conversations are proposed defaults, not requirements Jarad explicitly stated. The iPad model, iPadOS version, Mac/Xcode access, signing membership, identity integration, and audio-format compatibility still need a preflight. These block implementation or installation, not completion of this planning draft.

**Next:** perform that preflight, then route one bounded native-audio/bridge spike through Krebs with independent review. Nothing has been implemented, scheduled, or dispatched by this planning pass. See [delivery-plan.md](delivery-plan.md) for gates and [addendum.md](addendum.md) for evidence and alternatives.
