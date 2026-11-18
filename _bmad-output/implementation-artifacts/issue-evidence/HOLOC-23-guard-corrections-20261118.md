# HOLOC-23 returned guard corrections — implementation receipt

## Scope

The returned AC3/AC5 defects are corrected by commits a420649, 0e0f38a, b87ff851 and 22a22fd on `fix/holoc-23-confirmation-guard`. No Kotlin, default route, token scope or default-on policy was changed. Existing explicit operator decisions remain intact.

- Incident descriptions do not authorize changes or deployment. Explicit instructions, revocations, quoted/reported/hypothetical text and cross-turn changes are handled conservatively; permission is tied to the current draft. A revoked permission does not return after an unrelated edit. Legacy pending drafts require a new read-back rather than retaining old-policy authority.
- Unavailable or unnamed retargets are spoken refusals and cannot silently send an old pending draft. Route disappearance and disabled handoff are rechecked before confirmation. Normal explicit named handoff is read back before dispatch.

## Checks and independent review

Independent SPEC/QUALITY review initially found defects despite a green suite. The implementation was corrected on the same branch. The final independent review of 22a22fdbd3a41c00d9c047eba65759cb92bd2e32 passed the bounded previously reported AC3/AC5 findings:

- Unchanged 36-case real watcher fixture probes: 36 passed. They include disk reload and captured dispatch assertions. Probe SHA-256 before and after: `03edd5a7195cc47be206bf17dab65c7d76cf40783ff5238f5c253c435021df23`.
- Unchanged six adjacent explicit-denial/retarget watcher probes: six passed. SHA-256 `f73c5e18c5f687418e4bc12ed513bcd460c3eedb43aa64891a5a506d01b95eb2`. Parent independently reran these six, exit 0.
- Eight final committed regression tests: eight passed independently. No existing assertions were weakened in the final commit.
- Worker full suite at b87ff851: 558 tests, one error and no assertion failures. Independent rerun confirmed an existing concurrent `State.save()` temporary-file rename race; the affected case passed alone. This is not reported as a fully green suite. The last narrow commit was checked with focused tests, not another full run.

Reports/probes/logs are in active profile scratch; final independent report is `holoc23-22a22-independent.md`. These are bounded technical findings, not merge approval, universal natural-language safety, current production behavior, acoustic proof or full-ticket acceptance.

## External acceptance blocker

The live watcher repeatedly reports its sole default fast route's token scope as `unsafe`. The read-only investigation observed a fresh heartbeat 2026-11-18T22:44:12Z with a scope check at 22:44:09Z; repeated warnings count four Anthropic-matching IDs in the gateway token's `/models` listing. The parent separately ran the real `memo_trace.py converse status` and confirmed `r1 automaticai/auto/fast key ok, scope unsafe` in a current heartbeat.

The scope guard skips the unsafe router. No Anthropic answer is asserted: this is a refusal, not evidence that a forbidden answer was used. The AutomaticAI gateway/token owner must restore an effective Claude-free scope (or provide a clean replacement scoped token), and the watcher must show a fresh `scope_proof=ok`. The existing gateway dependency is AAI-53; this pass does not change another board, gateway scope or credentials.

Only after that external dependency is resolved can current-release Honda acceptance be measured honestly. No emulator was attached during readiness inspection; the Honda AVD exists and can be provisioned with isolated audio. Absence of an emulator is not treated as an external blocker by itself. Host defaults point to physical microphone/speaker; tests must isolate only the emulator and never route synthetic speech through the physical speaker or touch the phone.

## Remaining acceptance matrix

1. Current >=10-turn Honda audible latency gate: not run, blocked on safe route; historic results are not reused as current proof.
2. Never-Anthropic protections preserved; live router currently refuses unsafe scope. Later explicit operator scoped auto/fast exception remains. No paid model request made.
3. Returned permission failures pass bounded guard/watcher tests with persisted confirmation.
4. Exactly-once confirmed dispatch regression controls pass isolated tests; historical live evidence exists, no new production delegation run here.
5. Returned refusal/retarget failures pass isolated persisted watcher probes.
6. Follow-up conversation storage/phone-grace acoustic path not newly proved.
7. Current all-check ZERO OVERLAPS including a mid-conversation result not run; no acoustic claim.
8. Interactive context path preserved; historical text-only transcript-ack decision remains, no new direct live turn.
9. Existing operator-chosen timeout/headroom remains 22/26 seconds; literal original eight-second wording is not claimed satisfied.
10. Runtime kill-switch behavior unchanged; later explicit default-on authorization preserved.
11. Existing trace/projection/schema/ntfy behavior unchanged; no fresh bus/schema/ntfy integration proof.
12. All changes are watcher Python/tests/docs. No credential contents written and no Kotlin change in this patch. No new pad bundle is required for these server-side guard changes.

## Landed and deployed receipt

- Integrated via `git pull --no-rebase origin main` and a merge of the independently reviewed branch; pushed main revision `0dc468186e7dc1fa28d238cd410d7ea09aa49c9c`. Origin main was independently read back with `git ls-remote`.
- Verified watcher idle (`active=[]`, zero open conversations), restarted the existing production `holocene-inbox-watcher.service`. It is active with PID **2134527**, start **2026-11-18 17:47:20 EST**. Current heartbeat **2026-11-18T22:47:35.759Z** belongs to that PID and reports `active=[]`, scope `unsafe`. This establishes activation/source selection, not a live interaction pass.
- Served watcher source matches committed main bytes: `converse.py` SHA-256 `409914da48cd257a4080620a01142b4fc50d492847345138394275c0633488b1`; `inbox_watcher.py` SHA-256 `41a06d2ecdbadae416764f764004775c7db996fe7d10f3c87d985c025a94be07`.
- Existing API `/health` returned `{"ok":true,"service":"holocene-api"}`. No frontend/API source changed, so their services and pad bundle were not rebuilt.
- Required API and web typechecks were attempted separately: **both exit 2**, reporting unavailable dependencies/type declarations (`fastify`, Node types, Next/React types). No TypeScript source/dependency changes are part of this patch; these checks are not green and dependency repair was not smuggled into this ticket.
- Attempt to resolve the existing cross-board dependency with `px link add AAI-53 HOLOC-23 --blocks --dry-run --json` was refused: AAI-53 is not in workspace 33god. No relation was written and no default-workspace retry was made. The dependency remains named in the hold comment until its provider-bound identity is available.

Full HOLOC-23 remains open with a dependency hold rather than closing on these bounded corrections. After the gateway owner restores safe scope, resume current-release simulator validation. No live synthetic memo, speech, physical phone operation or provider model request was made in this turn.
