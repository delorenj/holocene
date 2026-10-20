import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDirectorSnapshot, fetchSource, type RawDirector, type RawSource } from "./director.js";

// Trimmed from the sample responses in delonet-company/docs/contracts/director-read-api-v1.md (2026-10-20).
const LEASE_EXPIRES = 1786816719.9947104; // 2026-08-15, long expired
const LIVE_NOW = (LEASE_EXPIRES - 3600) * 1000; // an hour before expiry
const LATE_NOW = Date.parse("2026-10-20T12:00:00Z");

const HEALTHZ = {
  status: "ok",
  mode: "read-only",
  capacity_database_present: true,
  contract_database_present: false,
  hindsight_is_live_truth: false
};

const CAPACITY = {
  schema_version: 1,
  capacity_total: 3,
  slots: [
    {
      id: "pipeline-1",
      preferred_kind: "pipeline",
      allocation: {
        correlation_id: "DNET-4:director-runtime-activation",
        kind: "pipeline",
        borrowed: false,
        allocated_at: 1786795119.9947104,
        expires_at: LEASE_EXPIRES,
        metadata: {
          outcome: "repair and activate Director runtime",
          owner: "delonet-director",
          target_agent_id: "delonet-director",
          ticket: "DNET-4"
        }
      }
    },
    { id: "derivative-1", preferred_kind: "derivative", allocation: null },
    { id: "derivative-2", preferred_kind: "derivative", allocation: null }
  ],
  queue: [],
  counts: { active: 1, queued: 0, released: 1, expired: 0 },
  needs_reconciliation: true
};

const READINESS_CONFLICT = {
  schema_version: 1,
  readiness: "conflict",
  counts: { ready: 0, degraded: 0, conflict: 0, projects_total: 0, global_info: 1, global_warning: 10, global_error: 1 },
  reason_codes: ["source.missing", "fleet.project_path_missing", "fleet.project_missing"],
  findings: [
    { code: "policy.hindsight_non_authoritative", severity: "info", message: "Hindsight is excluded from live portfolio resolution", sources: ["policy"] },
    { code: "source.missing", severity: "error", message: "pjangler_registry not found: /home/delorenj/.config/pjangler/projects.yaml", sources: ["x"] },
    { code: "fleet.project_path_missing", severity: "warning", message: "fleet record for agent 'infra-specialist' has no project_path", sources: ["y"] }
  ],
  projects: []
};

const READINESS_READY = {
  schema_version: 1,
  readiness: "ready",
  counts: { ready: 1, degraded: 0, conflict: 0, projects_total: 1, global_info: 1, global_warning: 0, global_error: 0 },
  reason_codes: [],
  findings: [{ code: "policy.hindsight_non_authoritative", severity: "info", message: "Hindsight is excluded", sources: ["policy"] }],
  projects: [{ slug: "demo", readiness: "ready", reason_codes: ["policy.hindsight_non_authoritative"] }]
};

const CONTRACTS_STATUS = {
  mode: "read-only",
  canonical: { ready: true, head_commit: "09996b15a8b8a2bf48fc99c9031e76310f7b7a49" },
  evidence: { schema_version: 1, database_present: false, evidence_total: 0, counts: {}, last_seen_at: null }
};

const RECEIPTS = [
  { id: 5, correlation_id: "DNET-4:director-runtime-activation", action: "lease.allocated", outcome: "active", occurred_at: 1786795119.99, details: { borrowed: false, expires_at: LEASE_EXPIRES, slot_id: "pipeline-1" } },
  { id: 4, correlation_id: "DNET-4:director-runtime-activation", action: "request.accepted", outcome: "queued", occurred_at: 1786795119.99, details: { kind: "pipeline", ttl_seconds: 21600 } },
  { id: 3, correlation_id: "DNET-3:director-bloodbank-adapter", action: "lease.released", outcome: "released", occurred_at: 1786795070.58, details: { previous_slot: "pipeline-1" } }
];

