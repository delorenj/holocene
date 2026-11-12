# HOLOC-23 assigned voice release evidence

Recorded by `holocene-pm`, 2026-11-12 UTC. This supersedes earlier investigation-only handoffs for the bounded assigned-voice correction, not the rest of HOLOC-23's acceptance criteria.

## Authorized implementation and independent gates

The operator explicitly requested build and deployment. One external `codex exec` implementer, thread `01a1cd5f-569f-7863-9fbc-6054b74d6e84`, performed all application changes. The PM wrote no application code. Original foreground carrier timed out at 600 seconds; the same worker resumed, rather than a duplicate implementer. Two independent reviewers repeatedly reproduced concrete defects; the same implementer corrected them before activation.

Final independent reports:
- SPEC PASS: `~/.hermes/profiles/holocene-pm/cache/scratch/holoc23-voice-fix/spec-cleared.md`.
- QUALITY PASS: `~/.hermes/profiles/holocene-pm/cache/scratch/holoc23-voice-fix/quality-cleared.md`.
- These are review findings, not merge approval. No merge was performed or approved.

Verified commits:
- Holocene `abfa3ac6123c8457e87a3e5a84af942172fd7263`, `fix(voice): inherit assigned voices and preserve car workflow parity`, 13 scoped files. Includes the separately owner-integrated HOLOC-27 prompt/workflow hunks and tests; they were preserved, not reimplemented.
- Canonical `~/code/skillex/all-skills` catalog `791b6c12d899c451382752c486f7e5f6411ccf4a`, two `car-set-voice` descriptor files. Live car-desk tool descriptor resolves to that canonical file and matches it.
- Both commits verified with `git show` and committed blob comparisons. No push. Unrelated docs deletions, runtime and planning artifacts remain untouched; no parent catalog submodule pointer was committed.

## Delivered behavior

One Adapter reads registered `profile_name` and rendered `tts.voice`, then nested Vox voice. Actual gateway responder and named followup target are respected. Verified-car-only explicit overrides remain; explicit Rick is distinct from reset/default. Reply and cue identity locks survive chunks/retries/resume; stale in-flight cue failure cannot mutate a rendered/new-round final lock. Missing catalog voices have explicit fallback provenance; diagnostics distinguish configured, effective and unknown availability. Catalog failure has cooldown; optional warming does not block startup.

A reviewed scope simplification makes transcript acknowledgement text-only. It retains `status.heard` for observability but does not speak private transcript through native Android TTS or a new server clip. Normal assigned-voice progress, hold and final/error audio remain enabled. This avoids a spoken-feedback-policy regression and does not require a Kotlin/APK update. Listed progress audio is capped to the committed `spoken_seq`, never raw gateway `progress_seq`, so an orphan/unannounced later object cannot be selected.

