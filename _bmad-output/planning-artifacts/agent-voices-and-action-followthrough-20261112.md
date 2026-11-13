# Agent-assigned voices and diagnosis-to-action follow-through

Prepared by `holocene-pm`, 2026-11-12 UTC, from the driver's explicit request that each agent speak in its assigned voice and that a diagnosis end with action or a concrete choice.

## Authorization and ownership boundary

The background continuation prohibits delegation, speech synthesis, deploys, restarts, pushes and other unauthorized live changes. The PM charter forbids application-code edits. Application implementation and independent review therefore require an authorized contributor execution path; this document is a handoff, not a claim that one has been started or queued. No application code, profile, running service, board ticket or deployed SOUL was changed for this investigation. The canonical shared instruction source was edited locally as the requested template-maintenance work; it was not propagated to employees.

Read the current repository and bound board before accepting this handoff. `.project.json` binds Holocene to Plane board `727a2b17-a1dd-46f6-b583-afa5a2d2cdae`, identifier `HOLOC`, workspace `33god`; `agents/hermes/pm/role.yaml` has no `board_scope`. A read-only board survey found HOLOC-23 already In Progress and assigned to Jarad with `agent:working`. Do not claim that ticket or duplicate its owner's work. Changes below overlap HOLOC-23's `inbox_watcher.py`, `converse.py` and `memo_trace.py` scopes: coordinate with that owner and use a board `--blocks` relation before concurrent overlapping implementation. No board lease was acquired because this pass did no selection/transition or board write.

## Verified source and running-state evidence

Holocene was on `main` at `17f639a7eee5ab3f0b8e521f9ed0c11804acf2c3` during the audit. There were unrelated dirty/deleted/untracked artifacts; none were reverted.

| Source | SHA-256 at audit |
| --- | --- |
| `services/inbox-watcher/inbox_watcher.py` | `e42d796738d4fbae7339f954420feb7993e2726c27c3d148d5ebb120e8762824` |
| `services/inbox-watcher/converse.py` | `282285f427f3d1a89d687cd84110dbb287baa5aa26e541577462568f8ea6dbf3` |
| `services/inbox-watcher/memo_trace.py` | `f22e45de7399bda14fada4ecf63749bc588d7912b04800a590991e147593e807` |

Read-only systemd/proc inspection: `holocene-inbox-watcher.service` active, PID `842479`, started `2026-10-22 23:34:38 EDT`. Its `MEMO_VOX_VOICE`, `MEMO_PROGRESS_VOICE` and `VOX_VOICE` were unset. The inspected `converse.json` had no tile voice overrides. This inspection establishes running configuration, not a proof that the process has reloaded the latest on-disk Python.

### Profile authority and executable reproduction

The agent registry maps the three inspected agent IDs to identically named `profile_name` values. Read rendered `~/.hermes/profiles/<profile>/config.yaml`, not a hand-maintained voice map.

| Agent | `tts.voice` | `tts.vox.voice` | Current unchanged reply resolver |
| --- | --- | --- | --- |
| `holocene-pm` | `carlin` | `carlin` | `rick` |
| `infra-pm` | `brule` | `carlin` | `rick` |
| `flume-pm` | `carlin` | `carlin` | not exercised |

The two-agent reproduction parsed the current Python with `ast`, compiled the unchanged `Watcher._reply_voice`, `Watcher._tile_voice`, `Desk.voice_for` and `Desk.tile` method nodes plus the unchanged `VOICE` assignment, and executed them with in-memory memo/desk holders. No service import, network call, synthesis, audio playback, or persistent memo write occurred. Both agent inputs locked Rick despite distinct assigned profile voices. This is a reproduction of the defect, **not** a passing implementation test.

Persisted watcher state independently confirms real recent replies selected Rick directly, not as a missing-voice fallback:

- Memo `1b0d368e-3fa3-5fe5-a7d0-cd8e0530e6bc`, profile `holocene-pm`, reply stamp `2026-11-12T00:42:56.872Z`: `voice_lock.voice=rick`, `requested=rick`, `fallback=null`.
- Memo `c09da683-b2d4-5fbb-bcd7-8631c59e8920`, profile `holocene-pm`, reply stamp `2026-11-12T00:41:04.741Z`: same voice-lock fields.