const ok = (body: unknown): RawSource => ({ ok: true, status: 200, ms: 7, body });
const fail = (error: string, status: number | null = null): RawSource => ({ ok: false, status, ms: 4, error });

function raw(overrides: Partial<RawDirector> = {}): RawDirector {
  return {
    healthz: ok(HEALTHZ),
    capacity: ok(CAPACITY),
    receipts: ok(RECEIPTS),
    readiness: ok(READINESS_CONFLICT),
    contractsStatus: ok(CONTRACTS_STATUS),
    contractsReceipts: ok([]),
    ...overrides
  };
}

const HEALTHY: RawDirector = raw({
  healthz: ok({ ...HEALTHZ, contract_database_present: true }),
  capacity: ok({
    ...CAPACITY,
    slots: [
      { id: "pipeline-1", preferred_kind: "pipeline", allocation: { ...CAPACITY.slots[0].allocation, expires_at: LEASE_EXPIRES } },
      CAPACITY.slots[1],
      CAPACITY.slots[2]
    ],
    needs_reconciliation: false
  }),
  readiness: ok(READINESS_READY),
  contractsStatus: ok({ ...CONTRACTS_STATUS, evidence: { ...CONTRACTS_STATUS.evidence, database_present: true } })
});

const FLEET = [{ agent_id: "bloodbank-pm", display_name: "Bloodbank PM", repo: "bloodbank", role: "pm" }];

test("healthy: live lease, ready portfolio, present stores => ok with no reasons or exceptions", () => {
  const snap = buildDirectorSnapshot(HEALTHY, FLEET, LIVE_NOW);
  assert.equal(snap.health.level, "ok");
  assert.deepEqual(snap.health.reasons, []);
  assert.deepEqual(snap.exceptions, []);
  assert.equal(snap.lanes.items.length, 3);
  assert.deepEqual(snap.lanes.items.map((l) => l.state), ["live", "free", "free"]);
  assert.equal(snap.delegations.active.length, 1);
  assert.equal(snap.delegations.active[0].ticket, "DNET-4");
  assert.equal(snap.readiness.label, "ready");
  // the always-present info code never counts as a problem, even raw in a project
  assert.deepEqual(snap.readiness.projects[0].reason_codes, []);
  assert.deepEqual(snap.readiness.reason_codes, []);
  assert.ok(snap.sources.every((s) => s.ok));
});

test("conflict readiness is degraded with the findings as exceptions; info findings are not", () => {
  const snap = buildDirectorSnapshot(raw({ healthz: ok({ ...HEALTHZ, contract_database_present: true }), capacity: ok({ ...CAPACITY, slots: [CAPACITY.slots[1], CAPACITY.slots[2]], needs_reconciliation: false }) }), FLEET, LATE_NOW);
  assert.equal(snap.health.level, "degraded");
  assert.equal(snap.readiness.label, "conflict");
  assert.ok(snap.health.reasons.some((r) => r.includes("conflict")));
  const codes = snap.exceptions.map((e) => e.code);
  assert.ok(codes.includes("source.missing"));
  assert.ok(codes.includes("fleet.project_path_missing"));
  assert.ok(!codes.includes("policy.hindsight_non_authoritative"));
  assert.equal(snap.exceptions[0].severity, "error", "errors sort first");
  assert.equal(snap.exceptions.find((e) => e.code === "source.missing")?.source, "readiness");
  assert.deepEqual(snap.readiness.reason_codes.sort(), ["fleet.project_missing", "fleet.project_path_missing", "source.missing"]);
});

test("per-project reason codes are deduped and filtered; a degraded project is itself an exception", () => {
  const readiness = {
    ...READINESS_READY,
    readiness: "degraded",
    reason_codes: [],
    projects: [
      { slug: "demo", readiness: "degraded", reason_codes: ["source.stale", "source.stale", "policy.hindsight_non_authoritative"] }
    ]
  };
  const snap = buildDirectorSnapshot(raw({ readiness: ok(readiness) }), FLEET, LIVE_NOW);
  assert.deepEqual(snap.readiness.projects[0].reason_codes, ["source.stale"]);
  assert.deepEqual(snap.readiness.reason_codes, ["source.stale"], "top-level reason_codes was empty (F3); project codes fill it");
  const ex = snap.exceptions.find((e) => e.code === "project.degraded");
  assert.equal(ex?.severity, "warning");
  assert.match(ex?.message ?? "", /demo/);
});

