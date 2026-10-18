# Decision memo: Telegram as the voice transport for Holocene Mini, Holocene Auto and the agents

Date: 2026-10-18. This memo draws on four research tracks: `bot-api`, `mini-apps`, `native-and-car` and `local-system`. Repo-relative paths are under `/home/delorenj/code/33GOD/holocene`. Citation keys such as [BA-feat] are listed under Sources at the end.

## Bottom line

- **The phone doesn't need an app.** Telegram already runs the whole voice loop for the agents, and it is live today. 13 agent bots are connected to the one shared Hermes gateway. They download voice notes, transcribe them and reply with a voice bubble (`~/.hermes/gateway_state.json`; `~/.hermes/profiles/holocene-pm/config.yaml:246-305`). Telegram's own mic button is the recorder. On the phone the Agent Pad no longer has a job.
- **A Mini App only works inside Telegram clients.** That includes Telegram Web and Telegram Desktop. In any other browser it is a web page with no logged-in identity.
- **Holocene Mini should be the rebranded DeloHQ.** It becomes a control surface plus a roster where each agent links straight into its Telegram DM. It should not get a recorder.
- **The car is the hard part.** Android Automotive has no Telegram app. An agent's own bot token also can't speak as you, so the agent would never see the message as coming from you. Only two car options keep one thread per agent shared by phone and car:
  - **C3, a business-bot relay:** cheapest, but unverified.
  - **C1, TDLib logged in as you:** documented, but heavy, and it puts your account at some risk.
- **Telegram does not fix the biggest problem, which is transcription.** Both paths call the same `~/.local/bin/transcribe`. In the S3 pipeline transcription takes 48 of the 75 seconds (`_bmad-output/implementation-artifacts/agent-pad-auto/pipeline-e2e.md:49-67`). On Telegram, 31 of 33god-pm's 55 voice notes failed transcription (`~/.hermes/profiles/33god-pm/logs/gateway.log`). Fix transcription first, whatever else you choose.

---

## 1. Is a Mini App confined to the Telegram app?

Yes. A Mini App is an ordinary HTTPS page, and Telegram's own clients are what give it identity and the native features.

**Where it works:**
- **Telegram iOS, Android, Desktop (Windows/Linux) and macOS.** The page runs in the client's built-in WebView [WA "Debug Mode for Mini Apps"].
- **Telegram Web.** The page runs in an iframe, so you must not set X-Frame-Options or a strict frame-ancestors header [SL "Mini App front-end"].
- **Nowhere else, according to the docs:**
  - No other host is documented [WA].
  - No standalone or app-store packaging is documented [mini-apps 6a, not_found].
  - The TDLib docs don't say whether a custom TDLib client can render Mini Apps [TD].

**What happens in a plain browser (for example holocene.delo.sh/hq in Chrome):**
- **The page still loads.** If the page includes `telegram-web-app.js`, the `Telegram.WebApp` object exists, but it is empty:
  - `initData` is `''` and `initDataUnsafe` is `{}`.
  - `platform` is `'unknown'`.
  - Native calls (popups, haptics, fullscreen, storage, biometrics) come back with `{notAvailable:true}` [WA-js ~13-22, 130-165, 286-312].
  - This comes from reading the SDK source; the docs say nothing about it.
- **DeloHQ refuses the user.** Its server-side HMAC check rejects the empty initData (`apps/web/app/hq/lib/verify-init-data.ts:28-86`).
- **There is no fallback login.** The `holocene-hq` Traefik router (priority 350) deliberately skips `google-auth@file` for `/hq` (`/home/delorenj/code/33GOD/33god-platform/compose.yaml:216-229`). A browser therefore just gets the "no Telegram / unauthorized" empty states (`apps/web/app/hq/hq-client.tsx`).
- **Bot API 10.2 adds an origin rule.** Since Jul 20 2026, Mini App methods are blocked when called from any origin other than the Mini App's own domain [BA-chg 10.2]. This is harmless as long as the Mini App stays on holocene.delo.sh.

**How to make the same view work outside Telegram:** add a second way to log in. Two options:
- **Telegram Login (OIDC).** It has web and native iOS/Android SDKs [LOGIN].
- **The existing Google login.** The rest of holocene.delo.sh already sits behind Google OIDC (`compose.yaml:216-229`). This needs no new infrastructure.

