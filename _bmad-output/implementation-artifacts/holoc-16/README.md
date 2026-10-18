# HOLOC-16 voice reliability slice

Diagnosis: `_bmad-output/planning-artifacts/telegram-voice-transport-20261018.md` and the HOLOC-16 ticket comments.

| Change | Commit |
|---|---|
| Transcribe wrapper: fast lane for short `--ephemeral` clips, clean runner env, model-aware VRAM floor, `--ephemeral` ported; `~/.local/bin/transcribe` and `hermes-transcribe-adapter` symlink into HeyMa | delorenj/HeyMa 2d0551f, 45dde04 |
| Hermes adapter: `--no-diarization`, clean env, YAML frontmatter stripped | delorenj/HeyMa 2d0551f |
| Bloodbank gateway turns never auto-voice (no discarded synthesis) | delorenj/bloodbank 5b479af |

Independent reviews (`reviews.json`): SPEC PASS_WITH_NOTES, QUALITY PASS_WITH_NOTES. The one major finding (Wax 60 s
segments eligible for the fast lane) is fixed in 45dde04 (fast lane is `--ephemeral`-only). Accepted notes: the fast
lane drops diarization for short interactive clips under contention (by design); `/voice all` on a Bloodbank chat
would still synthesize (no such chats exist; memo chat ids are fresh per memo); clips over 120 s still queue behind
long jobs.

Live proof: memo 2724ae89 COMPLETE in 43 s, transcribed in 4.96 s, `invocation.completed` 34 ms after the response
(was +3.9 s), one reply synthesis, no `send_voice fallback`. Adapter under a held heavy lock: 6.2 s clip in 4.8 s.
