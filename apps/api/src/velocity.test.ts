import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildVelocityTimeline,
  normalizeGatewayEvent,
  pairInvocations,
  VELOCITY_RANGE_MS,
  type VelocityEvent
} from "./velocity.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const HOUR = 60 * 60 * 1000;

const AGENTS = [
  { agent_id: "holocene-pm", display_name: "Holocene PM", repo: "holocene" },
  { agent_id: "navi-pm", display_name: "Navi PM", repo: "navi" },
  { agent_id: "drifter-pm", display_name: "Drifter PM", repo: "" }
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function event(partial: Partial<VelocityEvent> & Pick<VelocityEvent, "kind" | "key">): VelocityEvent {
  return {
    at: iso(NOW - 10 * 60 * 1000),
    agent_id: "holocene-pm",
    ...partial
  };
}

test("a started plus a completed pair into one completed span", () => {
  const spans = pairInvocations(
    [
      event({ kind: "started", key: "inv-1", at: iso(NOW - 20 * 60 * 1000), lane: "batch", reason: "voice-inbox" }),
      event({ kind: "completed", key: "inv-1", at: iso(NOW - 5 * 60 * 1000) })
    ],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, "completed");
  assert.equal(spans[0].startedAt, iso(NOW - 20 * 60 * 1000));
  assert.equal(spans[0].endedAt, iso(NOW - 5 * 60 * 1000));
  assert.equal(spans[0].label, "voice-inbox");
  assert.equal(spans[0].project, "holocene");
});

test("a span that started before the window but ended inside it is kept for clipping", () => {
  const spans = pairInvocations(
    [
      event({ kind: "started", key: "inv-clip", at: iso(NOW - 90 * 60 * 1000) }),
      event({ kind: "completed", key: "inv-clip", at: iso(NOW - 10 * 60 * 1000) })
    ],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, "completed");
});

test("spans fully outside the window are dropped", () => {
  const spans = pairInvocations(
    [
      event({ kind: "started", key: "inv-old", at: iso(NOW - 3 * HOUR) }),
      event({ kind: "completed", key: "inv-old", at: iso(NOW - 2 * HOUR) })
    ],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(spans.length, 0);
});

test("a started with no end is running while young and orphaned once stale", () => {
  const young = pairInvocations(
    [event({ kind: "started", key: "inv-run", at: iso(NOW - 15 * 60 * 1000) })],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(young.length, 1);
  assert.equal(young[0].status, "running");
  assert.equal(young[0].endedAt, null);

  const stale = pairInvocations(
    [event({ kind: "started", key: "inv-orphan", at: iso(NOW - 150 * 60 * 1000) })],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["3d"]
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0].status, "orphaned");
  assert.equal(stale[0].endedAt, null);

  // An orphaned span whose start fell before the window has nothing to show.
  const invisible = pairInvocations(
    [event({ kind: "started", key: "inv-gone", at: iso(NOW - 3 * HOUR) })],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(invisible.length, 0);
});

test("a failure wins over a completion on the same invocation", () => {
  const spans = pairInvocations(
    [
      event({ kind: "started", key: "inv-fail", at: iso(NOW - 30 * 60 * 1000) }),
      event({ kind: "completed", key: "inv-fail", at: iso(NOW - 20 * 60 * 1000) }),
      event({ kind: "failed", key: "inv-fail", at: iso(NOW - 6 * 60 * 1000) })
    ],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, "failed");
  assert.equal(spans[0].endedAt, iso(NOW - 6 * 60 * 1000));
});

test("a completion with no started becomes a zero-start span at its end time", () => {
  const spans = pairInvocations(
    [event({ kind: "completed", key: "inv-lone", at: iso(NOW - 8 * 60 * 1000) })],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].status, "completed");
  assert.equal(spans[0].startedAt, spans[0].endedAt);
});

test("events from agents outside the fleet registry are filtered out", () => {
  const spans = pairInvocations(
    [
      event({ kind: "started", key: "inv-x", agent_id: "ghost-pm" }),
      event({ kind: "completed", key: "inv-x", agent_id: "ghost-pm" }),
      event({ kind: "started", key: "inv-y", agent_id: "navi-pm" })
    ],
    AGENTS,
    NOW,
    VELOCITY_RANGE_MS["1h"]
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].agent_id, "navi-pm");
});

test("buildVelocityTimeline groups agents under projects, most recent first, and drops empty agents", () => {
  const timeline = buildVelocityTimeline(
    [
      event({ kind: "started", key: "inv-a", agent_id: "navi-pm", at: iso(NOW - 50 * 60 * 1000) }),
      event({ kind: "completed", key: "inv-a", agent_id: "navi-pm", at: iso(NOW - 40 * 60 * 1000) }),
      event({ kind: "started", key: "inv-b", agent_id: "holocene-pm", at: iso(NOW - 20 * 60 * 1000) }),
      event({ kind: "failed", key: "inv-b", agent_id: "holocene-pm", at: iso(NOW - 10 * 60 * 1000) }),
      event({ kind: "started", key: "inv-c", agent_id: "drifter-pm", at: iso(NOW - 30 * 60 * 1000) })
    ],
    AGENTS,
    NOW,
    "1h"
  );

  assert.deepEqual(
    timeline.lanes.map((lane) => lane.project),
    ["holocene", "unassigned", "navi"]
  );
  assert.equal(timeline.lanes[0].agents[0].display_name, "Holocene PM");
  assert.equal(timeline.lanes[1].agents[0].spans[0].status, "running");
  assert.equal(timeline.counts.spans, 3);
  assert.equal(timeline.counts.running, 1);
  assert.equal(timeline.counts.failed, 1);
  assert.equal(timeline.source, "candystore");
  assert.equal(timeline.from, iso(NOW - VELOCITY_RANGE_MS["1h"]));
});

function gatewayRow(data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: "bloodbank.agent.invocation.started",
    time: iso(NOW - 5 * 60 * 1000),
    producer: "hermes-agent:holocene-pm",
    service: "bloodbank-hermes-gateway",
    actor: { agent_id: "holocene-pm" },
    data,
    ...extra
  };
}

