import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAgents,
  buildProjects,
  linkProject,
  declaredAgents,
  projectTickets,
  workerContractors,
  type ProjectRecord,
  type RegistryRow
} from "./hub-model.js";

const ROOT = "/home/delorenj/code/33GOD";
const projects: ProjectRecord[] = [
  { id: "33god", name: "33GOD", repoPath: ROOT, board: "33GOD", indexed: true },
  { id: "bb", name: "Bloodbank", repoPath: `${ROOT}/bloodbank`, board: "BB", boardId: "b-bb", indexed: true },
  { id: "holocene", name: "Holocene", repoPath: `${ROOT}/holocene`, board: "HOLOC", indexed: false },
  { id: "flume", name: "Flume", repoPath: `${ROOT}/flume`, board: "FLUME", indexed: true },
  { id: "james-brennan", name: "James Brennan", repoPath: "/home/delorenj/code/james-brennan", board: "JIMB", indexed: true }
];
import type { AgentActivity } from "./agent-activity.js";
const pulse = (_id: string, sinceMs: number): AgentActivity => ({
  reading: { state: "active", sinceMs, lastMs: sinceMs + 30_000 },
  sessions: [],
  subagents: []
});
const row = (agentId: string, repo: string, projectPath: string, extra: Partial<RegistryRow> = {}): RegistryRow => ({
  agentId, displayName: agentId, role: "pm", repo, projectPath, ...extra
});
const registry: RegistryRow[] = [
  row("33god-pm", "33god", ROOT, { displayName: "Grolf" }),
  row("bloodbank-pm", "bloodbank", `${ROOT}/bloodbank`),
  row("holocene-pm", "holocene", `${ROOT}/holocene/`),
  row("flume-pm", "flume", "~/code/33GOD/flume"),
  row("james-brennan-pm", "james-brennan", "/home/delorenj/code/james-brennan"),
  row("tonnybox-pm", "tonnybox", "/home/delorenj/code/tonnybox")
];

test("an agent joins its project on project_path, even when repo and project_id differ", () => {
  const link = linkProject(registry[1], projects);
  assert.equal(link?.id, "bb");
  assert.equal(link?.basis, "project_path");
});

test("trailing slashes and ~ expand before the path match", () => {
  assert.equal(linkProject(registry[2], projects)?.basis, "project_path");
  assert.equal(linkProject(registry[3], projects)?.id, "flume");
});

test("repo name and then board id are the fallbacks; nothing matches is no project", () => {
  assert.equal(linkProject(row("x", "Holocene", "/elsewhere"), projects)?.basis, "repo");
  assert.equal(linkProject(row("y", "nope", "", { boardId: "b-bb" }), projects)?.basis, "board");
  assert.equal(linkProject(registry[5], projects), undefined);
});

test("worker scopes find their PM from --profile and a ticket from the query file", () => {
  const found = workerContractors(
    [
      { unit: "hermes-worker-proc_8f3a2c.scope", active: true, description: '[systemd-run] /usr/bin/zsh -lic "hermes --profile james-brennan-pm chat -Q --query-file /tmp/jimb284-x.txt"' },
      { unit: "hermes-worker-proc_dead.scope", active: false, description: "hermes --profile james-brennan-pm chat" },
      { unit: "hermes-worker-proc_unknown.scope", active: true, description: "hermes --profile nobody chat" }
    ],
    new Set(["james-brennan-pm"])
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].parent, "james-brennan-pm");
  assert.equal(found[0].ticket, "JIMB-284");
});

test("the latest ticket event wins and keeps earlier fields it did not repeat", () => {
  const tickets = projectTickets([
    { at: "2026-10-05T10:00:00Z", ticketId: "t1", ticketKey: "HOLOC-14", title: "Hub", band: "unstarted", repo: "holocene", labels: [] },
    { at: "2026-10-05T11:00:00Z", ticketId: "t1", ticketKey: "HOLOC-14", band: "started", phase: "In Progress", labels: ["agent:working"] }
  ]);
  const t = tickets.get("HOLOC-14")!;
  assert.equal(t.title, "Hub");
  assert.equal(t.band, "started");
  assert.deepEqual(t.labels, ["agent:working"]);
});

