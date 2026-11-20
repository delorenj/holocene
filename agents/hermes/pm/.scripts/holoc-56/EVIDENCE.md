# HOLOC-56 evidence: PM launch pass synced to the launch | live | steady contract

Worker: delegated Codex implementation worker (parent PM `holocene-pm` cannot edit code).
Date: 2026-11-20 (America/New_York). Checkout: `/home/delorenj/code/33GOD/holocene`, branch `main`.
Scope: `agents/hermes/pm/.scripts/` only. No Plane writes, no Bloodbank events, no `.launch.yaml` edits,
no schedules created or changed.

Belsky level (pillar `belsky-doctrine`): the asker is holocene-pm, and the level is every PM role dir
that ships the generated launch pass. That level is served upstream already: hermes-agent-template
`770fe8e` plus `flume remediate hermes.pm-scaffold --scripts-only`. This ticket consumes the generator.
It adds no per-repo fork.

## Versions

| thing | value |
|---|---|
| holocene base HEAD | `9419a8a64e151d54621d7d2d033afdef3057c580` |
| hermes-agent-template (generator SSOT) | `770fe8e` feat(launch-pass): mode live is first-class (launch -> live) |
| flume | `c3a3ec7` feat(launch): .launch.yaml mode live (launch -> live) |
| `.project.json` | `agents.holocene-pm.role_dir = agents/hermes/pm` |
| `.launch.yaml` | absent (not committed), so the expected mode is `steady` |

## 1. Baseline (before any write)

```
$ git status --porcelain=v1
 M _bmad-output/implementation-artifacts/bloodbank-events.jsonl
?? _bmad-output/planning-artifacts/briefs/
?? runtime/
git status --porcelain=v1 --untracked-files=all | sha256sum
  98a7955a547de049a2d1d28941be57fe13ff3e89bee713cbcc39922047b0d2e0
sha256 _bmad-output/implementation-artifacts/bloodbank-events.jsonl
  07997e16007d7475bdb383a7f7d5f2943f3c30df4c59d2b12016c0247f7fc7ae
```

`flume audit . --rules hermes.launch-mode,hermes.pm-scaffold` before the change:
- `hermes.launch-mode` passed: launch mode consistent (mode absent, 1 desk(s)).
- `hermes.pm-scaffold` found 10 issues: stale `20-runtime-repo.sh`, `launch-pass.prompt.md`,
  `launch-pass.py`, `lib/voice-config.py`, `sentinel.prompt.md`; locally-modified `01-config.sh`,
  `_lib.sh`, `config.example.toml`; and soul-drift on tracked and runtime `SOUL.md`.

`python3 agents/hermes/pm/.scripts/launch-pass.py --monitor` before the change printed `launch-mode: steady`.
The old driver mapped any non-`launch` mode, `live` included, to the literal `steady`.

## 2. Generator run

The agent filter resolved directly, so no fallback filter was needed.

```
$ flume remediate hermes.pm-scaffold . --scripts-only --agent holocene-pm --dry-run    # exit 1 (partial)
  scripts-only: refreshing .scripts/ only; SOUL, wrapper, .gitignore, runtime, profile metadata and registry rows are left alone
  preserved locally-modified .scripts/01-config.sh, .scripts/_lib.sh, .scripts/config.example.toml
  Changed files (5): .scripts/20-runtime-repo.sh, launch-pass.prompt.md, launch-pass.py,
                     lib/voice-config.py, sentinel.prompt.md
$ flume remediate hermes.pm-scaffold . --scripts-only --agent holocene-pm             # exit 1 (partial), same 5 files
```

Exit 1 means "partial": the generator refuses to overwrite the three locally-modified scripts
(see "Not done" below). Every write landed in `.scripts/`.

### Reviewing the generated diff

- `launch-pass.py` and `launch-pass.prompt.md` are byte-identical to
  `hermes-agent-template/template/.scripts/*` at `770fe8e` (checked with `cmp`). `sentinel.prompt.md` is
  rendered from the template's `.jinja`. Modes are unchanged at 755/664.
- `launch-pass.py` (+56/-45): `MODES = (launch, live, steady)`, and only `launch` is active. A quiet
  snapshot prints `launch-mode: <mode>`. `--brief` on live says `quiet: live`, and `--apply` refuses with
  `launch-mode: <mode>: apply refused`. It also adds an indent-nested `.launch.yaml` parser for the
  three-deep `live:` block, plus `live_since`.