test("normalizeGatewayEvent reads context as an object and prefers the ticket key as the issue", () => {
  const event = normalizeGatewayEvent(
    gatewayRow({
      lane: "batch",
      context: { repo: "holocene", reason: "ticket-grooming", ticket_key: "HOLOC-20" },
      invocation_id: "inv-ctx"
    }),
    "started"
  );
  assert.equal(event?.key, "inv-ctx");
  assert.equal(event?.issue, "HOLOC-20");
  assert.equal(event?.reason, "ticket-grooming");
  assert.equal(event?.lane, "batch");
});

test("normalizeGatewayEvent parses a JSON-string context and survives a truncated one", () => {
  const good = normalizeGatewayEvent(
    gatewayRow({
      lane: "interactive",
      context: "{\"repo\":\"holocene\",\"reason\":\"voice-inbox\"}",
      invocation_id: "inv-str"
    }),
    "started"
  );
  assert.equal(good?.reason, "voice-inbox");

  const truncated = normalizeGatewayEvent(
    gatewayRow({
      lane: "interactive",
      context: "{\"repo\":\"holocene\",\"reason\":\"voice-inb",
      invocation_id: "inv-bad"
    }),
    "started"
  );
  assert.equal(truncated?.key, "inv-bad");
  assert.equal(truncated?.reason, undefined);
});

test("normalizeGatewayEvent falls back to command_id then turn_id and drops rows with no key", () => {
  const byCommand = normalizeGatewayEvent(gatewayRow({ command_id: "cmd-1" }), "started");
  assert.equal(byCommand?.key, "cmd-1");

  const byTurn = normalizeGatewayEvent(gatewayRow({ turn_id: "turn-1" }), "completed");
  assert.equal(byTurn?.key, "turn-1");

  const noKey = normalizeGatewayEvent(gatewayRow({ lane: "batch" }), "started");
  assert.equal(noKey, undefined);
});
