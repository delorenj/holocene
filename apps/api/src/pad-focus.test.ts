import assert from "node:assert/strict";
import { test } from "node:test";
import { foldActivity, ownerResolver, type ActivityEvent } from "./agent-activity.js";
import { buildAgents, buildPadActivity, type AsmRow } from "./hub-model.js";
import { WORKING_WINDOW_MS, DONE_WINDOW_MS, ERROR_WINDOW_MS } from "./deckard-state.js";
import { EventStore } from "./event-store.js";

const t = Date.parse("2026-11-27T12:00:00Z");
const registry = ["alpha", "beta"].map(agentId => ({ agentId, displayName: agentId, role: "pm", repo: "shared", projectPath: "/fixture/shared" }));
const resolve = ownerResolver(registry.map(a => ({ agentId: a.agentId, path: a.projectPath, role: a.role })));
let seq = 0;
const event = (type: string, offset = 0, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++seq}`, type: `bloodbank.${type}`, atMs: t + offset, producer: "hermes-agent:alpha", cli: "hermes",
  correlationId: "session-1", ...extra
});
function state(events: ActivityEvent[], now = t + 100, asm = new Map<string, AsmRow>()) {
  const model = buildAgents({ nowMs: now, registry, projects: [], gateways: new Map(), asm, invocations: [], scopes: [], tickets: new Map(),
    activity: foldActivity(events, resolve, now) });
  return buildPadActivity(now, model, new Set(["alpha", "beta"]), []).agents;
}

test("persisted tool_use_id and tool_call_id reach the actual activity fold without exposing tool identity publicly", () => {
  const store = new EventStore(":memory:");
  try {
    const insert = store.db.prepare("INSERT INTO events(event_id,stream,sequence,subject,type,source,collected_at,envelope) VALUES (?,?,?,?,?,?,?,?)");
    const types = ["bloodbank.agent.tool.requested", "bloodbank.agent.tool.completed"];
    for (const [index, type] of types.entries()) {
      const envelope = { id: `tool-${index}`, type, time: new Date(t + index).toISOString(), producer: "hermes-agent:alpha",
        actor: { cli: "hermes" }, correlationid: "exact-session", data: index ? { tool_call_id: "exact-tool" } : { tool_use_id: "exact-tool" } };
      insert.run(envelope.id, "fixture", index, type, type, "/fixture", envelope.time, JSON.stringify(envelope));
    }
    const rows = store.activity(0, types);
    assert.deepEqual(rows.map(r => r.toolId), ["exact-tool", "exact-tool"]);
    const events = rows.map(r => ({ id: r.id, type: r.type, atMs: Date.parse(r.time!), producer: r.producer, cli: r.cli,
      correlationId: r.correlationId, toolId: r.toolId }));
    assert.equal(state(events.slice(0, 1))[0].state, "tool");
    assert.equal(state(events)[0].state, "working");
    assert.doesNotMatch(JSON.stringify(state(events)), /exact-session|exact-tool/);
  } finally { store.close(); }
});

test("focused work states use canonical evidence; no event, expired work and expired completion stay unknown", () => {
  assert.equal(state([])[0].state, "unknown");
  const start = event("conversation.turn.started");
  assert.equal(state([start])[0].state, "working");
  assert.equal(state([start], t + WORKING_WINDOW_MS + 1)[0].state, "unknown");
  const end = event("conversation.turn.completed", 1);
  assert.equal(state([start, end])[0].state, "idle");
  assert.equal(state([start, end], t + DONE_WINDOW_MS + 2)[0].state, "unknown");
  const failed = event("conversation.turn.completed", 1, { outcome: "failed" });
  assert.equal(state([start, failed])[0].state, "failed");
  assert.equal(state([start, failed], t + ERROR_WINDOW_MS + 2)[0].state, "unknown");
  const asm = new Map([["hermes:a:alpha", { scope: "hermes:a:alpha", state: "awaiting_human", blockedUntilMs: t + 500 }]]);
  assert.equal(state([start], t + 100, asm)[0].state, "waiting");
  assert.equal(state([], t + 501, asm)[0].state, "unknown");
});

test("focused state reconciles completed/missing turns with currently active workers without inventing tool use", () => {
  const scope = { unit: "fixture-worker.scope", active: true, description: "hermes worker --profile alpha", activeSince: new Date(t - 1000).toISOString() };
  const build = (events: ActivityEvent[], active = true, now = t + 100, asm = new Map<string, AsmRow>()) => {
    const model = buildAgents({ nowMs: now, registry, projects: [], gateways: new Map(), asm, invocations: [],
      scopes: [{ ...scope, active }], tickets: new Map(), activity: foldActivity(events, resolve, now) });
    return { canonical: model.agents[0], pad: buildPadActivity(now, model, new Set(["alpha"]), []).agents[0] };
  };
  const completed = event("conversation.turn.completed");
  for (const events of [[], [completed]]) {
    const { canonical, pad } = build(events);
    assert.equal(canonical.state, "delegating");
    assert.equal(pad.signal, "working");
    assert.equal(pad.state, "working");
  }
  assert.equal(build([completed], false).pad.state, "idle");
  assert.equal(build([completed], false, t + DONE_WINDOW_MS + 1).pad.state, "unknown");
  const open = event("agent.tool.requested", -1, { toolId: "tool-1" });
  assert.equal(build([open, completed]).pad.state, "working", "completed tools stay closed while a separate worker runs");
  assert.equal(build([open], true, t + WORKING_WINDOW_MS + 1).pad.state, "working", "live worker is not fresh tool evidence");
  assert.equal(build([event("agent.invocation.failed")]).pad.state, "failed");
  const asm = new Map([["hermes:a:alpha", { scope: "hermes:a:alpha", state: "awaiting_human", blockedUntilMs: t + 500 }]]);
  assert.equal(build([completed], true, t + 100, asm).pad.state, "waiting");
});

test("Using tool requires an exact open lifecycle; other sessions, peers and nameless starts do not impersonate it", () => {
  const open = event("agent.tool.requested", 1, { toolId: "tool-1" });
  assert.equal(state([open])[0].state, "tool");
  assert.equal(state([open])[1].state, "unknown");
  assert.equal(state([event("agent.tool.requested")])[0].state, "working");
  const wrongSession = event("agent.tool.completed", 2, { toolId: "tool-1", correlationId: "session-2" });
  assert.equal(state([open, wrongSession])[0].state, "tool");
  const wrongTool = event("agent.tool.completed", 2, { toolId: "tool-2" });
  assert.equal(state([open, wrongTool])[0].state, "tool");
  assert.equal(state([open, event("agent.tool.completed", 3, { toolId: "tool-1" })])[0].state, "working");
  assert.equal(state([open, event("conversation.turn.completed", 4)])[0].state, "idle");
  assert.equal(state([open, event("agent.invocation.failed", 4)])[0].state, "failed");
  assert.equal(state([open], t + WORKING_WINDOW_MS + 2)[0].state, "unknown");
});