test("degraded readiness with no itemised finding still surfaces an exception (F3)", () => {
  const readiness = { ...READINESS_READY, readiness: "degraded", projects: [] };
  const snap = buildDirectorSnapshot(raw({ readiness: ok(readiness) }), FLEET, LIVE_NOW);
  assert.ok(snap.exceptions.some((e) => e.code === "readiness.not_ready"));
});

test("expired-but-active lease is not live, is not an active delegation, and is an exception", () => {
  const snap = buildDirectorSnapshot(raw(), FLEET, LATE_NOW);
  const lane = snap.lanes.items[0];
  assert.equal(lane.state, "expired");
  assert.equal(lane.allocation?.live, false);
  assert.ok((lane.allocation?.expires_in_s ?? 0) < 0);
  assert.equal(snap.delegations.active.length, 0);
  const ex = snap.exceptions.find((e) => e.code === "capacity.lease_expired");
  assert.equal(ex?.severity, "warning");
  assert.equal(ex?.source, "capacity");
  assert.ok(snap.health.reasons.some((r) => r.includes("expired but still marked active")));
  // the same lease must not be reported twice
  assert.ok(!snap.exceptions.some((e) => e.code === "capacity.needs_reconciliation"));
});

test("needs_reconciliation alone (clock skew) is still surfaced", () => {
  const snap = buildDirectorSnapshot(raw({ capacity: ok({ ...CAPACITY, needs_reconciliation: true }) }), FLEET, LIVE_NOW);
  assert.equal(snap.lanes.items[0].state, "live");
  assert.ok(snap.exceptions.some((e) => e.code === "capacity.needs_reconciliation"));
});

test("director down: every source unavailable => down, one unreachable exception, empty sections", () => {
  const down = raw({
    healthz: fail("fetch failed (ECONNREFUSED)"),
    capacity: fail("fetch failed (ECONNREFUSED)"),
    receipts: fail("fetch failed (ECONNREFUSED)"),
    readiness: fail("fetch failed (ECONNREFUSED)"),
    contractsStatus: fail("fetch failed (ECONNREFUSED)"),
    contractsReceipts: fail("fetch failed (ECONNREFUSED)")
  });
  const snap = buildDirectorSnapshot(down, FLEET, LATE_NOW);
  assert.equal(snap.health.level, "down");
  assert.equal(snap.health.process, "unavailable");
  assert.deepEqual(snap.exceptions.map((e) => e.code), ["director.unreachable"]);
  assert.equal(snap.lanes.available, false);
  assert.deepEqual(snap.lanes.items, []);
  assert.equal(snap.readiness.available, false);
  assert.equal(snap.receipts.work.available, false);
  assert.equal(snap.receipts.work.note, null, "an unavailable source is not 'empty by design'");
  assert.equal(snap.sources.length, 6);
  assert.ok(snap.sources.every((s) => !s.ok));
});

test("a source answering a bare-text 500 is unavailable, never treated as empty", async () => {
  const fetchImpl = (async () => new Response("Internal Server Error", { status: 500 })) as typeof fetch;
  const failed = await fetchSource("http://x", "/v1/capacity", 1000, fetchImpl);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 500);
  assert.match(failed.error ?? "", /HTTP 500: Internal Server Error/);

  const snap = buildDirectorSnapshot(raw({ capacity: failed }), FLEET, LATE_NOW);
  assert.equal(snap.health.level, "degraded");
  assert.equal(snap.lanes.available, false);
  assert.deepEqual(snap.lanes.items, []);
  const ex = snap.exceptions.find((e) => e.code === "director.source_unavailable");
  assert.equal(ex?.severity, "error");
  assert.equal(ex?.source, "capacity");
  assert.equal(snap.sources.find((s) => s.name === "capacity")?.status, 500);
});

