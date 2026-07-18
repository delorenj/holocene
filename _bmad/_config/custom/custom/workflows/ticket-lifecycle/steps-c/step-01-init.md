# Step 1: Resolve Authority and Snapshot

## Goal

Resolve PJangler project identity, the Lifecycle binding, caller capability, and
the authoritative snapshot before selecting work.

## Actions

1. Read project/bootstrap identity; do not treat registry status as lifecycle.
2. Verify Bloodbank contract compatibility and Lifecycle availability.
3. Fetch lifecycle ID, spec/state versions, provenance/time, legal frontier,
   obligations, blockers, and capability grants.
4. Compare provider/Candystore views only as projections or history.
5. If authority, version, or capability is unavailable, produce a blocked
   handoff and stop. Never fall back to a direct provider transition.

## Next

Continue to step-02-triage.md with the immutable snapshot reference.
