# HOLOC-9 recovery experiment

- Owner: Holocene; manual-Momo implementer `opencode-holoc-9-recovery-1`, AutomaticAI current carrier; no nested workers.
- Reserved branch/worktree: `holoc-9-aaos-feasibility`, baseline `1c0d76009ac757508584ba494112ecc1b3555a7f`.
- Contract: parent `_bmad-output/specs/spec-holocene-auto/{SPEC,car-modes,acceptance,brownfield}.md`, corrected spec `fbf6bb3`, SDK authorization `c6ed992`, backlink `33GOD:I-2.1`.
- Original dead worker `01a0face-1dcf-71d0-aeaf-c5a36e0243fa` and `workers/HOLOC-9` remain untouched. Recovery evidence: canonical child `agents/hermes/pm/runtime/workers/HOLOC-9-recovery-1` (ignored).

## Bounded implementation plan

1. Install one checksum-verified official Honda API 33 9-inch LHD image and missing API platform; create one scoped headless AVD, never the user's phone AVD.
2. Add an isolated native Kotlin/platform Android module under `apps/auto`; fixture roster/event normalization and command preview only, no network commands or real agent execution.
3. Build, unit-test, lint, install, launch, screenshot; query public microphone, recognizer, assistant role and host UX APIs without selecting a default assistant or setting distractionOptimized.
4. Reverify backend source read-only and record narrowly owned seam requests.
5. Return a reviewable feature commit and structured recovery handback; no main merge, board writes, live deploy, vehicle install or Play upload.

## Initial evidence and unknowns

- Clean reserved worktree confirmed at stated baseline; shared no-active-worker handoff received. Recheck process ownership before native edits.
- SDK present at `~/Android/Sdk`; API 33/Honda image absent; KVM readable/writable; 580 GiB free. Existing phone AVD left intact.
- Child BMAD invocation attempted exactly once: `uv run --no-cache <worktree>/_bmad/scripts/render_skill.py --project-root <worktree> --skill <root>/.opencode/skills/bmad-build`; fails `No such file or directory`. Installed child has `_bmad/_config`, not the renderer. No root bmad-loop or direct workflow fallback executed. This required skeleton preserves the ticket's five supplied ACs while the authorized reversible experiment continues; workflow rendering remains blocked.
- Emulator build/boot, microphone capture, endpointing, focus loss, host transitions and launch: NOT YET RUN.
- System assistant launch, non-screen capture/confirmation/cancel, category eligibility, Automotive device/test-track access and Civic installation: UNKNOWN, not inferred from APK launch.
- Backend identity/freshness, continuity, answer publication, authenticated ingress, canonical ASR and Vox adapters: source reverification PENDING.

All CAP-1 through CAP-8 remain parent requirements. Fixtures and parked diagnostic controls cannot satisfy integrated voice or zero-screen driving acceptance; CAP-8 remains open.
