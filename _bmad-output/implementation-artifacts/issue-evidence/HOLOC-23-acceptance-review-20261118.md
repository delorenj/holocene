# HOLOC-23 acceptance review

Reviewer: holocene-pm, with an independent read-only code reviewer.
Reviewed checkout: `c844730`; ticket: https://plane.delo.sh/33god/browse/HOLOC-23/

## Verified blocking findings

1. **AC3: investigation grants deploy permission.** Parent executed the current `converse.guard` directly without a watcher, network, audio or persistent state. Input: driver `Investigate the deploy failure.`, proposed permission `deploy_ok`. Actual output: `Draft for Holocene PM: Investigate incident. Changes and deploy OK. Say send it, or tell me what to change.` Stored permission was `deploy_ok`; send remained null. `services/inbox-watcher/converse.py:911-935` treats a deploy keyword as authorization unless the clause begins with a question or contains negation; `:1400-1416` stores and reads back that permission. An investigation of an incident must remain read-only unless the driver affirmatively requests deployment. Add a regression at the guard boundary, including the subsequent confirmation's stored permission.

2. **AC5: unavailable named target is not refused audibly.** Parent executed the current guard with driver `Send it to Ghost PM and check queue`, target `ghost-pm`, `names_fn` using the actual `name_tokens` helper, and `route_fn` reporting only the selected tile routable. Actual output: `Draft for Holocene PM: Check queue. Read-only. Say send it, or tell me what to change.`, target `holocene-pm`, reason `unroutable_target`. `converse.py:1375-1394` substitutes the tile without explaining the refusal. Speak the refusal; any tile-targeted alternative must be clear and separately confirmed.

3. **AC1/AC7: current end-to-end proof is missing.** Read the full `converse-e2e/evidence.md` and relevant `final-regression.md` evidence. Initial 12-turn audible run passed 7.80/10.39 seconds, but later reruns failed the gate (audible p50 8.34; later car start p50 10.03/p90 12.7). Final-regression sample has seven unqueued fast replies, below the required ten, and its overlap audit reports one flag at 60 ms. Do not reuse the earlier pass as proof for the later route/build. Re-run >=10 Honda-sim turns on the accepted release and all overlap checks including a result landing mid-conversation; retain raw timing/audio evidence.

## Criterion audit

| AC | Assessment |
| --- | --- |
| 1 | Not established on current release; historic latency pass was not reproduced on later builds. Non-Anthropic fallback is allowed by this criterion; absence of DeepSeek alone is not a rejection. |
| 2 | Original literal auto-route ban superseded by explicit operator decisions in October 22 comments allowing scoped auto/fast. Response/served-route/scope guards and tests exist. Latest voice-release report notes scope unproven; no current live proof obtained here. No claim that Anthropic answered. |
| 3 | Fails: parent-reproduced deploy-permission escalation above. Proposal itself does not dispatch. |
| 4 | Source/test and historical live evidence support uuid5, stored-brief batch delegation and duplicate suppression; no fresh production delegation was triggered in this review. |
| 5 | Fails: parent-reproduced silent substitution above. Routable named retarget has historical evidence. |
| 6 | Source and historical results support result prefix and conversation memory. Phone grace and post-release natural playback not fully proven. |
| 7 | Current all-checks ZERO OVERLAPS proof absent; historical coverage/tolerance caveats and a later flag. Barge-in regression tests pass per independent reviewer. |
| 8 | Interactive/context/force-direct path supported by landed source and isolated tests; release evidence explicitly describes transcript acknowledgement as text-only, unlike original heard-echo wording. |
| 9 | Shipped route has 22-second timeout and 26-second budget (`holocene-inbox-watcher.service:35-43,76`), not original 8-second bound. Commit 519ce7f and subsequent evidence document intentional headroom and remaining fall-through. Independent loopback probe took 9.008 seconds to fail. Scope/latency requirement drift must be reconciled; do not claim 8-second compliance. |
| 10 | Runtime kill switch has tests and historical live proof. Original default-off wording superseded by explicit October 22 operator enable decision and committed default-on. Do not revert enablement as a review fix. |
| 11 | Trace/conv/API routed projection exists; historical schema/ntfy proof only. Independent review identifies API projection budget fixed at 8 while unit budget is 26. |
| 12 | Reviewed route code uses runtime op references. Bounded voice-release commit changes no Kotlin and reports pad deployment. Absolute credential hygiene and current device bundle adoption not independently certified here. Later unrelated Kotlin changes are not attributed to this ticket. |

## Checks and preservation

Parent opened linked landed commits `d079790`, `abfa3ac6123c8457e87a3e5a84af942172fd7263`, and the actual headroom diff `519ce7f`. Read the November voice-release receipt, which explicitly does not establish full-ticket audible acceptance. Parent reproduced findings 1 and 2 against the current real guard using in-memory sessions; no reimplementation of its logic.

Independent reviewer reports 115 converse tests, 41 car-desk tests and 110 pad tests passing, after checking harness isolation. These are worker-run results, not parent-run suite results. They do not invalidate the adversarial guard reproductions.

No application code, service, configuration, deployment or audio was changed. No live memo or implementation worker was dispatched. Existing unrelated dirty artifacts were preserved. Later operator comments permitting auto/fast, default-on and coding-worker parity were read before judgment; do not roll them back based solely on stale ticket text.

Decision basis: `it-behaves-like-it-looks` — a read-only investigation must not appear to authorize deployment, and deployed selection diagnostics cannot substitute for audible acceptance. `reversible-beats-cautious` — return actionable defects for correction rather than park the ticket on an unnecessary owner decision.
