# Initial review-harness browser launch failure

This is a summary of the failed initial attempt, not a page-level test failure. Original terminal output is retained in `check-results.json` last_lines for `reproduced-browser-suite`.

Command: `pnpm --filter @holocene/web test:products-browser` with `TMPDIR` set to this long review directory's `scratch/reproduced-browser-suite/` path.

Observed Chrome stderr:

```text
FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long:
/home/delorenj/code/33GOD/holocene/.worktrees/holoc-57-products-sidebar/_bmad-output/implementation-artifacts/holoc-57/reviews/spec/scratch/reproduced-browser-suite/com.google.Chrome.M6TG9B/SingletonSocket.
```

Process terminated with SIGABRT before navigation. Suite exit 1. Browser retry used the supplied active-profile scratch TMPDIR and passed all 3 tests; final output is in `reproduced-browser-suite.log` and `browser-rerun-result.json`. No application code was changed to remedy this harness configuration.