Decision basis: **Dogfood the Platform (#2)** and **Build LEGO, Not Statues (#3)** favor rendered profile authority and shared resolution over a duplicated car voice roster. Simplifying redundant transcript readback preserves the existing privacy/feedback boundary without inventing native release machinery.

## Execution checks actually verified by the parent

- Full final watcher discovery: `python3 -B -m unittest discover -s services/inbox-watcher -p 'test_*.py'`: **501 tests, 0 failures/errors, exit 0, 160.924 seconds**.
- Final Agent Pad `npm test` on parent Node v26.5.0: **78 tests, 78 pass, 0 fail/cancelled/skipped, exit 0**.
- Worker also verified Node v26.13.0. A real parent failure on both Node 26 versions exposed unsupported `stripTypeScriptTypes(mode='transform')` in two new test harnesses; worker changed only those two options to `strip`, preserving production hashes. Final parent rerun passed.
- `pnpm --filter @holocene/api typecheck`: exit 0.
- `pnpm --filter @holocene/web typecheck`: exit 0.
- Original two independent adversarial assertions independently rerun by parent: **2 pass, exit 0** (stale narration race and Ghost diagnostic mismatch).
- Reviewer unchanged actual-page closure checks: SPEC **3/3**, QUALITY **9/9** after sequence bound correction.
- Parent scoped whitespace check passed.

Raw logs, exit receipts, worker/reviewer transcripts and detailed preservation proofs are under `~/.hermes/profiles/holocene-pm/cache/scratch/holoc23-voice-fix/` (scratch, not a permanent archive).

## Production propagation proven

1. Verified `agent-pad-web` container bind mount serves this repo's `apps/agent-pad/dist` and Compose project `agent-pad`; no assumption that component-local Compose owns it.
2. Executed `mise run pad:build`: **exit 0**, Vite production build, 26 modules. This writes the live nginx-mounted `dist` (generated deployment artifacts, not application-source edits).
3. Public HTML exactly matched local `dist/index.html`; downloaded public asset exactly matched local bytes:
   - `https://agent-pad.delo.sh/assets/index-BfDr3Th3.js`
   - 280681 bytes, SHA-256 `a85d873c972bdc6a06e2c107321df2e2bd71a022f1eadf1ce74eb831bbe28441`.
4. Real Chrome/Kapture tab loaded public Agent Pad, rendered agent tiles, exposed that exact script URL, and returned no console errors after navigation. No record/send/playback interaction was triggered. The driver device was not remotely reloaded.
5. Installed a service execution-only drop-in `~/.config/systemd/user/holocene-inbox-watcher.service.d/voice-warmup.conf` with `MEMO_PHRASEBANK_WARM=0`; no schedule/timer was created. It disables proactive startup synthesis while preserving cached phrases and ordinary requested responses.
6. Executed `systemctl --user daemon-reload` and authorized watcher restart. Running PID **78382**, start **2026-11-11 21:59:45 EST** / **2026-11-12 02:59:45 UTC**, active/running. `/proc/78382/environ` confirms warmup pin `0`; cwd is this repo's watcher directory. Journal shows normal startup, no phrasebank warming.
7. Persisted live heartbeat at **2026-11-12T03:03:12.519Z**, produced by PID 78382, proves loaded profile-backed diagnostics:
   - `holocene-pm`: `voice=carlin`, `requested=carlin`, `source=inherited`, `effective_voice=carlin`, `availability=available`, `fallback=null`, `voice_own=false`.
   - `infra-pm`: `voice=brule`, `requested=brule`, `source=inherited`, `effective_voice=brule`, `availability=available`, `fallback=null`, `voice_own=false`.
   - `voice_default=profile`; Rick is explicitly `emergency_voice`, not either agent's ordinary assignment.
8. Parent read-only `memo_trace.py voice <agent> --json` independently returned the same available/inherited voices. These CLI results are corroboration, not a replacement for the running heartbeat.
9. Reviewed on-disk production hashes match committed blobs and independent reports:
   - watcher `dabab038db29bc2fca2f384f934d96513ac9415ea5288789e2a9d86b21fc2b7d`
   - converse `25b51f42514b58fb7c12998ebc0e6adec941f7c917897da99e4ca1b86cc8ead4`
   - trace `83b2030d87f009432f08b3032f377fa934b0beffcce027be97fa5b1f2ddffa77`
   - pad main `9c4f282a1a37b5591d38031957a4d96357afdddc055a5488b1ab310a2e1423cf`.

## Acceptance boundary — do not overclaim

No speech synthesis, synthetic live memo, playback trigger or vox-speak was run by this carrier or workers. No post-restart natural reply with the new `voice_lock.source` metadata was present in the inspected persisted state. In particular, actual two-agent car playback, device adoption of the new web bundle and post-release reply locks remain **unverified**. The running service's correct two-agent available selection is production evidence, but is not audible proof. Do not close the full HOLOC-23 ticket or claim the driver heard both corrected voices on this evidence.

No phone/APK update is required; an already-open Agent Pad must load the new served page. This carrier did not force a reload on the driver's device. No API/web dashboard source changed; API health returned ok and the dashboard public route returned its expected authentication redirect.

A pre-existing fast-desk token scope warning remains visible (`converse_scope_unproven`, Anthropic routes present in the token scope); it predated this release and was not altered. No voice acceptance claim is inferred from model-routing health.
