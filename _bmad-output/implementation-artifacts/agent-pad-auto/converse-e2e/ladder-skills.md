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

## Review round (2026-10-22 ~18:20Z, commit 0eeb69b, no sim)

Each review finding, what was done, and how it was re-verified. Live checks were direct one-offs (the watcher's own `Ladder`,
`Desk`, `ToolBox` code against the real providers and the real skill scope), the CLI verbs and the heartbeat. The sim was
not used: no fix changes what a normal turn says; the two phrase changes were checked on the exact live whisper strings.

| # | finding | verdict | re-verified |
| --- | --- | --- | --- |
| 1 (major) | `aai/` gateway spelling bypassed the guard (`aai/auto/orchestrator` usable on any key) | **fixed**: `_clean_name` maps `aai/` to `automaticai/` (the gateway's `CanonicalModel`) before every check; routes are stored and sent canonical | live `parse_routes` on the unit's scoped refs: `aai/auto/orchestrator` and `aai/auto` on a hermes ref -> `forbidden_model`; `aai/auto/fast`, `aai/free` on it -> `auto_unscoped`; `aai/auto/fast` on holocene-converse -> usable as `automaticai/auto/fast`, scoped. `mise run memo:model holocene-pm aai/auto/orchestrator` refused. Unit tests for all spellings incl. `AAI/`, `Aai/Auto/Fast` |
| 2 | a tool timeout left the skill's child writing converse.json later | **fixed**: `ToolBox.run` starts the entrypoint in its own session and `killpg`s the group on timeout | the reviewer's probe on the real `car-set-voice` skill with a memo_trace stand-in that sleeps 4 s then writes: old code (HEAD~1) marker present 4.5 s after the 3 s timeout; new code absent. The real skill end to end still 1268 ms, exit 0 |
| 3 | a non-string `model` in an answer passed the response check | **fixed**: `forbidden()` is True for any present non-string; the attempt shows it as JSON | unit tests (list, object, `{"id":"glm-5.3"}` all `forbidden_model`); no real provider returns one |
| 4 | budget 12 s left r3 3 s after r1 + r2 timeouts; pro-d 18 ms under its 9 s timeout | **fixed**: unit `MEMO_CONVERSE_BUDGET_S=16` (= 4 + 5 + 7); alias deepseek-pro: pro-d 12 s, budget 20 s | heartbeat / `memo:converse status`: budget 16 s; a test asserts budget >= the sum of the rung timeouts for the unit ladder and the pro alias. r3 measured 4.3-5.7 s now, and twice hit its 7 s timeout in 3 calls at 18:14Z (transient: the next 3 were 4.3-4.7 s) |
| 5 | `automaticai/free` picks outside the token scope; docstring overstated the bound | **fixed (after the fact)**: a router answer whose `X-AutomaticAI-Route` is not a name the scope proof listed is not used (`route_out_of_scope`); docstring and README say plainly that free's pick is bounded by the gateway's free policy, not the scope | live: scope proof 35 ids, none Anthropic; free x2 answered from `agnes-ai-free/agnes-3.0-flash` and `kilo-anon/nemotron-3-ultra-550b-a55b`, both in scope -> used; r3 auto/fast served `personal/glm-5.3` -> used. The prompt still reaches the free route before the check; the free alias stays opt-in |
| 6 | prompt said "You have no tools" next to a TOOLS block | **fixed**: "no live data, and no tools except the desk's own settings listed under TOOLS"; OUTPUT FORMAT names `tool_name`/`args` | live through r2 with the real card (7.2k chars) and the real tools: "Make it sound like Morgan Freeman." -> `tool car_set_voice(morgan)` 2/2 (958, 1266 ms). "What are you working on right now?" -> `direct` 3/3 and "Is the build on main green right now?" -> `direct`: the model reads "right now" as live state; that routing choice was left as is |
| 7 | tile voice applied to every reply of the agent (browser memos, the real Honda) | **fixed for non-car memos**: the tile voice is used only for a memo the car sent (sender read once from S3 metadata, only when the tile has its own voice); browser or unreadable sender keeps the default. **Per device is by design** (spec: per-agent car voice): a voice set from the sim also speaks on the Honda, so a sim run must clear it (README says so) | unit test (browser, unknown sender, unreadable, car); the live tile map is `{}` |
| 8 | the voice phrase short-circuit never fired live | **fixed**: nearest voice within one edit of a five-letter name or two of a longer one (four or more letters heard), unique nearest only; "face", glued or not, is the word voice | the live vox catalog (12 voices) through `Desk.setting_phrase`: "USE WALK VOICE" -> walken, "Use Rickface!" -> rick, "Use the walkin' voice!" -> walken, "Switch to DeepSeek Flash." -> deepseek-flash; "use the interface" and the question -> none |
| 9 | Hyper never seen answering | **left** (operator action: top up Hyper) | r1 still `http_402` in 200 ms at 18:14Z |
| 10 | old runs/s11*.json overrides name the Hindsight item | **fixed in the desk** (evidence files kept as history): `parse_routes` refuses any route on that item (`key_retired`) | test: s11a's two Hindsight rungs are refused, the rest parse |

Tests: 374 (8 new), full watcher suite green. Deployed: `daemon-reload` + restart at 18:18:35Z with the heartbeat showing
`active: []` (no memo in flight). After the restart: `starting converse_budget_s 16`, tools car_set_model + car_set_voice
loaded, keys ok r1/r2/r3, r3 scope ok. Flag file unchanged (mode on, agents [holocene-pm], devices [sim], tiles {}); unit
still ships `MEMO_CONVERSE=off`.