test("a 200 with an unusable body is unavailable, as is non-JSON", async () => {
  const snap = buildDirectorSnapshot(raw({ capacity: ok({ slots: "nope" }) }), FLEET, LATE_NOW);
  assert.equal(snap.sources.find((s) => s.name === "capacity")?.ok, false);
  assert.equal(snap.lanes.available, false);

  const html = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
  const res = await fetchSource("http://x", "/healthz", 1000, html);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not JSON/);
});

test("missing contract DB: warning exception, and work receipts are empty by design (F7), not an error", () => {
  const snap = buildDirectorSnapshot(raw(), FLEET, LIVE_NOW);
  const ex = snap.exceptions.find((e) => e.code === "contracts.database_missing");
  assert.equal(ex?.severity, "warning");
  assert.equal(snap.health.contract_database_present, false);
  assert.equal(snap.receipts.work.available, true);
  assert.deepEqual(snap.receipts.work.items, []);
  assert.match(snap.receipts.work.note ?? "", /F7/);
  // lease-end rows still come from the capacity ledger
  assert.deepEqual(snap.receipts.leases.items.map((r) => [r.id, r.action, r.slot_id]), [[3, "lease.released", "pipeline-1"]]);
});

test("missing capacity DB: 200 all-free body is not rendered as idle lanes", () => {
  const empty = { ...CAPACITY, slots: CAPACITY.slots.map((s) => ({ ...s, allocation: null })), counts: { active: 0, queued: 0, released: 0, expired: 0 }, needs_reconciliation: false };
  const snap = buildDirectorSnapshot(raw({ healthz: ok({ ...HEALTHZ, capacity_database_present: false }), capacity: ok(empty) }), FLEET, LIVE_NOW);
  assert.equal(snap.lanes.available, false);
  assert.deepEqual(snap.lanes.items, []);
  assert.equal(snap.exceptions.find((e) => e.code === "capacity.database_missing")?.severity, "error");
});

test("canonical.ready=false is an error exception", () => {
  const status = { ...CONTRACTS_STATUS, canonical: { ready: false, error: "bloodbank home missing" } };
  const snap = buildDirectorSnapshot(raw({ contractsStatus: ok(status) }), FLEET, LIVE_NOW);
  const ex = snap.exceptions.find((e) => e.code === "contracts.canonical_not_ready");
  assert.equal(ex?.severity, "error");
  assert.match(ex?.message ?? "", /bloodbank home missing/);
});

test("read-write mode is refused: down, nothing rendered", () => {
  const snap = buildDirectorSnapshot(raw({ healthz: ok({ ...HEALTHZ, mode: "read-write" }) }), FLEET, LIVE_NOW);
  assert.equal(snap.health.level, "down");
  assert.equal(snap.health.refused, true);
  assert.equal(snap.lanes.available, false);
  assert.equal(snap.readiness.available, false);
  assert.ok(snap.exceptions.some((e) => e.code === "director.mode_not_read_only"));
});

test("target PM: resolved against the fleet registry, otherwise flagged unresolved", () => {
  const resolved = capacityWith({ target_agent_id: "bloodbank-pm", ticket: "BB-1" });
  const snap = buildDirectorSnapshot(raw({ capacity: ok(resolved) }), FLEET, LIVE_NOW);
  const pm = snap.delegations.active[0].targetPm;
  assert.deepEqual(pm, { agent_id: "bloodbank-pm", resolved: true, display_name: "Bloodbank PM", repo: "bloodbank", role: "pm" });

  const unresolved = buildDirectorSnapshot(raw(), FLEET, LIVE_NOW).delegations.active[0].targetPm;
  assert.deepEqual(unresolved, { agent_id: "delonet-director", resolved: false, display_name: "delonet-director", repo: null, role: null });

  const none = buildDirectorSnapshot(raw({ capacity: ok(capacityWith({ ticket: "X-1" })) }), FLEET, LIVE_NOW);
  assert.equal(none.delegations.active[0].targetPm, null);

  const noRegistry = buildDirectorSnapshot(raw({ capacity: ok(resolved) }), null, LIVE_NOW);
  assert.equal(noRegistry.delegations.fleetRegistryAvailable, false);
  assert.equal(noRegistry.delegations.active[0].targetPm?.resolved, false);
});