## Required voice correction and test contract

Use one authoritative profile-backed lookup rather than writing copies of voices into `converse.json`, service environments or another agent roster. This follows **Dogfood the Platform** and **Build LEGO, Not Statues**: an Adapter around rendered profile configuration should serve existing reply and cue call sites, not another independent voice registry.

1. Resolve the **responding** agent/profile. For completed full-agent replies, use the gateway-confirmed memo profile; for fast desk replies use the tile's registered `profile_name`; for named-agent delegated follow-ups resolve the actual target, not automatically the original tile. Existing `step_await_agent` records `m['profile']`; existing `CardCache` already resolves registry `profile_name`. Validate identifiers and paths, preserve supported profile-root/registry overrides, and refuse path traversal.
2. Default to the responding profile's valid, nonblank `tts.voice`, then valid `tts.vox.voice`. Infra PM proves why top-level voice must win when the fields differ. The Vox provider also honors a per-agent `VOX_VOICE` process pin; verify any relevant registered execution pin instead of accidentally adopting the watcher process's environment as another agent's voice. Do not read arbitrary dotenv files or execute profile shell exports.
3. Preserve an explicit deliberate car-only tile override for a verified car-origin memo; without one inherit the assigned agent voice. Browser/non-car memos must not inherit a car-only override. Keep `MEMO_VOX_VOICE`/Rick only as an observable last-resort fallback for missing/malformed/unreadable profile data or an unavailable requested voice. Do not relabel an emergency fallback as the assigned voice.
4. Preserve per-`reply_stamp` voice locking: chunks, joined audio, retry and resume of one reply must agree. A new follow-up round may resolve again. Use the replying target for cross-agent follow-ups, including after the target's rendered config changes.
5. Apply the same resolution contract to narration/progress, hold cues, phrasebank keys, heard/error lines where attributable, and operator diagnostics. Do not leave `_narrate` or hold cues on the global Rick fallback. Preserve an explicitly authorized progress override and report it truthfully.
6. Fix reset semantics in **both** `Desk._builtin_tool` and `memo_trace.cmd_voice`: `default`/clear removes a deliberate override and returns to the assigned agent voice. A named request such as `use Rick voice` is an explicit choice, even when Rick equals the emergency fallback. Existing code clears Rick instead, which would defeat profile inheritance. Keep the car-set-voice skill entrypoint and builtin path consistent.
7. Update `memo:voice`, `memo:converse`/tile diagnostics, heartbeat fields and README text (including the car-only default description) to distinguish inherited voice, deliberate override and emergency fallback. Reuse existing event contracts rather than inventing new event types.
8. Avoid stale caching: invalidate profile-backed decisions when rendered config, registry routing or the override file changes, without changing the locked voice of an already-rendering reply. Missing or malformed mappings must fail safely without preventing the response.

Required isolated tests (mock the synthesis boundary; do not generate audio during this restricted pass):

- Two registry-mapped profiles with distinct voices: Holocene PM -> Carlin, Infra PM -> Brule.
- Agent ID different from `profile_name`; gateway-returned responder profile; tile A delegating to agent B.
- Top-level voice wins over mismatching nested Vox voice; valid nested fallback; blank/non-string/malformed/missing/unreadable config and invalid/missing profile routing.
- Deliberate car override; non-car memo ignores that override; clearing restores assignment; explicit Rick stays explicit in CLI and builtin tool paths.
- Voice lock preserved across chunks/retries/resume, reset on the next reply stamp; mid-reply config changes do not mix voices.
- Missing Vox voice produces an explicit recorded fallback, not repeated retry exhaustion.
- Narration, hold cues, phrasebank and final reply agree with the applicable responder; cue warm-up does not force Rick.
- Diagnostics expose effective voice and why it was chosen without printing credentials.

Use the relevant watcher unittest suites (`test_car_desk.py`, `test_inbox_watcher.py`, `test_hold_cue.py`, `test_converse_pipeline.py` and follow-up suites) only after checking their import-time effects and isolating state/network/audio. The existing two-agent probe deliberately avoided importing the watcher harness. Do not treat a test harness's fake Vox output as live audible proof. Independent spec and quality review remain required by the PM charter; this pass performed neither delegated gate.

