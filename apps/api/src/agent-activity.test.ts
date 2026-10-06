import assert from "node:assert/strict";
import { test } from "node:test";
import { foldActivity, ownerResolver, type ActivityEvent } from "./agent-activity.js";

const T0 = Date.parse("2026-10-06T12:49:00Z");
const ROOT = "/home/delorenj/code/33GOD";
const resolve = ownerResolver([
  { agentId: "33god-pm", path: ROOT, role: "pm" },
  { agentId: "pilot-pm", path: `${ROOT}/pilot`, role: "pm" },
  { agentId: "flume-pm", path: `${ROOT}/flume`, role: "pm" },
  { agentId: "dumply", path: "/home/delorenj/code/TikTokTrivia", role: "pm" },
  { agentId: "sidepiece-pm", path: "/home/delorenj/code/sidepiece", role: "pm" },
  { agentId: "sidepiece-scrum-master", path: "/home/delorenj/code/sidepiece", role: "scrum-master" }
]);

let n = 0;
const claude = (offsetMs: number, type: string, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: `e${++n}`, type, atMs: T0 + offsetMs, cli: "claude", actorType: "agent_cli", actorAgent: "bloodbank.agent.claude",
  producer: "claude-code", correlationId: "sess-1", cwd: `${ROOT}/pilot`, pane: "93", session: "Workspace", ...extra
});
const sub = (offsetMs: number, id: string) =>
  claude(offsetMs, "bloodbank.agent.invocation.started", { invocationId: id, parentInvocationId: "sess-1" });
const subStop = (offsetMs: number) => claude(offsetMs, "bloodbank.agent.invocation.completed", { invocationId: "sess-1" });
const hermes = (offsetMs: number, profile: string, type: string): ActivityEvent => ({
  id: `h${++n}`, type, atMs: T0 + offsetMs, cli: "hermes", actorType: "agent_api", actorAgent: profile,
  producer: `hermes-agent:${profile}`, correlationId: `c-${profile}`
});

test("a Claude dynamic workflow in pilot makes Pilot PM and Grolf work and gives Pilot PM a child per subagent", () => {
  const events = [
    claude(0, "bloodbank.conversation.turn.started"),
    sub(1_000, "sub-a"), sub(1_100, "sub-b"), sub(1_200, "sub-c"),
    claude(2_000, "bloodbank.agent.tool.requested"),
    claude(38_000, "bloodbank.conversation.turn.completed", { outcome: "completed" })
  ];
  const now = T0 + 120_000;
  const by = foldActivity(events, resolve, now);

  const pilot = by.get("pilot-pm")!;
  assert.equal(pilot.reading.state, "active", "subagents are still running after the parent turn ended");
  assert.deepEqual(pilot.subagents.map((c) => c.invocationId), ["sub-a", "sub-b", "sub-c"]);
  assert.ok(pilot.subagents.every((c) => c.eventId && c.parent === "pilot-pm"));

  const grolf = by.get("33god-pm")!;
  assert.equal(grolf.reading.state, "active", "the director above the project is working too");
  assert.equal(grolf.subagents.length, 0, "children belong to the project's own PM");
  assert.equal(by.has("flume-pm"), false);
});

test("subagent stops close children oldest first and the parent goes to a check when the last one returns", () => {
  const events = [
    claude(0, "bloodbank.conversation.turn.started"),
    sub(1_000, "sub-a"), sub(1_100, "sub-b"),
    claude(5_000, "bloodbank.conversation.turn.completed", { outcome: "completed" }),
    subStop(10_000)
  ];
  let by = foldActivity(events, resolve, T0 + 20_000);
  assert.deepEqual(by.get("pilot-pm")!.subagents.map((c) => c.invocationId), ["sub-b"]);
  assert.equal(by.get("pilot-pm")!.reading.state, "active");

  by = foldActivity([...events, subStop(30_000)], resolve, T0 + 40_000);
  assert.equal(by.get("pilot-pm")!.subagents.length, 0);
  assert.equal(by.get("pilot-pm")!.reading.state, "active", "a subagent stop is still mid-turn work");
  assert.equal(by.get("pilot-pm")!.sessions[0].state, "active");
});