- `launch-pass.prompt.md` (+2/-1): the pass answers `quiet: live` with no tool calls.
- `sentinel.prompt.md` (+1/-1), rendered from `sentinel.prompt.md.jinja`: `mode: live` keeps
  steady-state grooming.
- `20-runtime-repo.sh` and `lib/voice-config.py` are NOT launch-mode changes. The scripts-only
  generator also carried them: they come from upstream template commits `f2dac92` and `29cbb5f`
  (voice provisioning: the fleet base as the default voice, plus `--clear`). The first commit,
  `88f75c6`, landed them. The parent scope review then rejected them as unrelated voice
  provisioning changes, outside the smallest launch-pass-only scope and the operator's
  no-unrelated-voice-changes rule. They were reverted before closure: a new corrective commit
  restored both files byte for byte from parent `9419a8a`, and the git blob and mode match that
  commit. There was no reset, rebase or amend. This ticket therefore does NOT sync the full
  scaffold.

## 3. Tests (isolated fixtures, real CLI)

File: `agents/hermes/pm/.scripts/holoc-56/test_launch_mode.py`. Each case copies this checkout's
generated `launch-pass.py`, `board-lease.py` and `launch-pass.prompt.md` into a pytest fixture repo with
its own `.project.json`. It runs the driver as a subprocess with a fake `px` on PATH, and the fake logs
every call. Board responses are fixture data, not live evidence. Neither the real `.launch.yaml`, the real
`runtime/` nor the real board is read or written, except in the last case, which reads the real checkout
through `--monitor` only.

```
$ PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -p no:cacheprovider -rA \
    --basetemp=$HOME/.hermes/profiles/holocene-pm/cache/scratch/holoc56-impl/pytest \
    agents/hermes/pm/.scripts/holoc-56/test_launch_mode.py
13 passed in 0.86s
```

| case | result |
|---|---|
| `--monitor` live / steady / absent | exactly `launch-mode: live\n`, `launch-mode: steady\n`, `launch-mode: steady\n`; empty stderr; zero px calls |
| `--brief` live / steady / absent | `quiet: live` / `quiet: steady`; no snapshot, no plan schema; zero px calls |
| `--apply` live / steady / absent (plan present) | `launch-mode: <mode>: apply refused, nothing written.`; zero px calls; plan not consumed; runtime holds only the plan (no lease, receipt or roadmap) |
| launch `--monitor` | fixture snapshot shown below; deterministic on rerun; only `task list`/`task get` reads; no writes |
| launch `--brief` | pass contract, declaration, snapshot, plan schema, `--apply` |
| launch `--apply` | exactly one fake-px write `["comment","FIX-2","-m","[pm] fixture comment"]`; plan archived to `.applied.json`; one receipt with status ok; roadmap written in the fixture runtime |
| real checkout `--monitor` | `.launch.yaml present=False`, stdout `launch-mode: steady\n` |

Fixture launch snapshot (fake px, not live):

```
launch-mode: launch
date 2026-11-20
declaration 118f6c71fb44
epic FIX-1
target 2026-12-01 (11d)
FIX-2|Todo|high|-|-|owner|cut:lc|-|owner-waiting:0|-
FIX-3|Backlog|medium|-|-|owner|cut:al|-|owner-waiting:0|-
FIX-4|In Progress|none|-|working|owner|cut:-|-|owner-waiting:0|stale-claim
off-cut-todo|-
cut-in-backlog|-
```

As a cross-check of the generator SSOT, I also ran the upstream template suite read-only.
`hermes-agent-template` stayed clean:
`python3 -m pytest tests/test_launch_pass.py` gave 47 passed.

## 4. Real checkout monitor

```
$ python3 agents/hermes/pm/.scripts/launch-pass.py --monitor     # exit 0
launch-mode: steady
$ python3 agents/hermes/pm/.scripts/launch-pass.py --check       # exit 0 (no .launch.yaml: mode steady, active false)
```

## 5. Audit

```
$ flume audit . --rules hermes.launch-mode          # exit 0
  ✔ Parity audit passed · 1 passed
  ✔ hermes.launch-mode  launch mode consistent (mode absent, 1 desk(s))
```

