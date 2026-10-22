# Car desk: new ladder + car-desk skills, bounded sim proof (2026-10-22, HOLOC-23)

Honda sim emulator-5554 only (`~/Android/Sdk/platform-tools/adb -s emulator-5554`), holocene-pm tile, converse on for the sim
device only (flag file unchanged: mode on, agents [holocene-pm], devices [sim]; unit still `MEMO_CONVERSE=off`). Watcher at
775ffaa (no restart, no code change in this run). Driver: `tools/drive_converse.py` (now takes `LEAD_IN_S`: silence in front
of each utterance, 2.5 s then 4.5 s here because the emulator mic opened 2-4 s late), speech into the `holo_testmic` null
sink, logcat + speaker tap in `/tmp/conv-e2e-ladder`. Window 17:26:50Z-17:45:10Z, 13:24-13:49 local (25 min).

Budget used: **15 recorded memos** (1 lost to the sim recorder, 14 decided), **1 full-agent memo** (unplanned: the desk itself
chose `direct`), no timer scenarios.

## Turns

`stop->start` = Stop press (host clock) to the car's `HoloceneSpeech start` of that memo's reply/echo (device clock minus the
measured offset). `LLM` = the routed fact's `latency_ms`.

| # | memo | driver said / whisper heard | path, action | answered by (attempt log) | LLM | stop->start | voice of reply |
| --- | --- | --- | --- | --- | --- | --- | --- |
| - | a6d6bc87 | p1-a / (none) | `record_failed`: "native recorder returned no audio" (`HoloceneNativeRec: stop failed`) | - | - | - | - |
| P1.1 | f26c4fbb | "Hey, quick one. What are you working on right now?" / "Hey, what are you working on right now?" | fast, **direct** (the model's choice) -> today's path, Sol turn 21.5 s | r1 `http_402` 170 ms, **r2 deepseek-flash** 1732 ms | 1904 ms | 9.5 s (echo) | rick |
| P1.2 | 30de0cf6 | "Tell me a quick joke about traffic." | fast, reply | r1 `breaker_open` 0 ms, **r2 deepseek-flash** | 1819 ms | 12.17 s (audible 15.76) | rick |
| P1.3 | 4d75a880 | "In one sentence, what does the car desk do?" | fast, reply | r1 breaker_open, **r2 deepseek-flash** | 1449 ms | 14.28 s (2x `halt focus_denied` before it played) | rick |
| (P2) | 26332f6b | "Use Walken voice." / "You lost." (clipped) | fast, reply | r2 deepseek-flash | 1163 ms | 11.67 s | rick |
| (P2) | 671c0978 | "Say something encouraging..." / "for the drug home." (clipped) | fast, reply | r2 deepseek-flash | 1690 ms | 11.76 s | rick |
| P2 | 7eb92020 | "Use Walken voice." / "USE WALK VOICE" | fast, **tool** `car_set_voice(walken)` via skill, exit 0, 835 ms | r1 breaker_open, **r2 deepseek-flash** | 1211 ms | 13.99 s | **walken** ("Switched Holocene PM to Walken.") |
| P4 | 59c5e27c | "Switch to DeepSeek Pro." | **setting_phrase** (no LLM), `car_set_model(deepseek-pro)` via skill, 114 ms | none | - | 10.07 s | **walken** ("Holocene PM now thinks with Deep Seek Pro.") |
| P4 | 0c6e4691 | "Give me one tip for staying focused on a long drive." | fast, reply, tile_model deepseek-pro | pro-h `http_402` 174 ms, **pro-d deepseek-v4-pro** 8982 ms | 9157 ms | 29.27 s | walken |
| (P3) | 25f10c0b | "Make it sound like Morgan Freeman." / "It's like Morgan Freeman." (clipped) | fast, **reply**: "Do you want me to switch Holocene PM to Morgan Freeman's voice?" | pro-h breaker_open, **pro-d deepseek-v4-pro** | 4019 ms | 25.73 s | walken |
| P5 | 1306d2b9 | "Switch to auto." | **setting_phrase**, `car_set_model(auto)` via skill, 112 ms | none | - | 13.68 s | walken ("Holocene PM now thinks with the auto router.") |
| P5 | b2b2bcbf | "Name three things that make a road trip fun." / "...make a ro" (clipped at the end) | fast, reply, tile_model auto | **r3 automaticai/auto/fast -> glm-5.3**, served_route `automaticai/personal/glm-5.3` | 4060 ms | 16.76 s | walken |
| P3 | 922a6d46 | "Yes, make it sound like Morgan Freeman." | fast, **tool** `car_set_voice(morgan)` via skill, exit 0, 658 ms | **r3 auto/fast -> glm-5.3** (served `automaticai/personal/glm-5.3`) | 2567 ms | 14.39 s | **morgan** ("Switched Holocene PM to Morgan.") |
| P6 | 75420868 | "Tell me a fun fact about Honda." (routes override r1x/r2x unroutable, tile model cleared by CLI) | fast, reply | r1x `connect` 0 ms, r2x `host_down` 0 ms, **r3 auto/fast -> glm-5.3** | 4677 ms | 18.08 s (audible 20.28) | morgan |
| P7 | 714891a8 | "Use Rick voice." / "Use Rickface!" | fast, **tool** `car_set_voice(rick)` via skill, 656 ms | r1 `http_402` 199 ms (the 10 min breaker had expired: the self-recovery probe ran, Hyper still unpaid), **r2 deepseek-flash** 1285 ms | 1484 ms | 24.86 s | **rick** ("Switched Holocene PM to Rick.") |

Every `voiced`/`replied` fact carries the voice used (`rick`, `walken`, `morgan` as above); no `voice_fallback` occurred. No
answer came from an Anthropic model: answered models were deepseek-flash (DeepSeek API), deepseek-v4-pro (DeepSeek API) and
glm-5.3 (gateway auto/fast, route header `automaticai/personal/glm-5.3`). Raw rows: `runs/ladder-skills-turns.jsonl`,
`runs/ladder-skills-table.txt`.

## Scenario verdicts

| scenario | verdict | evidence |
| --- | --- | --- |
| P1 three conversational turns, rung + latency | **pass (with a finding)** | all three answered by **r2 DeepSeek API deepseek-flash** (1.4-1.9 s LLM) after r1 Hyper 402 / breaker_open. But turn 1 ("what are you working on right now?") was decided `direct` by the model and went to the full agent (the run's one Sol turn, 21.5 s). Stop->start 9.5 / 12.17 / 14.28 s: much slower than the earlier 6.8 s p50 (see Findings). |
| P2 "use walken voice" -> short-circuit, walken, persisted | **partial** | Voice switched, confirmation spoken in walken, next replies (P4 x2, P3a, P5 x2) in walken, persisted: `converse.json` `tiles.holocene-pm.voice=walken` (`voice_set_by: car`) and `memo:converse status` showed it. The **phrase short-circuit did not fire**: whisper heard "USE WALK VOICE" (two letters off "walken"; the fuzzy match allows one), so the LLM resolved it with the tool. The short-circuit itself is proven by P4 and P5 (model phrases); no voice phrase hit it live in this run. |
| P3 "make it sound like Morgan Freeman" -> tool -> morgan | **pass on the second memo** | First memo clipped to "It's like Morgan Freeman."; deepseek-v4-pro answered with a question instead of a tool call (a fair choice for that transcript). "Yes, make it sound like Morgan Freeman." -> glm-5.3 `action tool` `car_set_voice(morgan)` via the skill, confirmation and the next reply (P6) spoken in morgan. |
| P4 "switch to deepseek pro" -> pro route | **pass** | setting_phrase, no LLM; next turn pro-h 402 -> **pro-d deepseek-v4-pro** answered (8982 ms, 18 ms under its 9 s timeout); P3a also on pro-d (4019 ms). |
| P5 "switch to auto" -> auto/fast, non-Anthropic | **pass** | setting_phrase; next two turns answered by **r3 automaticai/auto/fast**, `model_answered glm-5.3`, `served_route automaticai/personal/glm-5.3`; no other rung tried (the alias put r3 in front). |
| P6 r1+r2 unroutable -> r3 auto answers | **pass** | flag-file `routes` override (`runs/ladder-skills-p6-routes.json`: r1x/r2x at 127.0.0.1:9, r3 = the unit's r3, so the scope proof keyed by (key, base) stayed fresh); r1x `connect`, r2x `host_down`, r3 glm-5.3 in 4669 ms. Override removed with `memo:converse on --clear-routes`; flag file read back with no `routes`, mode/agents/devices unchanged. |
| P7 reset to defaults | **pass (voice by tool, model by CLI)** | "Use Rick voice." heard as "Use Rickface!" -> LLM tool `car_set_voice(rick)`, confirmation in rick. "Switch to DeepSeek Flash." was not recorded (memo budget: the P3 retry took its slot); the model was reset with `mise run memo:model holocene-pm --clear` before P6. Final: `mise run memo:voice holocene-pm --clear` + `memo:model --clear`; `converse.json` `tiles: {}`, status "none: every tile speaks rick and thinks with the default ladder". |
| Speech never overlaps | **pass** | `speech_overlap.py` over the window: checks 1-3 and 6 pass (0 overlaps). With one offset for the whole window (-394 ms, measured at the end) check 4 flags 116-285 ms in the first (failed) recording and check 5 flags seven 50 ms edges; the measured offset drifted from -1432 to +57 ms over the run (host load). Re-run of the first window with its own offset (-1432 ms): all six checks pass. Files: `overlap/ladder-skills-overlap-off-394.txt`, `overlap/ladder-skills-overlap-first-window-off-1432.txt`. |

## Findings

1. **The desk sent a status question to the full agent.** "What are you working on right now?" was decided `direct` by
   deepseek-flash (a valid action), so it cost a Sol turn (21.5 s) and the driver heard the echo, then the agent. Fine on its
   merits, but anyone budgeting full-agent turns should know "what are you working on" goes there.
2. **Latency is 2x the earlier run.** Stop->start 9.5-14.3 s on r2 turns (earlier p50 6.8 s). The LLM is 1.2-1.9 s of it. The
   rest: the stop->upload gap was about 3.3 s on P1.2 (earlier p50 0.8 s), TTS 1.6-3.6 s for the first chunk, and the pad's two acks in
   front of the reply. On P1.3 the reply was halted twice with `focus_denied` before it played (+5.7 s). The sim host was
   loaded (clock offset jitter of 1.5 s across the run). Not re-measured on an idle host in this bounded run.
3. **deepseek-v4-pro is slow today.** 8982 ms on one turn (its timeout is 9 s) and 4019 ms on another; the earlier bench had
   1.96-3.6 s. With pro-h at 402, a pro turn is one slow upstream away from the default ladder.
4. **Sim input is the weak link, not the desk.** One recording failed in the native recorder; five of fourteen transcripts were
   clipped at the start ("You lost.", "for the drug home.", "It's like Morgan Freeman.") or the end ("...make a ro"), even with
   2.5 s then 4.5 s of lead-in. `mise run auto:sim:mic-check` was INCONCLUSIVE (the app's probe did not report) and restarted
   the app; after that, recordings worked. Two voice phrases came out mangled ("USE WALK VOICE", "Use Rickface!"), so the
   voice short-circuit never fired live; the LLM's tool call caught both. A prefix match ("walk" -> walken) next to the word
   "voice" would have caught the first; not changed in this run (no memo budget left to re-prove it).
5. **The Hyper breaker recovers by itself as designed:** P7's attempt log shows r1 tried again (`http_402`, 199 ms) once the
   10 min breaker had run out, then reopened. Hyper still needs a top-up.

## State left behind

Flag file: mode on, agents [holocene-pm], devices [e1c40830-...], no routes override, `tiles: {}`. Unit unchanged
(`MEMO_CONVERSE=off`). Watcher not restarted. Heartbeat: keys ok r1/r2/r3, r3 scope ok, tools car_set_model + car_set_voice,
r1 breaker open until 17:54:43Z (Hyper 402).