test("a finished turn with nothing open reads as a check, and the director above does not echo it", () => {
  const events = [claude(0, "bloodbank.conversation.turn.started"), claude(30_000, "bloodbank.conversation.turn.completed", { outcome: "completed" })];
  const by = foldActivity(events, resolve, T0 + 60_000);
  assert.equal(by.get("pilot-pm")!.reading.state, "done");
  assert.equal(by.has("33god-pm"), false, "work beneath an agent only counts while it is live");
});

test("subagents that never report back are dropped after the held ceiling", () => {
  const events = [claude(0, "bloodbank.conversation.turn.started"), sub(1_000, "sub-a"), claude(30_000, "bloodbank.conversation.turn.completed", { outcome: "completed" })];
  const by = foldActivity(events, resolve, T0 + 31 * 60_000);
  assert.equal(by.get("pilot-pm")?.subagents.length ?? 0, 0);
  assert.notEqual(by.get("pilot-pm")?.reading.state, "active");
});

test("a Hermes agent nobody has spoken to in days is not working, whatever its stored state says", () => {
  const events = [hermes(-12 * 86_400_000, "dumply", "bloodbank.agent.invocation.started"), hermes(-12 * 86_400_000 + 1_000, "dumply", "bloodbank.conversation.turn.started")];
  const by = foldActivity(events, resolve, T0);
  assert.notEqual(by.get("dumply")?.reading.state, "active");
});

test("a Hermes profile's own run reads as work, then as a check, and Hermes events stay with that profile", () => {
  const events = [hermes(0, "flume-pm", "bloodbank.conversation.turn.started"), hermes(1_000, "flume-pm", "bloodbank.agent.tool.requested")];
  let by = foldActivity(events, resolve, T0 + 30_000);
  assert.equal(by.get("flume-pm")!.reading.state, "active");
  assert.equal(by.get("flume-pm")!.sessions[0].basis, "profile");
  assert.equal(by.get("33god-pm")?.reading.state, "active", "the director sees work beneath it while it is live");

  by = foldActivity([...events, hermes(40_000, "flume-pm", "bloodbank.conversation.turn.completed")], resolve, T0 + 60_000);
  assert.equal(by.get("flume-pm")!.reading.state, "done");
});

test("pipeline actors and unknown profiles are never agents", () => {
  const noise: ActivityEvent[] = [
    { ...claude(0, "bloodbank.conversation.turn.started"), actorType: "service" },
    hermes(0, "fleet-bloodbank-gateway", "bloodbank.conversation.turn.started"),
    hermes(0, "somebody-else", "bloodbank.conversation.turn.started")
  ];
  assert.equal(foldActivity(noise, resolve, T0 + 1_000).size, 0);
});

test("a session that changes directory takes its earlier evidence with it", () => {
  const events = [
    claude(0, "bloodbank.conversation.turn.started", { cwd: `${ROOT}/flume` }),
    claude(10_000, "bloodbank.agent.tool.requested", { cwd: `${ROOT}/pilot` })
  ];
  const by = foldActivity(events, resolve, T0 + 20_000);
  assert.equal(by.get("pilot-pm")!.reading.state, "active");
  assert.equal(by.has("flume-pm"), false);
});

test("the PM owns work in a shared repo, not its scrum master", () => {
  const events = [claude(0, "bloodbank.conversation.turn.started", { cwd: "/home/delorenj/code/sidepiece/src", pane: "7" })];
  const by = foldActivity(events, resolve, T0 + 5_000);
  assert.equal(by.get("sidepiece-pm")!.reading.state, "active");
  assert.equal(by.has("sidepiece-scrum-master"), false);
});

test("two sessions in one project report the worst, and one finishing never hides the other", () => {
  const events = [
    claude(0, "bloodbank.conversation.turn.started", { correlationId: "a", pane: "1" }),
    claude(1_000, "bloodbank.conversation.turn.started", { correlationId: "b", pane: "2" }),
    claude(5_000, "bloodbank.conversation.turn.completed", { correlationId: "a", pane: "1", outcome: "completed" })
  ];
  const by = foldActivity(events, resolve, T0 + 10_000);
  assert.equal(by.get("pilot-pm")!.reading.state, "active");
  assert.equal(by.get("pilot-pm")!.sessions.length, 2);
});
