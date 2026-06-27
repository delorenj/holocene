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

async function forwardClockAction(action: "in" | "out") {
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

app.post("/api/clock/in", async (_req, reply) => {
  const result = await forwardClockAction("in");
  if (!result.ok) {
    return reply.status(result.status || 502).send({
      success: false,
      error: "Upstream n8n call failed",
      upstream: result.body
    });
  }
  return reply.send(result.body);
});

app.post("/api/clock/out", async (_req, reply) => {
  const result = await forwardClockAction("out");
  if (!result.ok) {
    return reply.status(result.status || 502).send({
      success: false,
      error: "Upstream n8n call failed",
      upstream: result.body
    });
  }
  return reply.send(result.body);
});

app.get("/api/clock/state", async (_req, reply) => {
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
    return reply.status(res.status || 502).send({
      success: false,
      error: "Upstream n8n call failed",
      upstream: body
    });
  }

  return reply.send(body);
});


app.get("/api/modules/hermes-fleet/snapshot", async () => getFleetSnapshot());

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