## 2. Can a "Telegram app" also be a mobile app?

"Mobile app" can mean three different things here, plus a new Telegram-hosted option.

| Form | What it really is | Does it leave Telegram? | Trade-off |
|---|---|---|---|
| **Home-screen shortcut** | `addToHomeScreen()` / `checkHomeScreenStatus` put an icon on the home screen [WA; BA-feat "Home Screen Shortcuts"] | No. One third-party source says the icon opens Telegram [OQTA]. This is inferred; check it on a device. | Free. Worth doing. |
| **Store / standalone app** | Not documented [mini-apps 6a]. You would wrap the web UI in your own WebView, which is exactly what Holocene Auto already does (`apps/auto/app/src/main/java/sh/delo/holocene/auto/AgentPad.kt:30`). The wrapper gets no initData. | Yes, but it is just a normal app. | Identity would come from the Telegram Login native SDKs. That gives you identity and permission for your bot to message you. It is **not** a user session and cannot send as you [LOGIN "Native SDKs"; native-and-car 4a]. No transport benefit. |
| **TDLib native client** | A real Telegram client logged in as your account [TD; TD-gs "User authorization"]. It can send voice notes with `inputMessageVoiceNote` (OGG/Opus mono, duration, waveform) [TD-vn]. It receives updates in order and keeps a local database across restarts [TD "Consistent"]. | Yes | **Credentials:** needs an api_id and api_hash from my.telegram.org, and each phone number can have only one api_id [APIID]. **Build:** C++17, OpenSSL, zlib, CMake and gperf; Kotlin would go through the Java/JNI bindings (inferred) [td README]. **Account risk:** "accounts that log in using unofficial Telegram API clients are automatically put under observation" [APIID]. **ToS:** API Terms 1.4 and 2.1-2.4 apply [TOS]. Mini App rendering inside it is undocumented. |

**Telegram Serverless (launched Oct 6 2026):**
- **What it is:** Telegram hosts the Mini App front-end at `app<id>.tgcloud.ai`, plus server endpoints that only accept calls carrying valid initData [SL].
- **Why it doesn't fit:** DeloHQ has to reach your fleet API on big-chungus (`/api/modules/hermes-fleet/`, `apps/web/app/hq/api/action/route.ts:13-50`).
- **Not checked:** pricing and limits.

**Conclusion:** Holocene Auto already is the native mobile app. The real decision is how it moves voice, which is question 3.

## 3. Can we skip the app and use the API directly?

### Facts that constrain every option

1. **Telegram won't transcribe or speak for a bot.**
   - The Bot API has no transcription field, method or update.
   - Telegram's `messages.transcribeAudio` is user-only and needs Premium after a weekly trial [TRANS; bot-api 5a].
   - There is no built-in text-to-speech either [bot-api 5b].
   - So `transcribe` and vox stay in every option.
2. **Both paths share the same transcription bottleneck.**
   - Hermes's Telegram transcription runs `local_command` → `hermes-transcribe-adapter` → the same `~/.local/bin/transcribe` the S3 watcher uses (`~/.hermes/profiles/holocene-pm/config.yaml:284-298`; `~/.local/bin/hermes-transcribe-adapter:11`).
   - Most of the 31 failures read "[lock] Acquired transcription slot", which points to contention on the shared lock. pjangler-pm also hit 300 s timeouts (local-system C5).
