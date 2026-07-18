import { config } from "dotenv";
config({ path: new URL("../../../.env", import.meta.url) });

import Fastify from "fastify";
import {
  controlAgentUnit,
  getAgentLogTail,
  getFleetSnapshot,
  restartGateways,
  syncTemplateDefaults
} from "./fleet.js";
import {
  getContainersSnapshot
} from "./containers.js";
import { getOrgTree } from "./org.js";
import {
  getToolingStat,
  getToolingStatDefinitions,
  getToolingStats,
  refreshToolingStat,
  startToolingCollectors
} from "./tooling.js";
import {
  getSystemsHistory,
  getSystemsInventory,
  getSystemsPreview,
  openSystemsPreviewTerminal,
  systemsItemAction
} from "./systems.js";
import { registerLifecycleRoutes } from "./lifecycle.js";

const N8N_WEBHOOK_BASE_URL = (process.env.N8N_WEBHOOK_BASE_URL ?? "https://n8n.delo.sh").replace(/\/$/, "");
const N8N_WEBHOOK_AUTH_HEADER = process.env.N8N_WEBHOOK_AUTH_HEADER ?? "";

const app = Fastify({ logger: true });

if (!N8N_WEBHOOK_AUTH_HEADER) {
  app.log.warn("N8N_WEBHOOK_AUTH_HEADER is not set; /api/clock routes will fail.");
}

type ActionRequestBody = {
  agent_ids?: unknown;
  agentIds?: unknown;
  all?: unknown;
};

type AgentLogParams = {
  agentId: string;
};

type AgentLogQuery = {
  lines?: string;
};

type ToolingStatParams = {
  statId: string;
};

type ToolingStreamQuery = {
  stat_id?: string;
  statId?: string;
};

type SystemsPreviewQuery = {
  kind?: string;
  target?: string;
};

type SystemsPreviewTerminalBody = {
  kind?: unknown;
  target?: unknown;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeMessage(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  const portalError = compact.match(/Could not '[^']+'[^.]*\./i)?.[0];
  if (portalError) return portalError;
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function collectErrorMessages(value: unknown, messages: string[], seen = new Set<unknown>()) {
  if (!value || seen.has(value)) return;
  if (typeof value === "string") {
    const message = normalizeMessage(value);
    if (message) messages.push(message);
    return;
  }
  if (typeof value !== "object") return;

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) collectErrorMessages(item, messages, seen);
    return;
  }

  if (!isRecord(value)) return;

  for (const key of ["text", "message", "error", "reason", "description", "raw"]) {
    const maybeMessage = value[key];
    if (typeof maybeMessage === "string") {
      const message = normalizeMessage(maybeMessage);
      if (message) messages.push(message);
    }
  }

  for (const key of ["errors", "failures", "messages", "user_messages", "state", "upstream", "body", "response", "data"]) {
    collectErrorMessages(value[key], messages, seen);
  }
}

function clockErrorFromBody(body: unknown, fallback: string) {
  const messages: string[] = [];
  collectErrorMessages(body, messages);
  return messages.find((message) => message !== fallback && message.toLowerCase() !== "error") ?? fallback;
}

function clockBodyFailed(body: unknown) {
  if (!isRecord(body)) return false;
  if (body.success === false) return true;
  if (body.status === "FAILURE") return true;
  if (clockStateFromBody(body) === "error") return true;
  if (Array.isArray(body.errors) && body.errors.length > 0) return true;
  if (Array.isArray(body.failures) && body.failures.length > 0) return true;
  if (Array.isArray(body.user_messages) && body.user_messages.length > 0) return true;
  return false;
}

function parseActionTarget(body?: ActionRequestBody): { agentIds?: string[] } | { error: string } {
  if (body?.all === true) return {};

  const rawAgentIds = body?.agent_ids ?? body?.agentIds;
  if (!Array.isArray(rawAgentIds)) {
    return { error: "Provide agent_ids or set all: true to target every agent." };
  }

  const agentIds = rawAgentIds.map((id) => (typeof id === "string" ? id.trim() : ""));
  if (agentIds.length === 0 || agentIds.some((id) => !id)) {
    return { error: "agent_ids must be a non-empty array of strings." };
  }

  return { agentIds: [...new Set(agentIds)] };
}