The JSON envelope shows `"ok": true` and rule status `pass`. Its `hostOk` is false only because no host
rule was selected in a project-scoped run.

After the first commit, `flume audit . --rules hermes.pm-scaffold` dropped from 10 findings to 5.
Once the voice files were reverted, the rule reports them as stale again, which is expected and out of
scope. It does not pass, and this evidence does not claim the scaffold is fully synced. See section 8
for the post-correction run.

## 6. Not done (out of scope, left for the parent)

- `01-config.sh`, `_lib.sh` and `config.example.toml` are locally-modified, meaning bytes the template
  never shipped. The generator preserves them on purpose. Reconciling them is a separate decision, and it
  must not be a hand overwrite.
- `SOUL.md` soul-drift, tracked and runtime: SOUL composition is explicitly out of scope.
- Stale `20-runtime-repo.sh` and `lib/voice-config.py`, the voice-provisioning template changes,
  were reverted under parent scope review. Taking them is a separate, voice-scoped decision.

## 7. Unrelated work preserved

- After the change, `git status --porcelain=v1 --untracked-files=all` filtered to exclude
  `agents/hermes/pm/.scripts/` hashed to `98a7955a…0b2e0`, identical to the baseline.
- `bloodbank-events.jsonl` sha256 is unchanged at `07997e16…c7ae`.
- Every file in `agents/hermes/pm` outside `.scripts/` and `runtime/` has the same sha256.
- Inside `.scripts/`, the 5 generated files changed in `88f75c6`; the corrective commit then reverted 2
  of them (the voice files). Net change against `9419a8a`: `launch-pass.py`, `launch-pass.prompt.md`,
  `sentinel.prompt.md`, plus `holoc-56/` (this file and the test).
- Commits use explicit paths only (`git add -- <paths>`, `git commit --only -- <paths>`).

Tool-induced outside writes:
- Pytest fixtures and the upstream suite's basetemp went to
  `~/.hermes/profiles/holocene-pm/cache/scratch/holoc56-impl/`.
- A `py_compile` check created gitignored `__pycache__/*.pyc` files under `.scripts/`. They were moved
  to `scratch/holoc56-impl/pycache-moved/`, and the directories were removed.
- flume wrote only the 5 listed files. The 2 voice files were later restored from `9419a8a`.

## 8. Scope correction (parent review) and re-verification

The parent review narrowed scope after `88f75c6`. Before restoring the two voice files, I checked
`git log 9419a8a..origin/main` for both paths. Only `88f75c6` (this worker) touched them, they had no
working-tree or staged changes, and `HEAD == origin/main == 88f75c6`. I restored both with
`git show 9419a8a:<path> > <path>`, and `git diff 9419a8a -- <both>` is now empty. Unrelated
`_bmad-output/` and `runtime/` changes were left alone.

Re-verification after the correction (2026-11-20):

```
$ PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -p no:cacheprovider -q --basetemp=<scratch> \
    agents/hermes/pm/.scripts/holoc-56/test_launch_mode.py
13 passed in 0.69s
$ python3 agents/hermes/pm/.scripts/launch-pass.py --monitor          # exit 0
launch-mode: steady
$ flume audit . --rules hermes.launch-mode                            # exit 0
  ✔ hermes.launch-mode  launch mode consistent (mode absent, 1 desk(s))
$ flume audit . --rules hermes.pm-scaffold                            # fails, 7 findings, all out of scope
  locally-modified 01-config.sh, _lib.sh, config.example.toml
  stale 20-runtime-repo.sh, lib/voice-config.py   (reverted voice files, expected)
  soul-drift SOUL.md (tracked + runtime)
```

## 9. Independent review summary

- **Spec/quality reviewer (separate from this worker):**
  - Reran the 13 scoped tests: 13 passed.
  - Reran the 47 upstream `hermes-agent-template` `tests/test_launch_pass.py` tests: 47 passed.
  - Reran `flume audit --rules hermes.launch-mode`: pass.
  - Found no launch/live/steady mode defects and no live board writes.
- **Parent review:** after that, it narrowed scope by rejecting the two unrelated voice-provisioning
  files carried by the generator. They are reverted as described in section 8.