3. **Only three identities can put a voice note into your DM with an agent bot as you:**
   - you, in a Telegram client;
   - you, through TDLib/MTProto;
   - a business bot acting on your behalf.
   - "Neither feature lets a bot send as a user; only Business connection does that" [bot-api 7b; BA-feat #business-bots].
4. **Delivery rules:**
   - Telegram keeps undelivered updates for at most 24 hours.
   - `getUpdates` keeps re-sending an update until you advance the offset.
   - Webhooks retry "a reasonable amount of attempts"; the schedule is not stated.
   - Deduplicate on `update_id`. After a week of silence the next `update_id` is chosen at random [BA-api "Getting updates"; getupdates.md; setwebhook.md; update.md].
5. **A bot gets no read or "played" signal in a private chat** [bot-api Q-gotchas 5]. The agent side loses the "played" acknowledgement that the S3 pipeline has today.
6. **Size and rate limits don't matter at voice-note size.**
   - Downloads via `getFile` are capped at 20 MB; `sendVoice` uploads at 50 MB.
   - Sending is limited to about 1 message per second per chat [getfile.md; sendvoice.md; BA-faq limits].
   - A `file_id` only works for the bot that received it [BA-faq].
7. **The car can't fall back on Telegram.**
   - Android Auto messaging works through notifications, and a voice reply is sent as dictated **text**, not a voice note [AA step 6].
   - Google lists the messaging category for Android Auto only, not Android Automotive [CARS table].
   - Telegram disappeared from Android Auto for users in May-Jun 2026, and its current state is unknown [AE; bugs.telegram.org/c/50136].
   - No Telegram listing for Android Automotive was found.

### (A) The phone uses Telegram; agent bots handle voice natively

- **Status:** already live.
  - 13 profiles are connected, including @holocene_pm_bot, @Gr0lfBot and @voxxy_pm_bot (`~/.hermes/gateway_state.json`).
  - Config: TTS is vox (voice carlin, OGG); STT is local_command; `voice.auto_tts` is true; Telegram streaming is on (`config.yaml:246-305, 419-423`).
  - Telegram sends voice replies as voice bubbles (`~/.hermes/hermes-agent/plugins/platforms/telegram/adapter.py:5138-5212`).
- **Removes, for phone turns:**
  - the Agent Pad on the phone;
  - the upload proxy;
  - the MinIO `inbox/` and `replies/` folders and the public bucket listing;
  - the inbox-watcher;
  - the bb-emit path for memos;
  - reading replies out of state.db;
  - the 5 s and 15 s polls;
  - the double vox synthesis.
- **Adds:** nothing.
  - Still to fix: three bots fail Telegram login (gruvato-pm, keepy-money-pm, nautilus-trader-pm).
  - About 11 bots that have a username in the registry aren't wired into the gateway, for example bloodbank-pm and heyma-pm (local-system C7).
- **Reliability:**
  - The message stays in the Telegram chat.
  - The weak point is a failed transcription. The tracks show one fallback to local faster-whisper and then nothing (`~/.hermes/hermes-agent/gateway/run_inbound.py:1918-1960`). The S3 path has `MEMO_MAX_ATTEMPTS=3` and `mise run memo:retry` (`services/inbox-watcher/README.md:115-160`).
  - If the gateway is down for more than 24 hours, the voice note is never processed.
- **Latency:** never measured.
  - Inferred: the S3 time minus the 5 s watcher poll, up to 15 s of pad polling, and the mc copies. Transcription, agent turn and TTS are unchanged.
  - Feedback on the phone: the "recording voice" indicator and streamed text drafts [sendchataction.md; sendmessagedraft.md].
- **ToS:** same as today. The AI-data clauses are a grey area [TOS 1.5; TOS-cl; TOS-bot].
- **Effort:** close to zero.
- **What breaks:** the `/voice` timeline in Holocene.
  - Telegram turns emit none of the `audio.memo.*` facts.
  - It is not confirmed whether Hermes's Telegram path emits `agent.invocation.*`. Only the Bloodbank path is documented to (local-system A4, A6).
  - Holocene only sees what arrives over Bloodbank (`holocene/CLAUDE.md`).
  - A does nothing for the car.

### (B) Holocene Mini Mini App that records in its WebView, replacing the Agent Pad on the phone

- **Microphone access is undocumented.**
  - None of the docs mention a microphone or getUserMedia [WA; BA-chg; native-and-car 4c].
  - The only evidence is an unmerged Android pull request. It says getUserMedia works but shows the permission dialog again on every request, and that iOS doesn't have the problem [PR1947].
  - iOS's built-in recorder produces `audio/mp4` before iOS 18.4 and `webm/opus` from 18.4 (third-party source) [mini-apps 4].
  - The upload proxy only accepts OGG streams (`services/upload-proxy/upload_proxy.py:343`), so you would need a conversion step.
  - Recording while the Mini App is minimized is undocumented. The docs only describe `activated` and `deactivated` events [WA "isActive"].
  - getUserMedia already failed on the Honda WebView, which is why `NativeRecorder` exists (`_bmad-output/implementation-artifacts/agent-pad-auto/evidence.md:98-111`).
- **The recording can't reach the chat.**
  - There is no documented way for a Mini App to put audio into the chat as a voice message.
  - `sendData` is limited to 4096 bytes, only works when launched from a keyboard button, and closes the app [bot-api Q-app].
  - So the recording has to go to your own backend. From there it either goes through the S3 pipeline (nothing removed) or gets sent by a bot. A bot-sent message doesn't come from you, so the agent doesn't see it as your turn (fact 3).
- **Verdict:** worse than A's native mic button on every count. Use the Mini App for control only.

### (C) Holocene Auto keeps its own UI and uses Telegram as transport

All three variants keep the car's recorder and player:
- `NativeRecorder` already produces OGG/Opus, mono, 48 kHz (`apps/auto/.../NativeRecorder.kt:46-63`), which is what `sendVoice` and `inputMessageVoiceNote` expect.
- `ReplyPlayer` stays (`ReplyPlayer.kt:83-95`).
- Only the transport changes: the `PUT /upload` and bucket-list polling are replaced by a Telegram send and Telegram updates.

**C1. TDLib logged in as you**
- **One thread per agent:** yes. Voice notes from car and phone land in the same DM.
- **Removes:** all the S3 pipeline machinery listed under A.
- **Adds:**
  - the TDLib native library plus JNI;
  - a login flow (phone number, code, 2FA) on the head unit;
  - a key for the local database;
  - an api_id.
- **Reliability:**
  - Ordered push updates and a local database that survives restarts [TD].
  - The tracks don't say whether unsent messages survive a restart, so keep the car's outbox.
- **Latency:** push in both directions, no polling. Not measured.
- **Risk:**
  - Your primary account goes under observation [APIID].
  - Flooding or spam means a permanent ban [APIID].
  - The track suggests a second account to lower that risk; that idea is its own, not from the docs. A second account would also split the thread [native-and-car 1d].
- **Effort:** high. You have to cross-compile TDLib for each Android CPU type and sync a full account onto a car.
- **Side note:** a user session could call `transcribeAudio`, but it needs Premium after the trial and the agent never sees the result [TRANS].

**C2. A relay bot that DMs the agent bots**
- **How it works:**
  - The car holds a relay bot's token, or talks to a small relay service.
  - It sends voice notes to `@agent_bot` by username.
  - This needs Bot-to-Bot Communication Mode turned on for both bots in BotFather, plus mandatory loop guards [BA-feat #bot-to-bot; BA-chg 10.0].
- **One thread per agent:** **no.** The conversation is between the relay bot and the agent, so the phone never sees car turns.
- **Unknown:** whether the Hermes Telegram adapter accepts messages from bots or allows the relay bot's id.
- **Effort:** medium. Turn the mode on for about 25 bots and write loop guards.
- **ToS:** low risk. Badly handled loops can bring "platform restrictions" [BA-feat].
- **Verdict:** a fallback, only if you can live with a separate car thread.

**C3. A business-bot relay that sends as you**
- **How it works (documented pieces):**
  - You connect a Holocene bot to your Telegram account as a business bot.
  - It calls `sendVoice` with `business_connection_id` into your DM with each agent bot. The message goes out as you, with `Message.sender_business_bot` marking which bot sent it [BA-feat #business-bots; businessconnection.md; message.md].
  - According to the features page, a business-connected bot can message other bots the account uses, as long as the sending bot has bot-to-bot mode on [BA-feat "Communication via Business Accounts"].
  - Telegram Premium is no longer required (Bot API 10.0) [BA-chg 10.0].
- **One thread per agent:** yes, by the documented mechanism. Not tested here.
- **Replies:**
  - The business bot gets `business_message` updates for your chats if it has the `can_read_messages` right [businessbotrights.md].
  - The car plays those replies.
  - `readBusinessMessage` can mark a reply read in your own Telegram; the agent still won't know.
- **Where the token lives:** the car can call the Bot API directly with no server, or go through a tiny relay.
  - If the car is the only `getUpdates` consumer, updates wait up to 24 hours while the car is off. That is fine for replies that are stale anyway.
- **Removes:** the same as C1.
- **Adds:** one bot, one business connection, and a small Kotlin Bot API client.
- **ToS:** no api_id and no unofficial-client observation. The track cites "ToS section 5.4" without saying which document it belongs to.
- **Effort:** low to medium, if the spike below passes.
- **Unverified (this is the spike):**
  1. The `can_reply` right only covers chats "that had incoming messages in the last 24 hours". Does that block starting a turn with an agent that has been silent for over 24 hours?
  2. Does `business_message` fire for the agent bot's replies in chats with bots?
  3. Does Hermes treat the message as coming from you?
  4. Which BotFather setting is it? The track says "Secretary Mode" in one place and "Chat Access Mode" in another.
  5. Can your chat-scope settings include chats with bots?

### (D) Keep the S3 pipeline

- **Size:**
  - about 15 components, 11 hops, 3 durable retry queues and 3 polling loops (`services/inbox-watcher/README.md:7-49`);
  - measured 59-78 s end to end (`pipeline-e2e.md:49-67, ~232-242`);
  - about 18 logged failure modes (`evidence.md:98-111`, `pipeline-e2e.md:103-200`, `silent-mic.md:6-11`).
- **Strengths:**
  - It is the best-instrumented option: 7 `audio.memo.*` facts plus `agent.invocation.*`, the `/voice` view, `memo:trace`, and retries with time budgets (local-system A6).
  - It works in the car today.
- **Live bugs that need fixing whatever you decide:**
  - **Double vox synthesis.** The gateway's auto-TTS runs on Bloodbank memo turns, fails to deliver, and then the watcher calls vox again (`~/.hermes/hermes-agent/gateway/run_voice.py:357-396`; `services/inbox-watcher/inbox_watcher.py:964-1062`).
  - **Uncommitted host change.** `~/docker/stacks/websites/agent-pad/compose.yml:16,49` moves the host to `agents.delo.sh`, which gets no response. Recreating the containers from that file would break the car app.

### Comparison

| | A: phone on Telegram | B: Mini App recorder | C1: TDLib | C2: relay bot | C3: business bot | D: S3 |
|---|---|---|---|---|---|---|
| Shared phone/car thread | phone only | n/a | yes | **no** | yes (unverified) | no |
| New parts to run | none | D's parts plus recorder and conversion | TDLib, login on car | relay bot, loop guards | one bot plus a client | ~15 existing |
| Delivery | Telegram cloud, updates kept 24 h | same as D | ordered updates, local database | updates kept 24 h | updates kept 24 h | durable outboxes and budgeted retries |
| Latency | not measured; minus the polls | same as D or worse | not measured; push | not measured | not measured | 59-78 s measured |
| Account / ToS risk | low (AI-data grey area) | low | medium (account observed) | low | low to medium | none from Telegram |
| Effort | about zero | medium | high | medium | low to medium (spike first) | zero, plus bug fixes |
| Main thing that breaks | `/voice` goes dark | mic undocumented | account risk, build work | split thread; does Hermes accept bots? | does the 24 h rule block it? | complexity |

## 4. Recommendation and phased plan

**Recommendation:**
- **Phone:** use A now.
- **Holocene Mini:** the rebranded DeloHQ, with no recorder.
- **Car:** spike C3 first. Fall back to C1 if it fails. Keep D running for the car until one of them passes.
- **First of all:** fix transcription, because both paths share it.

**Phase 0: shared fixes (hours; do these regardless)**
1. **Fix transcription.** Get it off the contended lock and GPU.
   - Options: give short clips their own slot or a smaller model in `~/.local/bin/transcribe`, or switch Hermes's `stt.provider` to one of its built-in providers (groq, openai, deepinfra and others; `~/.hermes/hermes-agent/tools/transcription_tools.py:4-7`), routed per your AutomaticAI gateway policy.
   - Done when 33god-pm's "Voice transcription failed" count stops growing and memo transcription takes under 10 s.
2. **Stop the double vox synthesis.** Turn auto-TTS off for turns that come from Bloodbank (`run_voice.py:357-396`).
3. **Resolve the agent-pad host change.** Revert `agents.delo.sh` or make it answer, before anyone recreates the containers.
4. **Fix the bots.** Repair the 3 bots failing Telegram login and wire the registry bots that aren't on the gateway.

**Phase 1: phone on Telegram, option A (about a day)**
1. Stop using the Agent Pad on the phone and send voice notes to the agent DMs instead.
2. Make Telegram voice turns visible in Holocene. Have the gateway's Telegram path emit Bloodbank facts, either `audio.memo.*` with `source=telegram` or `agent.invocation.*`. First find out what it emits today.
3. Measure Telegram end to end, from voice note sent to voice reply received.
4. Find out what Hermes does after a transcription failure: does it retry, and do you get told?

**Phase 2: Holocene Mini (one to two days)**
1. **Rebrand DeloHQ.**
   - Change the title in `apps/web/app/hq/layout.tsx:4-7` and the menu button text from "Open HQ" to "Holocene Mini".
   - Keep the `/hq` path, which needs no Traefik change. If you want `/mini` instead, add ``PathPrefix(`/mini`)`` to the `holocene-hq` router at `compose.yaml:216-229`. Without that, Google login takes over the route inside Telegram's WebView.
2. **Set up the Main Mini App.**
   - Set a Main Mini App for @DeLoHQBot in BotFather; `has_main_web_app` is false today. That gives you the "Launch app" button and `t.me/DeLoHQBot?startapp` links.
   - Add `addToHomeScreen()` and check on a device what the icon actually opens.
3. **Make the roster the phone's way into voice.** Each agent's existing "Open DM" `openTelegramLink` (`apps/web/app/hq/hq-client.tsx`) opens its Telegram DM, and Telegram's mic does the recording.
4. **Optional:** accept the Google login as well, so the same view works in a normal browser.
5. **Deploy** following the Holocene production-first rule: recreate `holocene-web`, then verify https://holocene.delo.sh/hq.

**Phase 3: car spike for C3 (one to two days)**
1. **Set up the bot.** Create or pick a bot, turn on business mode and bot-to-bot mode, and connect it to your account.
2. **Send a test voice note from a script.** Use `sendVoice(business_connection_id, ...)` with an OGG from `NativeRecorder`, into your chat with @holocene_pm_bot.
3. **Check four things:**
   - (a) it arrives in your DM as you;
   - (b) Hermes transcribes it and replies;
   - (c) the reply arrives as a `business_message` update;
   - (d) sending still works after more than 24 hours of agent silence.
4. **If it passes:**
   - Replace `PUT /upload` and the S3 polling in Holocene Auto with `sendVoice` and `getUpdates`.
   - Keep `NativeRecorder`, `ReplyPlayer`, the last-played marker in SharedPreferences, and an outbox.
5. **If only (d) fails:** a daily message from each agent would work around it, but that's a hack. Lean towards C1.
6. **If it fails:** spike C1 (api_id, Android build, login on the head unit) and accept the account observation.
7. **If C1 also fails:** keep D for the car only, with the Phase 0 fixes. Use C2 if a separate car thread is acceptable.

**Phase 4: retire D (after the car path has run cleanly for about a week)**
- Remove `agent-pad-upload`, the MinIO `holocene-auto` `inbox/` and `replies/` folders and their public listing, the `holocene-inbox-watcher` unit, and the `memo:*` tasks.
- Keep Bloodbank facts coming from the new emitter.

## What the research could NOT confirm

1. Whether the microphone works in a Mini App on real Telegram iOS and Android builds. It is undocumented; the only evidence is one unmerged Android pull request [PR1947].
2. What a home-screen shortcut actually launches. Only a third-party source covers it [OQTA].
3. Whether Telegram runs on Android Automotive at all, and whether Telegram works on Android Auto after the May-Jun 2026 breakage [CARS; AE].
4. The details C3 depends on:
   - whether the 24-hour `can_reply` window applies in chats with bots;
   - whether `business_message` updates arrive for bot replies;
   - which BotFather setting it is;
   - how Hermes treats a message sent by a business bot.
5. Whether the Hermes Telegram adapter accepts messages from bots (C2), and which Bloodbank facts its Telegram path emits.
6. Telegram end-to-end latency, which was never measured. Also, whether Hermes uses polling or a webhook; this isn't in the tracks.
7. What Hermes does after a transcription failure, and what you see when it happens.
8. Smaller gaps:
   - the webhook retry schedule;
   - any duration cap on incoming voice notes;
   - rate limits on getFile.
9. Whether TDLib keeps unsent messages across a restart. A Kotlin binding beyond Java/JNI is inferred.
10. Whether the ToS AI-data clauses cover sending your own voice to transcription or an LLM. It's a grey area, and it applies to today's bots too [TOS 1.5; TOS-cl; TOS-bot].
11. Serverless pricing and limits, and the Mini App parts of Bot API 10.3 beyond its first lines.
12. Why the three bots fail Telegram login: a revoked token or a config problem.

## Contradictions between tracks (and within sources)

1. **Telegram Login scopes.** `mini-apps` lists openid, profile, phone and telegram:bot_access. `native-and-car` lists profile, phone and write. `mini-apps` noted that the `.md` copy of `/widgets/login` was lagging behind the HTML page, so the two tracks probably read different versions. This doesn't affect the decision.
2. **Mini App microphone.** `bot-api` and `native-and-car` say "not found". `mini-apps` says it probably works, based on PR #1947. They agree the docs are silent and differ only on the third-party evidence.
3. **Sending voice with a bot token from the app.** `native-and-car`'s overall answer suggests the app could "call the Bot API directly with the bot token... and skip Telegram's client". That conflicts with `bot-api` 7b: only a business connection sends as a user. A voice note sent with an agent's own token is the agent speaking, so it doesn't count as your turn. It only works through a separate relay identity (C2) or a business bot (C3).
4. **Connected-bot count.** The `local-system` summary says 14 connected profiles; its own C7 list names 13.
5. **Business-bot setting name.** `bot-api` 7a says "Secretary Mode"; 4b says "Chat Access Mode".
6. **Inside Telegram's own docs.** The Bots FAQ says bots never see messages from other bots. features.md and changelog 10.0 say they can. Treat the FAQ as stale [BA-faq vs BA-feat].
7. **Not a contradiction, but not a fair comparison either.** Hermes transcribes with model `base`; the watcher uses `large-v3`. Speed and failure comparisons between the two paths are skewed.

## Sources

- [BA-chg] https://core.telegram.org/bots/api-changelog.md (9.0-10.3)
- [BA-feat] https://core.telegram.org/bots/features.md (#bot-to-bot-communication, #business-bots, #managed-bots, Home Screen Shortcuts)
- [BA-faq] https://core.telegram.org/bots/faq.md
- [BA-api] https://core.telegram.org/bots/api.md (#getting-updates, #using-a-local-bot-api-server)
- Method and type pages under https://core.telegram.org/bots/api/:
  - methods: getfile.md, sendvoice.md, sendchataction.md, sendmessagedraft.md, getupdates.md, setwebhook.md
  - types: update.md, voice.md, message.md, businessconnection.md, businessbotrights.md
- [WA] https://core.telegram.org/bots/webapps.md
- [WA-js] https://telegram.org/js/telegram-web-app.js
- [SL] https://core.telegram.org/bots/serverless.md
- [LOGIN] https://core.telegram.org/bots/telegram-login.md
- [TD] https://core.telegram.org/tdlib
- [TD-gs] https://core.telegram.org/tdlib/getting-started.md
- [td README] https://github.com/tdlib/td
- [TD-vn] https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1input_message_voice_note.html
- [APIID] https://core.telegram.org/api/obtaining_api_id.md
- [TOS] https://core.telegram.org/api/terms
- [TOS-bot] https://telegram.org/tos/bot-developers
- [TOS-cl] https://telegram.org/tos/content-licensing
- [TRANS] https://core.telegram.org/method/messages.transcribeAudio.md and https://core.telegram.org/api/transcribe.md
- [AA] https://developer.android.com/training/cars/communication/notification-messaging
- [CARS] https://developer.android.com/training/cars
- [AE] https://www.autoevolution.com/news/top-app-disappears-from-android-auto-again-and-google-looks-confused-270373.html
- [PR1947] https://github.com/DrKLO/Telegram/pull/1947
- [OQTA] https://oqtacore.com/blog/telegram-mini-app-development-architecture-payments-api-and-what-changed-in-2026
- Local files:
  - Holocene repo: `/home/delorenj/code/33GOD/holocene`
  - Platform compose: `/home/delorenj/code/33GOD/33god-platform/compose.yaml`
  - Hermes Telegram adapter: `/home/delorenj/.hermes/hermes-agent/plugins/platforms/telegram/adapter.py`
  - Hermes config and logs: `/home/delorenj/.hermes/profiles/*/config.yaml` and `/home/delorenj/.hermes/profiles/*/logs/gateway.log`
  - Gateway state: `/home/delorenj/.hermes/gateway_state.json`
  - Agent Pad compose: `/home/delorenj/docker/stacks/websites/agent-pad/compose.yml`
