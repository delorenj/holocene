---
title: 'HOLOC-22 disabled Telegram audio spool increment'
type: 'feature'
created: '2026-10-20'
status: 'in-review'
route: 'oneshot'
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

Build the first bounded increment of private Earshot fleet replies: a disabled-by-default shared Telegram successful-audio capture seam and durable local spool, with executable behavior tests. This increment deliberately performs no network uploads or device work. It prepares only actually sent operator-DM audio for the later authenticated uploader.

Always preserve Telegram send results, voice transcoding cleanup, existing public Earshot and Auto flows, and all live systems. Hook the real Telegram override's shared media-success seam once (including voice-to-document fallback), not the base adapter. Capture the exact delivered local bytes before cleanup. Gate on explicit opt-in, configurable operator DM allowlist (operator 7564050286), audio-only, valid bot/chat/message/attachment identity, and fail-closed non-Auto provenance until real reply correlation is available. Default-disabled means no spool I/O. Do not mirror text or inbound/unsent/non-audio/group/customer content.

The bounded restrictive-permission spool must survive restart; use stable bot/chat/message/attachment identity and never overwrite a retry. Persist original Telegram sent_at and an absolute expiry strictly under 30 minutes; reject stale captures and expose expiry filtering for the later uploader so LastModified cannot refresh an old reply. Bound entry count and bytes, clean expired entries, and isolate filesystem failures from Telegram. No permanent content-hash suppression.

Work only in isolated code worktrees. Do not deploy, restart, change storage ACLs or credentials, install on a device, commit, push, merge, change registry records, emit Bloodbank facts, or alter existing source drafts. Correct the copied Earshot ADR's unsupported public-consent assertion and stale-upload/LastModified claim. Independent review belongs to the parent after this handoff.

</frozen-after-approval>

## Implementation Notes

Planning: no unresolved user-visible choices for this intentionally disabled slice; no irreversible actions. Small footprint: Telegram adapter seam, adjacent generic spool module, focused tests, and copied ADR. Device SigV4/Keystore enrollment, private bucket policy fixtures and conditional uploader implementation remain a distinct subsequent increment and are not claimed here.

Code investigation: shared native Telegram `_send_media` in `plugins/platforms/telegram/adapter.py` returns the successful message while file objects remain open; `_send_local_file` also funnels through it. `send_voice` has native overrides plus document fallback and cleans a transcode in `finally`. A single capture call at `_send_media` avoids duplicate captures. `PlatformConfig.extra` carries nonsecret behavior settings; use explicit owning-scope paths, not ambient default profile state. Tests use `scripts/run_tests.sh` and real adapter imports with fake Telegram transport.

Worktrees: `/home/delorenj/.hermes/hermes-agent/.worktrees/holoc-22-private-audio` (base `080704695ad36b8ccc38c69839609e3f53212f35`); `/home/delorenj/code/earshot/.worktrees/holoc-22-private-audio` (base `7a96d13862bbe58be42631cff0f1f07bebb1974c`). Existing README and docs copied to the Earshot worktree for preservation; original draft hashes must remain unchanged. Holocene dirty files and docs symlink remain untouched.

Execution handoff: one Codex implementation session wrote the adapter seam, adjacent spool module and 23 focused tests, plus copied ADR corrections. The sole child (PID 111327) was stopped at the bounded handoff after sandbox-only asyncio/test-runner difficulties; no child remains. The carrier independently ran `scripts/run_tests.sh` on the finished worktree: 4 files, 53 tests passed, 0 failed, exit 0. A task-scratch interpreter shim preserved the credential-clean wrapper/per-file runner while overriding only its hard-coded `/var/tmp` scratch root to the authorized scratch directory. Interpreter reused read-only: `/tmp/hermes-unify-venv/bin/python`; no package installation. Exact shim, output and patches are under `/home/delorenj/.hermes/profiles/holocene-pm/cache/scratch/holoc-22/`.

Not approved: parent independent review remains required (prompt `holoc-22-blind-review-prompt.md`). Inspect synchronous full-file reads/fsync on the gateway loop, same-key publication/capacity races without locking, re-reading a mutable handle after Telegram consumes it, and metadata validation/recovery. Happy-path tests do not settle those boundaries. Provenance flag is not wired by production callers, so even opt-in remains inert for current traffic. No uploader, policy fixtures, SigV4/device enrollment, Android changes, or actual autoplay validation is claimed. The compact integration contract document was not finished. No commit/push/merge/deploy/restart or live config/storage changes. Original Earshot drafts hash-identical; gateway remains PID4082419 active/running since 2026-10-18 23:02:41 EDT. Ticket remains active.

