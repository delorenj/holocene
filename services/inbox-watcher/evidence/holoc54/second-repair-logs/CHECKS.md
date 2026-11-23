# HOLOC-54 second repair execution receipts

Parent: `3943b21064624575356e4cf435c346f114204bc2`; branch `holoc-54-agent-voice-local`. This is worker verification, **not independent acceptance**. Final commit is the commit containing these receipts; no live release.

## Reproduction environment

Workdir `/home/delorenj/code/33GOD/holocene/.worktrees/holoc-54-agent-voice-local`.

For each Python command, prefix:

```sh
env -u MEMO_PHRASEBANK_WARM \
  TMPDIR=/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc54-second-repair \
  HOLOC54_SCRATCH=/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc54-second-repair \
  PYTHONDONTWRITEBYTECODE=1 MEMO_S3_DIRECT=0 \
  PYTHONPATH=services/inbox-watcher/evidence/holoc54/harness \
  /usr/bin/python3 -B
```

The guard is `../harness/sitecustomize.py`; the suite loader is `../harness/run_safe_suites.py`. No service main/startup/`--once`, real Vox render, message/audio delivery, or external repository execution was authorized or performed. The fixture uses ephemeral loopback servers and scratch fake executable files. Guard receipts contain blocked `voxxy -q voice list --json` launches, loopback ports unknown in child processes, relative teardown writes, and an initial evidence archive write outside scratch; these are **refusals**, not successful external calls or synthesis. Packaging was instead written to scratch and copied into the evidence tree. No guard was weakened to pass a check. Audit files from all processes are retained in `guard-receipts.tar.gz`; intermediate runs are included.

## Final commands and outputs

Commands below use the prefix above, with full paths relative to the workdir.

* `services/inbox-watcher/evidence/holoc54/harness/run_safe_suites.py test_assigned_voices test_voice_publication test_car_desk test_voice_adapter_entrypoints` → exit 0; **134 tests, OK (skipped=1)**. `focused-checkpoint.log`. The single skip is the unrelated external Skillex scripts class; installed Hermes/Vox AST probes ran.
* `.../run_safe_suites.py test_inbox_watcher` → exit 0; **220 OK**. `watcher-checkpoint.log`.
* `.../run_safe_suites.py test_converse test_converse_pipeline` → exit 0; **127 OK**. `converse-checkpoint.log`. Broad watcher and converse/pipeline run in separate processes to avoid shared emit-log contamination.
* `.../run_safe_suites.py test_voice_publication` → **7 OK** in each of three fresh guarded repeat processes, exits 0. `barriers-repeat-{1,2,3}.log`.
* `pnpm --filter @holocene/api typecheck` and `pnpm --filter @holocene/web typecheck` → both exit 0. `{api,web}-typecheck-checkpoint.log`. Only the pre-existing local npm interpolation warning appears (no token value).
* With `:services/inbox-watcher` appended to guarded `PYTHONPATH`, unchanged `../review-3943b21/quality/partial_identity_probe.py` → exit 0, `second_error=voice_round_changed`, `second_voice=null`, original carlin identity and announced cursor retained. `partial-probe-final.log`.
* Same environment, unchanged `../review-3943b21/spec/post-render-race.py` → exit 1 from newly raised `StageError: reply round changed before publication`; the old reproducer does not catch the expected refusal. `post-render-probe-final.log`. Permanent barrier tests assert no upload or fact at this boundary.
* `git diff --check` → exit 0 before checkpoint.

## Tested source SHA-256

```text
89e1a6f4f415c4e7bb4cecda084825208232c09c3640316618e9fb61c9863db5  services/inbox-watcher/inbox_watcher.py
7685f516631e695dd35ca5060f3da76c259477b150a47f4c775c5617596066e6  services/inbox-watcher/test_voice_publication.py
2905482015373b4175e925a6d3843610f88bf80d8c20327040cb16f37460ec96  services/inbox-watcher/test_inbox_watcher.py
```

The seven new methods contain 78 adversarial parameter subcases and two success cases. They verify post-render/pre-upload, upload-in-flight and precommit/pre-fact barriers, exact-object cleanup, no mutation of newer cursors, fail-closed behavior when removal fails, real first-chunk announcement followed by responder conflict, fresh-round reselection, and concurrent second render during first upload. Progress/hold cover pending-to-final promotion too.

## Nonpassing intermediate runs retained

* `watcher.log`: 220 run, one failure because an existing on-call test mocked only `{voice: v}`. It now supplies the real cue ownership token; checkpoint all 220 pass without changing the call-drop assertion.
* `focused-final.log`: a new overlap test waited for a render while its steering thread held that render's mutex. Barrier ordering corrected, no production code change for that failure; three fresh repeat runs pass.
* `barriers.log` / `focused.log`: inflated counts because direct TestCase import was discovered a second time; module alias avoids duplicate discovery. Final count 134 includes exactly seven publication tests.

## Remaining hold

Independent specification and quality re-review must be performed by parent-authorized reviewers against the new commit, not inferred from these receipts. External Hermes Telegram auto-TTS passes only text/path, and Vox process `VOX_VOICE` wins over requested profile voice. AC1/AC4 remain held; no actual deployed pin, two-agent Telegram audio or next-round channel acceptance was established. No external edits, live config changes, board/schedule writes, push, merge, deploy or restart occurred.
