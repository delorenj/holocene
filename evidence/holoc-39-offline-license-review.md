# HOLOC-39 — offline licensing review

The [Earshot design review](https://github.com/delorenj/earshot/blob/main/docs/launch/2026-11-17-offline-license-review.md)
answers the six acceptance criteria and preserves the original audit's relevant
Worker/plan-flag excerpts. The
[launch brief](https://github.com/delorenj/earshot/blob/main/docs/launch/2026-11-17-paid-launch-brief.md)
contains the revised licensing and step-1 estimates.

Verdict: **sound with changes**. Recommend manual fulfillment and offline
verification for the proposed low-volume self-host beta, accepting soft trials,
transferable licenses and no prompt offline refund revocation. Native Ed25519
starts at Android API 33, above Earshot's API-26 minimum; a compatible maintained
verifier and interoperability tests are required before any release.

This delivers a paper review, not licensing code or approval for beta, pricing,
Stripe setup, spending or publishing. No app, keys, phone settings or production
services changed. See the review's evidence/verification sections for source-backed
findings versus future implementation checks.
