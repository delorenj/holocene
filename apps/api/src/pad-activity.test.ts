import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { buildAgents, buildPadActivity, type RegistryRow } from "./hub-model.js";
import { registerPadActivityRoute } from "./pad-activity.js";

const now = Date.parse("2026-11-16T20:00:00.123Z");
const registry: RegistryRow[] = ["routable", "disabled", "declared-only"].map((agentId) => ({
  agentId, displayName: "Private name", role: "pm", repo: "private-repo", projectPath: "/private/repo"
}));
const model = buildAgents({
  nowMs: now, registry, projects: [], asm: new Map(), gateways: new Map(), scopes: [],
  invocations: [{ id: "private-event", type: "started", at: new Date(now - 1).toISOString(), agentId: "routable",
    invocationId: "private-invocation", ticketKey: "PRIVATE-42" }],
  tickets: new Map([["PRIVATE-42", { key: "PRIVATE-42", title: "Private ticket", labels: ["private-label"], updatedAt: "" }]]),
  activity: new Map([["routable", {
    reading: { state: "active", lastMs: now - 2, sinceMs: now - 1000 }, subagents: [],
    sessions: [{ key: "private-session", cli: "hermes", cwd: "/private/worktree", basis: "profile", state: "active", lastMs: now - 2, subagents: 0 }]
  }]])
});
const sources = [
  { name: "events", ageSeconds: 1, maxSeconds: 120, detail: "private error", value: "private count" },
  { name: "asm", down: true, detail: "redis://private:password@localhost" },
  { name: "agents registry", ageSeconds: 30, detail: "/private/registry.yaml" },
  { name: "pjangler", ageSeconds: 0 },
  { name: "private-source", detail: "/private/source" }
];
const project = () => buildPadActivity(now, model, new Set(["routable"]), sources);

test("pad projection allowlists only routable activity and safe source freshness, never hub context", () => {
  assert.ok(model.agents[0].evidence.length, "fixture must really contain private evidence");
  assert.ok(model.agents[0].ticket, "fixture must really contain a private ticket");
  const result = project();
  assert.deepEqual(result, {
    generatedAt: new Date(now).toISOString(),
    sources: [{ name: "events", ageSeconds: 1, maxSeconds: 120 }, { name: "asm", down: true },
      { name: "agents registry", ageSeconds: 30 }, { name: "pjangler", ageSeconds: 0 }],
    agents: [{ id: "routable", signal: model.agents[0].signal, lastWorkAt: model.agents[0].lastWorkAt }]
  });
  assert.doesNotMatch(JSON.stringify(result), /private|evidence|cwd|ticket|project|contractors|invocation|detail|value|reportsTo|gateway|lastActiveAt/);
  assert.deepEqual(buildPadActivity(now, model, new Set(), sources).agents, [], "unknown routability fails closed");
});

test("dedicated GET is no-store and returns the narrow projection; no full-hub or write route is registered", async () => {
  const app = Fastify();
  registerPadActivityRoute(app, async () => project());
  try {
    const res = await app.inject({ method: "GET", url: "/api/pad/activity" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.json(), project());
    for (const method of ["HEAD", "POST", "PUT", "DELETE"] as const) {
      assert.equal((await app.inject({ method, url: "/api/pad/activity" })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: "GET", url: "/api/modules/hub/agents" })).statusCode, 404);
  } finally { await app.close(); }
});

test("projection failures are unavailable, not an error containing filesystem or source context", async () => {
  const app = Fastify();
  registerPadActivityRoute(app, async () => { throw new Error("/private/registry.yaml: secret"); });
  try {
    const res = await app.inject({ method: "GET", url: "/api/pad/activity" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.json(), { error: "activity_unavailable" });
  } finally { await app.close(); }
});
