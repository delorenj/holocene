# Reply Player

Deterministic voice-out for Hermes agent replies. Operator rule (2026-10-12,
Jarad): **every turn's final reply is spoken** — no per-message opt-in, no
agent deciding what deserves voice. Long replies → vox reads a summary;
structured replies (steps, code, lists) → read whole. Summary threshold and
structure detection are deterministic functions of the reply text, decided by
the server side; this app only watches the box and plays.

Runtime contract:

- Audio files land in `s3://holocene-auto/replies/YYYY/MM/DD/<timestamp>.ogg`,
  anonymously streamable at
  `https://s3.delo.sh/holocene-auto/replies/YYYY/MM/DD/<timestamp>.ogg`.
- Bucket `holocene-auto` is anonymous-download; the app polls the S3 prefix
  listing (no credentials) for objects newer than the last played key.
- Playback uses `MediaPlayer` streaming with range requests (server supports
  `Accept-Ranges: bytes`, verified 206).
- One file at a time, newest first; missed files while paused are skipped
  (only the newest unplayed file plays — no queue backlog).
- Foreground service + media session so audio routes through the same
  Bluetooth/car path as Telegram voice notes.
- The app is deliberately independent of Holocene Auto; it can run on the
  phone anywhere. Car-mode toggle is future work.

Layout mirrors `apps/auto` (Gradle KMP-lite, single module).