test("queued entries become delegations with their target PM", () => {
  const body = {
    ...CAPACITY,
    queue: [{ correlation_id: "BB-2:next", kind: "derivative", ttl_seconds: 600, requested_at: 1786795200, metadata: { target_agent_id: "bloodbank-pm" } }]
  };
  const snap = buildDirectorSnapshot(raw({ capacity: ok(body) }), FLEET, LIVE_NOW);
  assert.equal(snap.delegations.queued.length, 1);
  assert.equal(snap.delegations.queued[0].state, "queued");
  assert.equal(snap.delegations.queued[0].ttl_seconds, 600);
  assert.equal(snap.delegations.queued[0].targetPm?.display_name, "Bloodbank PM");
});

test("terminal work receipts come from envelope.data.terminal_status; non-terminal rows are dropped", () => {
  const rows = [
    { direction: "inbound", event_id: "e1", correlation_id: "c1", last_seen_at: 1786795200, envelope: { data: { terminal_status: "completed", work_id: "w1", delegation_id: "d1", project: "demo", result: { summary: "done" } } } },
    { direction: "inbound", event_id: "e2", correlation_id: "c2", last_seen_at: 1786795100, envelope: { data: { terminal_status: "running" } } }
  ];
  const snap = buildDirectorSnapshot(raw({ contractsReceipts: ok(rows) }), FLEET, LIVE_NOW);
  assert.equal(snap.receipts.work.items.length, 1);
  assert.equal(snap.receipts.work.items[0].terminal_status, "completed");
  assert.equal(snap.receipts.work.items[0].summary, "done");
  assert.equal(snap.receipts.work.note, null);
});

test("healthz alone failing: down, and capacity is unknown rather than rendered as idle or live", () => {
  const snap = buildDirectorSnapshot(
    raw({ healthz: fail("fetch failed (ECONNREFUSED)"), contractsStatus: ok({ mode: "read-only", canonical: { ready: true } }) }),
    FLEET,
    LIVE_NOW
  );
  assert.equal(snap.health.level, "down");
  assert.equal(snap.health.process, "unavailable");
  assert.equal(snap.lanes.available, false);
  assert.deepEqual(snap.lanes.items, []);
  assert.equal(snap.delegations.available, false);
  assert.equal(snap.receipts.leases.available, false);
  assert.match(snap.receipts.leases.note ?? "", /unknown/);
  // sources that did answer stay available
  assert.equal(snap.readiness.available, true);
  assert.equal(snap.receipts.work.available, true);
  assert.match(snap.receipts.work.note ?? "", /unknown/);
});

test("a hanging source times out and is reported as timed out", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const res = await fetchSource("http://x", "/healthz", 20, hang);
  assert.equal(res.ok, false);
  assert.equal(res.status, null);
  assert.match(res.error ?? "", /timed out after/);
});

test("404 and 422 are unavailable with the status kept", async () => {
  for (const status of [404, 422]) {
    const impl = (async () => new Response('{"detail":"nope"}', { status })) as typeof fetch;
    const res = await fetchSource("http://x", "/v1/readiness", 1000, impl);
    assert.equal(res.ok, false);
    assert.equal(res.status, status);
  }
});

test("healthz without a mode is refused, not trusted", () => {
  const snap = buildDirectorSnapshot(raw({ healthz: ok({ status: "ok", capacity_database_present: true, contract_database_present: true }) }), FLEET, LIVE_NOW);
  assert.equal(snap.health.refused, true);
  assert.equal(snap.health.level, "down");
  assert.equal(snap.lanes.available, false);
});

