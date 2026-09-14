import type { FastifyInstance } from "fastify";
import fastifySSE from "@fastify/sse";
import type { EventCollector } from "./event-collector.js";
import type { EventFilter } from "./event-store.js";
import { sendEvent, streamHeaders } from "./event-stream.js";

const properties = {
  type: { type: "string", maxLength: 200 }, subject: { type: "string", maxLength: 200 }, source: { type: "string", maxLength: 500 },
  limit: { type: "integer", minimum: 1, maximum: 500 }, after: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
};
export async function registerEventRoutes(app: FastifyInstance, collector: EventCollector) {
  await app.register(fastifySSE, { heartbeatInterval: 15000 });
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); });
  app.addHook("onClose", async () => { await collector.stop(); collector.store.close(); });
  app.get("/api/events/status", async (_req, reply) => { reply.header("Cache-Control", "no-store"); return collector.status(); });
  app.get<{ Querystring: EventFilter }>("/api/events", { schema: { querystring: { type: "object", additionalProperties: false, properties } } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const items = collector.store.events(req.query);
    return { items, cursor: collector.store.cursor, next_cursor: items.at(-1)?.cursor ?? req.query.after ?? 0, collection: collector.status() };
  });
  app.get<{ Querystring: EventFilter }>("/api/events/stream", {
    sse: "only", schema: { querystring: { type: "object", additionalProperties: false, properties } },
  }, async (req, reply) => {
    streamHeaders(reply);
    const raw = reply.sse.lastEventId ?? (req.query.after !== undefined ? String(req.query.after) : null);
    if (raw !== null && !/^\d{1,16}$/.test(raw)) return reply.code(400).send({ error: "invalid_cursor" });
    let cursor = raw === null ? collector.store.cursor : Number(raw);
    if (!Number.isSafeInteger(cursor)) return reply.code(400).send({ error: "invalid_cursor" });
    if (cursor > collector.store.cursor || (cursor > 0 && collector.store.oldestCursor > cursor + 1)) {
      await sendEvent(reply, { event: "reset", data: { reason: "cursor_unavailable", cursor: collector.store.cursor, history: "/api/events" } });
      return;
    }
    let closed = false, pumping = true, dirty = true;
    const unsubscribe = collector.subscribe(() => { dirty = true; void pump(); });
    const cleanup = () => { if (closed) return; closed = true; unsubscribe(); streams.delete(close); };
    const close = () => { cleanup(); reply.sse.close(); };
    reply.sse.onClose(cleanup); streams.add(close); reply.sse.keepAlive();
    async function pump() {
      if (closed || pumping) return;
      pumping = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const rows = collector.store.events({ ...req.query, after: cursor, limit: 100 });
          if (!rows.length) { cursor = collector.store.cursor; break; }
          for (const row of rows) {
            await sendEvent(reply, { id: String(row.cursor), event: "bloodbank-event", data: row });
            cursor = row.cursor;
          }
          dirty = true;
        }
      } catch { close(); }
      finally { pumping = false; }
    }
    await sendEvent(reply, { event: "ready", data: { cursor, collection: collector.status() } }).catch(close);
    pumping = false;
    await pump();
  });
}