Production propagation and an end-to-end live two-agent verification remain separate work under explicit live-change authorization. No restart, deploy, push, or TTS was performed here.

## Shared diagnosis-to-action instruction edit

Canonical local change: `~/code/33GOD/flume/roles/_base.md`, new section **Close the loop: diagnosis needs a next step**. It applies to all repository-role compositions, not only PMs. The rule requires:

- Act on clear, scoped, reversible corrections within existing intent and authority, then report verification; do not re-ask granted permission.
- When a real choice or authorization boundary remains, recommend an option and ask one concrete question.
- State blockers and next ownership explicitly; never imply work is running or queued when it is not.
- Distinguish recommendations, local edits, tests and verified live effects; never bypass review or operational restrictions.

Verification actually executed:

- `node tests/soul-project-bank-regressions.mjs`: all assertions passed.
- Source-bundled `composeSoul()` assertions passed for `dev`, `director`, `em`, `launch-director`, `paired-launch-director`, `pm`, `reporter`, `review`, and `_default.md` via an unknown-role fixture (9 compositions). Each contains the new section exactly once, all key clauses, the unchanged canonical Candybar section, and no unresolved `{{` placeholders.
- `git diff --check`: passed for the local Flume edit.
- `flume remediate hermes.pm-scaffold ~/code/33GOD/holocene --dry-run --json`: reports new SOUL composition but overall `ok:false`, `status:partial`; pre-existing modified `.scripts/01-config.sh`, `.scripts/_lib.sh` and `.scripts/config.example.toml` are preserved, and it also proposes unrelated `.scripts/80-registry.sh` refresh. Do not describe the dry-run as a clean remediation or apply it blindly.

Scratch render preview and assertion output: `/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/agent-voice-followthrough-20261112/holocene-pm-preview.md` and `render-checks.json` (ephemeral, not the durable source). No deployed SOUL was edited. The local source change is uncommitted and unpushed.

### Propagation gaps to retain

Portable named specialists have a separate projection path: `packages/flume-hr/src/workforce/scheduling.ts` appends only the bounded Candybar scheduling policy to the specialist charter. Editing `_base.md` alone does **not** prove the new conversational rule reaches those employees. The Flume owner must extend the canonical shared-instruction projection with tests and independent review before claiming universal deployed coverage.

The car fast desk's `converse.py` has its own `SYSTEM_RULES`, and `CardCache.build()` includes only the first 1500 characters of a deployed SOUL. The new section lies beyond that window, so even a future SOUL refresh does **not** guarantee the fast desk receives it. A contributor must wire a maintained canonical instruction source or explicit equivalent fast-desk behavior and test it, without changing the draft-confirmation/permission guard. No such prompt-code edit was made by this PM.

## Resume without losing the boundary

Use this handoff to create/coordinate scoped work only when board writes and contributor execution are authorized; check the board again first. The voice fix has not been implemented, no worker has been dispatched, and neither the voice change nor the guidance has been applied to live services or profiles. The next implementation owner is an authorized Holocene contributor; shared projection and propagation belong to Flume's owner. No operator choice about the desired behavior remains: the driver already asked for both fixes.

## Follow-through pass: owner handoff verified, 2026-11-12 01:21 UTC

`holocene-pm` resumed the driver's request without subagent delegation, speech synthesis or live-service changes. Read both project and identity memory; checked the current board, registry-backed profiles and running watcher. This section supersedes only the earlier statement that no board write had happened; it does **not** claim implementation or live correction.

### Fresh execution evidence

