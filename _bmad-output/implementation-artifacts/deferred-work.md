
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-surface.md`
  summary: Build the rest of HOLOC-24 on the Candybar tab: the live Schedule view over SSE, skip one/skip rest of day, noise add/remove, and create from Definitions.
  evidence: The user asked only to show active and inactive candybars; the slice shipped is the read-only Definitions list.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-surface.md`
  summary: Flag a last run with `result: null` as stuck when it has been "running" far longer than its runner timeout.
  evidence: maybe-false, would be medium: a claim row whose executor died reads "running" forever and hides from the failing count; no stuck claim exists live on 2026-11-03, so it is unverified. A row older than its timeout_s in /candybars/{id}/invocations would prove it.
- source_spec: `_bmad-output/implementation-artifacts/spec-holoc-24-candybar-surface.md`
  summary: Show a date for weekly and monthly candybars' next fire instead of "after 24h".
  evidence: Six live candybars fire less than daily; the 25 h window cannot reach them, and a longer window would need many more /schedule slices.
