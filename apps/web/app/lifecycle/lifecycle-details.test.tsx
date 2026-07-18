import assert from "node:assert/strict";
import test from "node:test";
import type { LifecycleProjection } from "@holocene/lifecycle-client";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LifecycleDetails } from "./lifecycle-details.js";

const noop = () => undefined;

test("Lifecycle UI renders identity, versions, provenance, work, blockers and verdicts", () => {
  const html = renderToStaticMarkup(
    <LifecycleDetails
      projection={projection("current")}
      actorId="operator:holocene"
      capabilityId="holocene-grant"
      onActorId={noop}
      onCapabilityId={noop}
      onAction={noop}
    />
  );
  for (const expected of [
    "delorenj/33GOD",
    "State version",
    "delorenj/lifecycle",
    "Observed through",
    "transition:planned:active",
    "bmad-code-review@6.10.2",
    "55555555-5555-4555-8555-555555555555",
    "2026-07-18T11:55:00Z",
    "Credential unavailable",
    "approval-1",
    "EXPECTED_STATE_VERSION_MISMATCH",
    "stale"
  ]) {
    assert.match(html, new RegExp(expected));
  }
});

test("missing and stale UI are degraded and action-disabled", () => {
  for (const status of ["missing", "stale"] as const) {
    const html = renderToStaticMarkup(
      <LifecycleDetails
        projection={projection(status)}
        actorId="operator:holocene"
        capabilityId="holocene-grant"
        onActorId={noop}
        onCapabilityId={noop}
        onAction={noop}
      />
    );
    assert.match(html, /Commands are disabled/);
    assert.match(html, /degraded/);
    assert.match(html, /button[^>]*disabled/);
  }
});

test("gate resolution is explicitly disabled until a resolution choice exists", () => {
  const value = projection("current");
  value.legal_frontier = [
    {
      id: "gate:approval-1:resolve",
      kind: "gate_resolution",
      action: "resolve_gate",
      allowed: true,
      capability_required: "lifecycle.intent.submit",
      reason_code: "LEGAL_GATE_RESOLUTION",
      expected_state_version: 7
    }
  ];
  const html = renderToStaticMarkup(
    <LifecycleDetails
      projection={value}
      actorId="operator:holocene"
      capabilityId="holocene-grant"
      onActorId={noop}
      onCapabilityId={noop}
      onAction={noop}
    />
  );
  assert.match(html, /Disabled: choose a canonical resolution before publishing/);
  assert.match(html, /button[^>]*disabled/);
});

function projection(status: "current" | "stale" | "missing"): LifecycleProjection {
  const missing = status === "missing";
  return {
    lifecycle_id: "11111111-1111-4111-8111-111111111111",
    repo: missing ? null : "delorenj/33GOD",
    spec_version: missing ? null : 2,
    state_version: missing ? null : 7,
    previous_state_version: missing ? null : 6,
    status: missing ? "unknown" : "planned",
    health: status === "current" ? "nominal" : "degraded",
    phase: missing ? null : "plan",
    progress_percent: missing ? null : 10,
    fingerprint: null,
    projection_status: status,
    authority_state: missing
      ? null
      : {
          status: "planned",
          health: "nominal",
          phase: "plan",
          progress_percent: 10,
          fingerprint: null
        },
    legal_frontier: [
      {
        id: "transition:planned:active",
        kind: "state_transition",
        action: "transition",
        allowed: true,
        capability_required: "lifecycle.intent.submit",
        reason_code: "LEGAL_TRANSITION",
        expected_state_version: 7
      }
    ],
    obligations: [
      {
        id: "independent-review",
        obligation_instance_id: "55555555-5555-4555-8555-555555555555",
        activated_at: "2026-07-18T11:55:00Z",
        kind: "independent_review",
        status: "pending",
        description: "Obtain independent review",
        skill_ref: { name: "bmad-code-review", selector: "6.10.2" },
        owner_id: null,
        due_at: null,
        source_observation_ids: []
      }
    ],
    blockers: [{ id: "credential", summary: "Credential unavailable", status: "open" }],
    gates: [{ id: "approval-1", reason: "approval-1", status: "opened" }],
    capabilities: [
      {
        capability_id: "holocene-grant",
        capability_version: 7,
        actor_id: "operator:holocene",
        actions: ["lifecycle.intent.submit"],
        scope: "lifecycle:11111111-1111-4111-8111-111111111111",
        issued_at: "2026-07-18T11:00:00Z",
        expires_at: null,
        state_version: 7
      }
    ],
    provenance: {
      authority: "delorenj/lifecycle",
      authority_instance: "authority-1",
      policy_version: "1.0.0"
    },
    freshness: {
      status: status === "current" ? "fresh" : "stale",
      observed_through: "2026-07-18T11:59:00Z",
      evaluated_at: "2026-07-18T12:00:00Z",
      as_of: "2026-07-18T12:00:00Z",
      max_age_seconds: 600
    },
    publication: { event_sequence: 14 },
    source: missing
      ? null
      : {
          event_id: "33333333-3333-4333-8333-333333333333",
          event_type: "bloodbank.v1.lifecycle.snapshot.updated",
          event_time: "2026-07-18T12:00:00Z",
          ordering_key: "lifecycle:11111111-1111-4111-8111-111111111111",
          projected_at: "2026-07-18T12:00:01Z",
          subject: "bloodbank.evt.v1.lifecycle.snapshot.updated",
          authority_source: "urn:33god:service:lifecycle",
          producer: "delorenj/lifecycle",
          service: "lifecycle",
          kind: "event",
          domain: "lifecycle",
          schema_ref: "bloodbank.v1.lifecycle.snapshot.updated.v3",
          data_schema:
            "apicurio://holyfields/bloodbank.v1.lifecycle.snapshot.updated/versions/3",
          actor: {
            type: "service",
            agent_id: "delorenj.lifecycle",
            instance: "authority-1"
          },
          correlation_id: "22222222-2222-4222-8222-222222222222",
          causation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        },
    command_verdicts: [
      {
        reply_event_id: "44444444-4444-4444-8444-444444444444",
        command_event_id: "55555555-5555-4555-8555-555555555555",
        command_id: "66666666-6666-4666-8666-666666666666",
        idempotency_key: "command",
        expected_state_version: 8,
        observed_state_version: 7,
        verdict: "stale",
        mutated: false,
        resulting_state_version: null,
        applied_event_id: null,
        capability_id: null,
        reason_code: "EXPECTED_STATE_VERSION_MISMATCH",
        correlation_id: null,
        causation_id: null,
        responded_at: "2026-07-18T12:01:00Z"
      }
    ]
  };
}