- HEAD remains `17f639a7eee5ab3f0b8e521f9ed0c11804acf2c3`. The three source hashes in the audit table still match; no diff exists in `inbox_watcher.py`, `converse.py` or `memo_trace.py`.
- `holocene-inbox-watcher.service` remains active with PID `842479`, start `2026-10-22 23:34:38 EDT`. Its voice/root override environment variables are unset. The inspected flag file has mode `on`, tiles `{}`. This proves process identity/configuration, not the version of code loaded in memory.
- Current rendered assignments remain `holocene-pm -> holocene-pm -> carlin` and `infra-pm -> infra-pm -> brule`; Infra's nested Vox voice is `carlin`, confirming top-level `tts.voice` precedence matters. The registry contains no `holocene-dev` entry; no contributor identity was invented or invoked.
- Re-executed the unchanged AST-extracted `Watcher._reply_voice`, `Watcher._tile_voice`, `Desk.voice_for` and `Desk.tile` with in-memory car-origin memos, actual flag data and the watcher's effective default. Both agents select `rick`, with `requested=rick`, `fallback=null`. Assertions prove the current defect reproduces; they are not a passing implementation regression suite. No synthesis, network call or persistent memo write occurred in this probe.
- Latest inspected persisted Holocene car reply: memo `38be5062-8f03-55fe-98b1-c335679be592`, reply stamp `2026-11-12T01:18:04.262Z`, profile `holocene-pm`, `voice_lock.voice=rick`, `requested=rick`, `fallback=null`, sender host `car`, status/stage `done`. Of 84 inspected Holocene locked memos, recent replies still request Rick directly. No Infra memo with a voice lock exists in the inspected state. Therefore actual two-agent car-path correctness cannot be claimed, and no synthetic test memo was injected to manufacture it.

### Board coordination actually completed

Bound board remains HOLOC/`727a2b17-a1dd-46f6-b583-afa5a2d2cdae`, legacy mode. HOLOC-23 is still In Progress and assigned to Jarad DeLorenzo. Its last pre-existing comment was from October 22; `agent:working` is a board claim, not fresh worker-execution evidence. Surveyed all 26 tickets and checked adjacent HOLOC-26; no duplicate voice-inheritance ticket or overlapping worker was created.

Posted and independently read back one handoff comment on [HOLOC-23](https://plane.delo.sh/33god/browse/HOLOC-23/):

- Comment ID: `a070b1e1-99f0-4dae-9963-32c3892ddd7b`.
- Marker: `[holocene-pm:voice-followthrough-20261112]`.
- Provider creation timestamp: `2026-11-11T20:21:39.505313-05:00`.
- Preserved state, assignees, labels, description, priority and parent on bound read-back. No ticket was claimed, moved, closed or newly created.
- The comment addresses the existing owner and carries source/runtime evidence, all eight voice-resolution requirements, isolated acceptance cases, separate independent SPEC/QUALITY gates and explicit authorized-production/two-agent verification gates. It is a recorded handoff request, not owner acceptance, a started worker, a passed review, merge approval or a deployed fix.

The actual launcher `agents/hermes/pm/.scripts/heartbeat.sh` sets its lease to `agents/hermes/pm/runtime/wip-driver.lock`. The root `runtime` and role `runtime` directories are **not** the same inode here, and the root `.scripts/momo-wip-lock.py` does not exist. Used the launcher's existing lease path and helper, never created a competing root lease. Owner was exactly `hermes:holocene-pm:voice-followthrough-20261112`: acquired at default TTL, refreshed during the short write/read-back, released in `finally`. Both lease locations were free before the pass. No runtime wiring was repaired or changed.

### Decision and remaining boundary

Chosen: reuse the existing HOLOC-23 owner and one profile-backed resolver/Adapter, rather than dispatch a duplicate implementer or copy voice maps into car settings. Basis: **Dogfood the Platform (#2)**, **Build LEGO, Not Statues (#3)** and global **`it-behaves-like-it-looks`**. These bases are recorded in the verified board comment; no task/board facts were emitted by this PM.

Implementation, independent review and live two-agent verification remain undone. This PM cannot write application code, this invocation forbids launching a subagent, and the driver's status request did not clearly authorize deploy/restart/push. The handoff is now visible to the existing owner, but no contributor acceptance or execution is proven. No speech was generated, no application/config/profile/car setting was changed, and no service was deployed or restarted. The next executable step belongs to the existing owner/authorized contributor under a permitted implementation invocation; a later authorized propagation phase must still prove the real car-path result. There is no unresolved product-choice question for the driver.

