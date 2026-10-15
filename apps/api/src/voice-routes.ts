import type { FastifyInstance } from "fastify";
import type { EventCollector } from "./event-collector.js";
import {
  AGENT_TYPES,
  MEMO_TYPES,
  buildMemoDetail,
  buildMemoSummaries,
  groupByMemo,
  toJourneyEvent,
  type JourneyEvent
} from "./voice-memos.js";
import { readWatcherStatus } from "./watcher-status.js";

const UUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const events = (rows: { cursor: number; collected_at: string; envelope: unknown }[]) =>
  rows.map(toJourneyEvent).filter((e): e is JourneyEvent => e !== undefined);

/**
 * The Voice memos view. Read-only over the shared Bloodbank collection: memo stage facts are grouped
 * by correlation id, and the gateway's agent facts join on the same id. Nothing here publishes.
 */
export function registerVoiceRoutes(app: FastifyInstance, collector: EventCollector) {
  const store = collector.store;
  const source = () => {
    const s = collector.status();
    return { state: s.state, lastEventAt: s.last_event_at, catchingUp: s.catching_up, error: s.error };
  };

  app.get<{ Querystring: { limit?: number } }>("/api/modules/voice/memos", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } } }
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const limit = req.query.limit ?? 25, now = Date.now();
    const facts = events(store.recent([...MEMO_TYPES], 1500));
    // Newest memos first; their stage facts are all in the window because they are recent.
    const newest = [...groupByMemo(facts).entries()]
      .sort((a, b) => Math.min(...b[1].map(e => e.cursor)) - Math.min(...a[1].map(e => e.cursor)))
      .slice(0, limit);
    // Agent facts are only needed while a memo is still waiting on the agent or the reply.
    const open = newest.filter(([, list]) => list.some(e => e.type.endsWith(".dispatched")) && !list.some(e => e.type.endsWith(".replied")));
    const agentFacts = open.length
      ? events(store.correlated([...AGENT_TYPES], open.map(([id]) => id), Math.min(...open.map(([, list]) => Math.min(...list.map(e => e.cursor))))))
      : [];
    const memos = buildMemoSummaries([...newest.flatMap(([, list]) => list), ...agentFacts], now, limit);
    return { generated_at: new Date(now).toISOString(), source: source(), watcher: await readWatcherStatus(now), memos };
  });

  app.get<{ Params: { memoId: string } }>("/api/modules/voice/memos/:memoId", {
    schema: { params: { type: "object", required: ["memoId"], properties: { memoId: { type: "string", pattern: UUID } } } }
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const memoId = req.params.memoId.toLowerCase(), now = Date.now();
    const facts = events(store.correlated([...MEMO_TYPES], [memoId]));
    if (!facts.length) return reply.code(404).send({ error: "No voice memo facts with that correlation id are in the event collection." });
    const agentFacts = events(store.correlated([...AGENT_TYPES], [memoId], Math.min(...facts.map(e => e.cursor))));
    const memo = buildMemoDetail(memoId, [...facts, ...agentFacts], now);
    return { generated_at: new Date(now).toISOString(), source: source(), watcher: await readWatcherStatus(now), memo };
  });
}
