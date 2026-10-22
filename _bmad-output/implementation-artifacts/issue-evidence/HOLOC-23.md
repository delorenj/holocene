# HOLOC-23 evidence: fast in-car conversation desk

The full live proof (scenarios S1-S13 on the Honda sim, the per-turn latency table, the overlap audit, gateway journal counts per
delegation, models that answered, findings) is in
[`../agent-pad-auto/converse-e2e/evidence.md`](../agent-pad-auto/converse-e2e/evidence.md). Raw runs, traces and the overlap
files are next to it. The README section is `services/inbox-watcher/README.md`, "Verified live: the fast in-car desk".

Result in one line: S1 p50 7.80 s / p90 10.39 s over 12 turns, exactly-once delegation, zero overlaps where the tap ran; the
answering model was NOT deepseek-v4.1-flash-1017 because the shared Hyper key was out of credit (402), so ministral-14b and
gemini-3.5-flash-lite on the gateway answered (never Anthropic).
