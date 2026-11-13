---
id: SPEC-holocene-auto-async
companions:
  - routing-and-acceptance.md
sources:
  - /home/delorenj/d/Transcripts/audio_f3d09f42a4d7.md
  - /home/delorenj/d/Transcripts/audio_c1b43c4e02ce.md
  - /home/delorenj/.hermes/profiles/33god-pm/cache/scratch/agent-bound-record-button-findings-20261011.md
---

# HOLOC-12 — Asynchronous opt-in voice follow-up

Planning course correction derived from this folder's append-only memlog. It updates the existing intake, not authorization for a broad redesign or another implementer. The synchronous-first brief (command `2eccc85d-c996-452b-afe1-f97c6c625b7b`) is superseded; historical diagnostic evidence remains separate.

## Why

Jarad wants useful access to existing agents while iterating. Long phone recordings already become vault transcripts on his own system; agent replies take time. Preserve native recipient discovery while deliberately routing selected memos for later execution and real delayed results, without requiring a car conversation or opening crowded Telegram contacts.

## Capabilities

- **CAP-1**
  - **intent:** Identify one real existing recipient without sending a prompt on selection.
  - **success:** Native directory uses the fleet roster, including Grolf → `33god-pm`, Recent first then stable order, last selection and truthful stale/unavailable/disconnected states. Tapping alone dispatches nothing.
- **CAP-2**
  - **intent:** Deliberately record a long memo for a selected existing agent using an agent-bound record button.
  - **success:** At capture start, snapshot explicit Boolean agent intent and exact `target_agent_id` against THAT immutable recording/source identity. Carry validated, provenance-protected binding through upload/ingest/enrichment/finalize; the finalized full exact transcript reaches the bound eligible profile without needing a spoken wake prefix. Missing/false intent remains a note; unknown/ambiguous/conflicting/mutated or untrusted binding holds without dispatch.
- **CAP-3**
  - **intent:** Know execution status and receive the actual agent result later.
  - **success:** Memo, recipient, command and real result remain correlated; queued/running/answered/error/cancelled are distinct. The actual answer reaches an authenticated existing operator notification surface. Invocation completion is not an answer.
- **CAP-4**
  - **intent:** Avoid duplicate execution and wrong recipients despite delayed transcription.
  - **success:** Stable recording/source identity and immutable recipient govern dispatch. Rename/rewrite/replay/restart, multiple devices, stale selection, offline retry and cancellation never silently re-target or launch the same memo twice; uncertain post-start outcome is reported honestly.

## Constraints

- Reuse Syncthing's flat receiveonly audio feed and Wax's copy/archive/transcribe/enrich/finalize pipeline. Preserve original audio and transcript; no dropoff or unrelated vault writes.
- Current first candidate: an agent-bound capture-start button plus ONE trusted HeyMa-owned adapter consuming the existing finalized `bloodbank.audio.transcription.completed` fact. Replace prefix-first/deferred arming with immutable recording-specific binding; selection alone sends nothing. Never arm a generic next completion or infer consent from speech, titles, filenames or mutable frontmatter. See companion for carry/trust, exact-content, correlation and dedup requirements.
- Use existing fleet identities and `bloodbank.cmd.agent.invocation.start` routing. No per-profile filesystem inboxes, per-agent pollers, replacement pipeline/runtime, invented types, direct inter-service bypass, bot secrets in the car or fabricated Telegram identity.
- Holocene owns directory/selection/status; HeyMa owns transcript readiness/opt-in routing; Bloodbank/Flume own contract/result seams. Existing BB-30 is a dependency, not a delivered capability.
- Same `codex-holoc12-1` session/worktree is the future implementation carrier, WIP=1. Do not replace an in-flight review or claim old-scope SPEC/QUALITY as async acceptance. PM writes no application code and approves no merges.
- Keep HOLOC-10/11 open and their exclusions intact. Preserve capture/cancel/teardown, permissions and restricted/unknown-host safety. Later native delivery requires authentic AAOS captures, tests/build, independent SPEC then QUALITY, reviewed signed internal distribution and a separate Civic recheck.

## Non-goals

- Synchronous two-way car-chat proof first, streaming/new car ASR pipeline, immediate audible response, always-listening or wake words. A supported agent-bound capture client is required; this pass implements none and does not claim current AAOS diagnostics upload.
- Build all candidate mechanisms. Prefix-only fallback, generic next-completion arming, always-listening and spoken directory selection are not the first slice. Capture-start recording-bound intent is now requested, not deferred. This planning change does not make the diagnostic AAOS button an uploading recorder or add a route flag to current Wax capture.
- Treat every note as an instruction, summarize the spoken prompt, infer tickets, or equate notification of lifecycle completion with a real answer.
- Broad fleet reconfiguration, another implementation worker, public release or closure of historical diagnostic tickets.

