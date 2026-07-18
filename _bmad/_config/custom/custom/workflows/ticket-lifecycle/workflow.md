# Ticket Lifecycle Client Workflow

## Status

This project-specific workflow is corrected but not executable. The standalone
Lifecycle component, its canonical Bloodbank command/event contracts, and the
Momo/Holocene clients are not implemented. The tested controller under
Bloodbank is the extraction embryo, not a deployed authority.

## Purpose

Momo uses this workflow to:

1. resolve PJangler project identity and the Lifecycle binding;
2. fetch an authoritative versioned snapshot;
3. apply business/process pillars to choose among legal frontier actions;
4. delegate work and independently review evidence;
5. submit observations, evidence, and idempotent intent;
6. refetch and render the authoritative result; and
7. record decision provenance that explains reasoning without changing state.

The copy stored in Holocene configures that repository's project-local
Momo/Hermes PM client. It does not grant the Holocene dashboard application
lifecycle execution or state authority.

## Non-negotiable boundary

Lifecycle alone owns versioned spec/state, deterministic reconciliation, legal
frontier, obligations, blockers, checkpoints, and capability validation.
Bloodbank owns transport and schemas. Candystore owns history/read models.
PJangler owns project/bootstrap identity. Momo never calculates or writes
lifecycle truth. Holocene never calculates it either.

Provider boards and direct tp/Trello transitions are legacy current paths. They
may be inspected as migration projections but cannot satisfy this workflow.

## Modes

- Create: run the client policy pass starting at steps-c/step-01-init.md.
- Edit: change only Momo client policy/display preferences; never edit a
  Lifecycle spec or state through this workflow.
- Validate: verify the authority boundary, contract fields, parity, and
  fail-closed behavior.

If Lifecycle or a required capability is unavailable, stop with a blocked
handoff. Do not fall back to a provider transition.