function parseLines(value: string | undefined) {
  const parsed = Number(value ?? 160);
  if (!Number.isFinite(parsed)) return 160;
  return Math.min(500, Math.max(20, Math.floor(parsed)));
}

app.addHook("onRequest", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return reply.status(204).send();
});

app.get("/health", async () => ({ ok: true, service: "holocene-api" }));

registerLifecycleRoutes(app);

async function forwardClockAction(action: "in" | "out") {
  const targetState = action === "in" ? "clocked_in" : "clocked_out";
  const current = await forwardClockState();
  const currentState = clockStateFromBody(current.body);
  if (!current.ok || clockBodyFailed(current.body)) {
    return {
      ok: false,
      status: current.ok ? 409 : current.status || 502,
      body: {
        success: false,
        error: clockErrorFromBody(
          current.body,
          "Clock state precheck failed; refusing automated clock action."
        ),
        upstream: current.body
      }
    };
  }
  if (!currentState) {
    return {
      ok: false,
      status: 502,
      body: {
        success: false,
        error: "Clock state precheck did not return a usable state; refusing automated clock action.",
        upstream: current.body
      }
    };
  }
  if (currentState === targetState) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        action,
        state: currentState,
        timestamp: new Date().toISOString()
      }
    };
  }
  const actionableState = action === "in" ? "clocked_out" : "clocked_in";
  if (currentState !== actionableState) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: `Clock state is ${currentState}; refusing clock-${action}.`,
        upstream: current.body
      }
    };
  }

  const url = `${N8N_WEBHOOK_BASE_URL}/webhook/clock${action}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authentication: N8N_WEBHOOK_AUTH_HEADER,
      Accept: "application/json"
    }
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body
    };
  }

  return {
    ok: true,
    status: res.status,
    body
  };
}

async function forwardClockState() {
  const url = `${N8N_WEBHOOK_BASE_URL}/webhook/clockstate`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authentication: N8N_WEBHOOK_AUTH_HEADER,
      Accept: "application/json"
    }
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body
    };
  }

  return {
    ok: true,
    status: res.status,
    body
  };
}

function clockStateFromBody(body: unknown) {
  if (!isRecord(body)) return undefined;
  if (typeof body.state === "string") return body.state;
  if (isRecord(body.state) && typeof body.state.derived_status === "string") {
    return body.state.derived_status;
  }
  if (typeof body.derived_status === "string") return body.derived_status;
  return undefined;
}

app.post("/api/clock/in", async (_req, reply) => {
  const result = await forwardClockAction("in");
  if (!result.ok || clockBodyFailed(result.body)) {
    return reply.status(result.status || 502).send({
      success: false,
      error: clockErrorFromBody(result.body, "Upstream n8n call failed"),
      upstream: result.body
    });
  }
  return reply.send(result.body);
});

app.post("/api/clock/out", async (_req, reply) => {
  const result = await forwardClockAction("out");
  if (!result.ok || clockBodyFailed(result.body)) {
    return reply.status(result.status || 502).send({
      success: false,
      error: clockErrorFromBody(result.body, "Upstream n8n call failed"),
      upstream: result.body
    });
  }
  return reply.send(result.body);
});

app.get("/api/clock/state", async (_req, reply) => {
  const result = await forwardClockState();
  if (!result.ok) {
    return reply.status(result.status || 502).send({
      success: false,
      error: clockErrorFromBody(result.body, "Upstream n8n call failed"),
      upstream: result.body
    });
  }

  return reply.send(result.body);
});


app.get("/api/modules/hermes-fleet/snapshot", async () => getFleetSnapshot());

// P2 — the fleet arranged into the operator's real reporting hierarchy
// (~/.hermes/org.yaml merged with project_path derivation + live overlay).
app.get("/api/modules/org/tree", async () => getOrgTree());

app.get<{ Querystring: { force?: string } }>("/api/modules/systems/inventory", async (req) =>
  getSystemsInventory(req.query.force === "1")
);

app.get<{ Querystring: { range?: string } }>("/api/modules/systems/history", async (req) => {
  const hours = Number(req.query.range ?? 24);
  return getSystemsHistory(Number.isFinite(hours) ? hours : 24);
});

app.get<{ Querystring: SystemsPreviewQuery }>("/api/modules/systems/preview", async (req, reply) => {
  try {
    return await getSystemsPreview(req.query.kind ?? "", req.query.target ?? "");
  } catch (err) {
    return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post<{ Body: SystemsPreviewTerminalBody }>("/api/modules/systems/preview/open-terminal", async (req, reply) => {
  try {
    const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
    const target = typeof req.body?.target === "string" ? req.body.target : "";
    return await openSystemsPreviewTerminal(kind, target);
  } catch (err) {
    return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post<{ Params: { type: string; name: string; action: string } }>(
  "/api/modules/systems/items/:type/:name/:action",
  async (req, reply) => {
    try {
      return await systemsItemAction(req.params.type, req.params.name, req.params.action);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  }
);

app.get("/api/modules/containers/snapshot", async () => getContainersSnapshot());

app.get("/api/modules/tooling/definitions", async () => ({
  generatedAt: new Date().toISOString(),
  definitions: getToolingStatDefinitions()
}));

app.get("/api/modules/tooling/stats", async () => getToolingStats());

app.get<{ Params: ToolingStatParams }>("/api/modules/tooling/stats/:statId", async (req) =>
  getToolingStat(req.params.statId)
);

app.post<{ Params: ToolingStatParams }>("/api/modules/tooling/stats/:statId/refresh", async (req, reply) => {
  try {
    return await refreshToolingStat(req.params.statId);
  } catch (err) {
    return reply.status(404).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get<{ Querystring: ToolingStreamQuery }>("/api/modules/tooling/stream", async (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    Connection: "keep-alive"
  });

  const statId = req.query.stat_id ?? req.query.statId;
  const push = async () => {
    if (statId) {
      const stat = await getToolingStat(statId);
      reply.raw.write(`event: tooling-stat\n`);
      reply.raw.write(`data: ${JSON.stringify(stat)}\n\n`);
      return;
    }

    const stats = await getToolingStats();
    reply.raw.write(`event: tooling-stats\n`);
    reply.raw.write(`data: ${JSON.stringify(stats)}\n\n`);
  };

  await push();
  const interval = setInterval(() => {
    push().catch(() => undefined);
  }, 5000);

  reply.raw.on("close", () => clearInterval(interval));
});

app.get<{ Params: AgentLogParams; Querystring: AgentLogQuery }>(
  "/api/modules/hermes-fleet/agents/:agentId/log",
  async (req, reply) => {
    const result = getAgentLogTail(req.params.agentId, parseLines(req.query.lines));
    if ("error" in result) return reply.status(result.statusCode).send({ error: result.error });
    return result;
  }
);

app.get("/api/modules/hermes-fleet/stream", async (_req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    Connection: "keep-alive"
  });

  const push = async () => {
    const snap = await getFleetSnapshot();
    reply.raw.write(`event: snapshot\n`);
    reply.raw.write(`data: ${JSON.stringify(snap)}\n\n`);
  };

  await push();
  const interval = setInterval(() => {
    push().catch(() => undefined);
  }, 5000);

  reply.raw.on("close", () => clearInterval(interval));
});

app.post<{ Body: ActionRequestBody }>(
  "/api/modules/hermes-fleet/actions/restart-gateways",
  async (req, reply) => {
    const target = parseActionTarget(req.body);
    if ("error" in target) return reply.status(400).send({ error: target.error });
    return restartGateways(target.agentIds);
  }
);

app.post<{ Body: ActionRequestBody }>(
  "/api/modules/hermes-fleet/actions/sync-template-defaults",
  async (req, reply) => {
    const target = parseActionTarget(req.body);
    if ("error" in target) return reply.status(400).send({ error: target.error });
    return syncTemplateDefaults(target.agentIds);
  }
);

// Per-service manual control: start | stop | restart one of an agent's units
// (gateway | consumer | sentinel | checkpoint).
app.post<{ Params: { agentId: string; service: string; action: string } }>(
  "/api/modules/hermes-fleet/agents/:agentId/services/:service/:action",
  async (req, reply) => {
    const { agentId, service, action } = req.params;
    const result = await controlAgentUnit(agentId, service, action);
    if (!result.ok) return reply.status(400).send(result);
    return result;
  }
);

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "0.0.0.0";

startToolingCollectors(app.log);

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