## Success signal

One new real memo recorded with explicit true start-time binding and no required spoken prefix follows the existing ingestion/finalization path. The exact existing agent receives the unabridged prompt, with durable duplicate-suppression evidence, and Jarad receives a real delayed answer. Preserve the existing correlation chain when present; command causation is the completion event. Negative cases remain notes/held or truthful errors. Do not promise global exactly-once; native, result-publication, operator-delivery and physical-car proofs are separate gates.

## Assumptions

- Current consent rule is explicit and fail-closed: valid immutable true binding routes to its exact eligible target without a prefix; missing or explicit false binding stays a note even if speech begins with `Hermes, Grolf`. A bound-route conflict never retargets; it holds. Prefix-only fallback is superseded/deferred rather than silently overriding false intent. Grolf remains exactly `33god-pm`.

## Open Questions

- **Recovered:** HeyMa's original read-only assessment command `3cbb0a02-2a95-4c98-92e7-6e4195b59097` completed successfully at `2026-10-10T22:06:46.089362Z`. Receipt `/tmp/grolf-heyma-auto-async-intake-20261010.json` and Candystore terminal event `fbed7f85-5b7f-545f-b3f8-47767a14bff2` were read back by holocene-pm. It establishes a suitable existing finalized Wax seam, not implemented routing or result delivery; no duplicate assessment/worker is authorized.
- **Still open, owner readiness:** HeyMa must establish a supported capture-start binding transport, runner-owned/provenance-protected metadata carry through ingest/enrichment/finalize, trusted source/full-content handling, stable recording identity and durable consent/target/prompt/command/cancel dedup. Open `data.metadata` is a carry candidate, not proof arbitrary frontmatter is trusted. Current Wax `capture.start()` accepts no agent/route flag; stock phone dropoff carries no binding; current AAOS action is diagnostic-only with no persistence/upload. Bloodbank/Flume must establish authoritative full final-answer publication and authenticated delayed delivery separately. BB-30 remains In Progress; lifecycle completion or historical repair/review is not live acceptance.

## Coordinated disposition — 2026-10-10

holocene-pm applied this course correction under the shared driver lease after the existing review pass became safe. Original native UX SPEC PASS then QUALITY PASS at `61a7b4451365244055faa60ab8fbfd855e568d80` remain historical-slice gates only; async CAP-1–4 are unproven. HOLOC-12 remains open, with the companion's six acceptance criteria promoted to the board's next-slice contract. Original intake, implementer evidence and independent review files are preserved. Signed internal distribution and separate Civic verification remain outstanding; HOLOC-10/11 are not altered or closed.

Next slice is **queued behind HeyMa/result-seam owner readiness, not dispatched or resumed**. Future carrier remains `codex-holoc12-1`, native session `01a127b5-8f0a-7cc1-a79d-e6cf2869ca95`, same worktree `.worktrees/holoc-12-auto-ux`. First future proof is one fresh opted-in normal phone memo → exact existing profile receives the full prompt → actual delayed operator answer, with the companion's negative cases. Not a synchronous car round trip or local microphone check. No operator sign-off parking, PM application-code edits, merge approval, replacement worker, broad redesign or fleet reconfiguration.

Basis: canonical `~/code/33GOD/momo/PILLARS.md` Pillar 2 — Dogfood the Platform and Pillar 3 — Build LEGO, Not Statues.

## Recording-bound supersession — 2026-10-11, NOT IMPLEMENTED

Operator transcript `audio_c1b43c4e02ce.md` and command `fe93361b-42a5-570a-a710-89a8cf625b2b` promote the previously deferred record-start binding to current acceptance. The read-only scout findings are input, not acceptance: this contract corrects their prefix fallback, correlation reset and exactly-once shorthand. The companion's six revised ACs and the SAME dependency-held queue govern; historical 2026-10-10 intake, source, review and coordination receipts are preserved. Holocene coordinates capture UX plus existing HeyMa capture/carry/router ownership, with BB-30 real-answer publication and operator-delivery proofs still separate. No assessment repeat, parallel replacement implementer, launch/resume, PM application-code edits, signing/upload or fleet changes. No operator sign-off gate.

Basis adds canonical Pillar **4 — Gang of Four by Default**, using **Adapter** for the one trusted finalized-fact → invocation boundary, alongside Pillars **2 — Dogfood the Platform** and **3 — Build LEGO, Not Statues**. Planning/handoff completion or command lifecycle success is not scope acceptance.