test("missing capacity DB: the empty lease ledger is not 'no lease ended'", () => {
  const missing = buildDirectorSnapshot(raw({ healthz: ok({ ...HEALTHZ, capacity_database_present: false }), receipts: ok([]) }), FLEET, LIVE_NOW);
  assert.equal(missing.receipts.leases.available, false);
  assert.match(missing.receipts.leases.note ?? "", /missing/);
  const present = buildDirectorSnapshot(raw({ receipts: ok([]) }), FLEET, LIVE_NOW);
  assert.equal(present.receipts.leases.available, true);
  assert.equal(present.receipts.leases.note, null);
});

test("healthz that omits capacity_database_present leaves lanes unknown with an exception", () => {
  const { capacity_database_present: _omit, ...rest } = HEALTHZ;
  const snap = buildDirectorSnapshot(raw({ healthz: ok(rest) }), FLEET, LIVE_NOW);
  assert.equal(snap.lanes.available, false);
  assert.ok(snap.exceptions.some((e) => e.code === "capacity.database_unknown"));
  assert.equal(snap.receipts.leases.available, false);
});

test("work receipt note: none-yet only when the contract DB is confirmed present", () => {
  const present = buildDirectorSnapshot(HEALTHY, FLEET, LIVE_NOW);
  assert.match(present.receipts.work.note ?? "", /No terminal work receipts recorded yet/);
  const unknown = buildDirectorSnapshot(
    raw({ healthz: fail("boom"), contractsStatus: ok({ mode: "read-only", canonical: { ready: true } }) }),
    FLEET,
    LIVE_NOW
  );
  assert.doesNotMatch(unknown.receipts.work.note ?? "", /recorded yet/);
});

test("a lease with no usable expires_at is malformed, not expired", () => {
  const body = capacityWith({ ticket: "X-1" });
  const alloc = body.slots[0].allocation as Record<string, unknown>;
  delete alloc.expires_at;
  const snap = buildDirectorSnapshot(raw({ capacity: ok(body) }), FLEET, LIVE_NOW);
  assert.equal(snap.lanes.items[0].state, "malformed");
  assert.equal(snap.delegations.active.length, 0);
  assert.ok(snap.exceptions.some((e) => e.code === "capacity.lease_malformed"));
  assert.ok(!snap.exceptions.some((e) => e.code === "capacity.lease_expired"));
});

test("other info-severity codes are filtered from per-project reason codes too", () => {
  const readiness = {
    ...READINESS_READY,
    findings: [...READINESS_READY.findings, { code: "policy.other_note", severity: "info", message: "fyi", sources: [] }],
    projects: [{ slug: "demo", readiness: "ready", reason_codes: ["policy.other_note", "policy.hindsight_non_authoritative"] }]
  };
  const snap = buildDirectorSnapshot(raw({ ...HEALTHY, readiness: ok(readiness) }), FLEET, LIVE_NOW);
  assert.deepEqual(snap.readiness.projects[0].reason_codes, []);
  assert.deepEqual(snap.readiness.reason_codes, []);
});

test("contracts status without canonical.ready is unavailable, not silently unknown", () => {
  const snap = buildDirectorSnapshot(raw({ contractsStatus: ok({}) }), FLEET, LIVE_NOW);
  assert.equal(snap.sources.find((s) => s.name === "contractsStatus")?.ok, false);
  assert.ok(snap.exceptions.some((e) => e.code === "director.source_unavailable" && e.source === "contractsStatus"));
});

function capacityWith(metadata: Record<string, string>) {
  return {
    ...CAPACITY,
    slots: [
      { ...CAPACITY.slots[0], allocation: { ...CAPACITY.slots[0].allocation, metadata } },
      CAPACITY.slots[1],
      CAPACITY.slots[2]
    ],
    needs_reconciliation: false
  };
}
