# Validate Lifecycle Client Workflow

## Boundary checks

- Lifecycle is the only state writer and calculator of frontier/obligations.
- Momo only selects legal work, delegates, reviews, and submits intent/evidence.
- Holocene only renders and submits high-level commands.
- Bloodbank owns all executable contracts; Candystore owns history/read models;
  PJangler owns project/bootstrap identity.
- No target step invokes a direct provider transition.
- Decision events are explicitly audit-only.

## Contract checks

- Snapshot and command fields match workflow.yaml.
- Commands are idempotent, version-checked, capability-checked, and
  single-consumer.
- Stale, denied, duplicate, rejected, and unavailable outcomes are visible.
- No unregistered schema/type/subject is represented as executable.

## State checks

- Provider lanes and Candystore history are projections, never fallback truth.
- Refetch follows every command or evidence submission.
- Lifecycle absence stops execution; it never produces an empty healthy view.

## Parity and implementation checks

- Source/generated custom workflow copies are byte-identical in Momo/Holocene.
- Historical backup files are excluded from authoritative execution and scans.
- execution_enabled is true only for this bounded client protocol; it never
  enables local lifecycle authority.
- Current implementation and deployment evidence is attached to the owning
  component/root validation record.

Validation passes only when all checks above pass with evidence.