test("the PM of a parent project directs, and nested PMs report to it", () => {
  const now = Date.parse("2026-10-05T14:22:30Z");
  const model = buildAgents({
    nowMs: now,
    registry,
    projects,
    asm: new Map([
      ["hermes:a:bloodbank-pm", { scope: "hermes:a:bloodbank-pm", state: "awaiting_human", blockKind: "bell", blockedUntilMs: now + 600_000 }]
    ]),
    activity: new Map([["holocene-pm", pulse("holocene-pm", now - 60_000)]]),
    gateways: new Map([["hermes-tonnybox-pm-gateway.service", "inactive"]]),
    invocations: [],
    scopes: [],
    tickets: new Map()
  });
  const by = new Map(model.agents.map((a) => [a.id, a]));
  assert.equal(by.get("33god-pm")!.role, "director");
  assert.equal(by.get("holocene-pm")!.reportsTo, "33god-pm");
  assert.equal(by.get("holocene-pm")!.reportsBasis, "inferred");
  assert.equal(by.get("holocene-pm")!.heldSeconds, 60);
  assert.equal(by.get("james-brennan-pm")!.reportsTo, "ceo");
  assert.equal(by.get("bloodbank-pm")!.signal, "you");
  assert.equal(by.get("tonnybox-pm")!.state, "gone");
  assert.equal(by.get("tonnybox-pm")!.active, false);
  assert.equal(by.get("tonnybox-pm")!.project, undefined);
  assert.equal(model.stats.noProject, 1);
  assert.equal(model.stats.waiting, 1);
});

test("components map to projects by repo path; unparented projects become islands", () => {
  const { projects: nodes, edges } = buildProjects({
    rootPath: ROOT,
    components: [
      { id: "bloodbank", name: "Bloodbank", repoPath: `${ROOT}/bloodbank` },
      { id: "holocene", name: "Holocene", repoPath: `${ROOT}/holocene` },
      { id: "krebs", name: "Krebs", repoPath: `${ROOT}/krebs` },
      { id: "skillex", name: "Skillex", repoPath: "/home/delorenj/code/skillex" }
    ],
    projects,
    agents: [],
    tickets: new Map()
  });
  const by = new Map(nodes.map((n) => [n.id, n]));
  assert.equal(by.get("33god")!.kind, "parent");
  assert.equal(by.get("bloodbank")!.projectId, "bb");
  assert.equal(by.get("krebs")!.registered, false);
  assert.equal(by.get("skillex")!.kind, "outside");
  assert.equal(by.get("flume")!.kind, "component");
  assert.equal(by.get("james-brennan")!.kind, "island");
  assert.ok(edges.some((e) => e.from === "holocene" && e.to === "bloodbank"));
  assert.ok(edges.every((e) => by.has(e.from) && by.has(e.to)));
});

test("an idle agent's recency is when it went idle, not the sweeper's last pass", () => {
  const now = Date.parse("2026-10-05T16:38:14Z");
  const sweep = now - 500;
  const model = buildAgents({
    nowMs: now,
    registry,
    projects,
    asm: new Map([
      ["hermes:a:flume-pm", { scope: "hermes:a:flume-pm", state: "idle", sinceMs: now - 3_600_000, lastMs: sweep }],
      ["hermes:a:bloodbank-pm", { scope: "hermes:a:bloodbank-pm", state: "unknown", sinceMs: now - 86_400_000, lastMs: sweep }]
    ]),
    activity: new Map([["holocene-pm", { reading: { state: "active" as const, sinceMs: now - 60_000, lastMs: sweep }, sessions: [], subagents: [] }]]),
    gateways: new Map(),
    invocations: [{ id: "e1", type: "completed", at: new Date(now - 120_000).toISOString(), agentId: "bloodbank-pm", invocationId: "i1" }],
    scopes: [],
    tickets: new Map()
  });
  const by = new Map(model.agents.map((a) => [a.id, a]));
  assert.equal(by.get("flume-pm")!.lastActiveAt, new Date(now - 3_600_000).toISOString());
  assert.equal(by.get("bloodbank-pm")!.lastActiveAt, new Date(now - 120_000).toISOString());
  assert.equal(by.get("holocene-pm")!.lastActiveAt, new Date(sweep).toISOString());
});
