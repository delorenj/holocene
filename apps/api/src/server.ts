import Fastify from "fastify";
import {
  controlAgentUnit,
  getAgentLogTail,
  getFleetSnapshot,
  restartGateways,
  syncTemplateDefaults
} from "./fleet.js";

const app = Fastify({ logger: true });

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

app.get("/api/modules/hermes-fleet/snapshot", async () => getFleetSnapshot());

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

app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
