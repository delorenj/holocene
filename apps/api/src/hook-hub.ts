import type { FastifyInstance } from "fastify";
import type { EventCollector } from "./event-collector.js";
import type { HookFilter } from "./event-store.js";
import { sendEvent, streamHeaders } from "./event-stream.js";

const FILTERS = ["cli", "native", "role", "handler", "status", "limit", "offset"] as const;
const querystring = {
  type: "object", additionalProperties: false,
  properties: Object.fromEntries(FILTERS.map(key => [key,
    key === "limit" ? { type: "integer", minimum: 1, maximum: 200 } :
    key === "offset" ? { type: "integer", minimum: 0, maximum: 100000 } : { type: "string", maxLength: 160 },
  ])),
};

/** Hooks are one view over collected Bloodbank facts. No producer service is queried here. */
export function registerHookHubRoutes(app: FastifyInstance, collector: EventCollector) {
  const streams = new Set<() => void>();
  app.addHook("preClose", async () => { for (const close of streams) close(); });
  app.get("/api/modules/hooks/status", async (_req, reply) => {
    reply.header("Cache-Control", "no-store"); return collector.hookSnapshot();
  });
  app.get<{ Querystring: HookFilter }>("/api/modules/hooks/invocations", { schema: { querystring } }, async (req, reply) => {
    reply.header("Cache-Control", "no-store"); return collector.store.hookHistory(req.query);
  });
  app.get<{ Params: { id: string } }>("/api/modules/hooks/invocations/:id", {
    schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,160}$" } } } },
  }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const invocation = collector.store.hookDetail(req.params.id);
    return invocation ? { invocation } : reply.code(404).send({ error: "Hook invocation was not found in the event collection." });
  });
  app.get<{ Querystring: HookFilter }>("/api/modules/hooks/stream", { sse: "only", schema: { querystring } }, async (req, reply) => {
    streamHeaders(reply);
    let closed = false, pumping = false, needsStatus = true, needsHistory = true;
    let queued: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = collector.subscribe(change => {
      if (change.kind === "receipt") needsHistory = true;
      if (change.kind === "snapshot" || change.kind === "status") needsStatus = true;
      if ((needsHistory || needsStatus) && !queued && !pumping) {
        // Coalesce bursts of handler transitions, without a polling refresh loop.
        queued = setTimeout(() => { queued = undefined; void pump(); }, 20);
      }
    });
    const cleanup = () => { if (closed) return; closed = true; clearTimeout(queued); unsubscribe(); streams.delete(close); };
    const close = () => { cleanup(); reply.sse.close(); };
    reply.sse.onClose(cleanup); reply.sse.keepAlive(); streams.add(close);
    async function pump() {
      if (closed || pumping) return;
      pumping = true;
      try {
        while ((needsStatus || needsHistory) && !closed) {
          // Capture both projections synchronously at one cursor before any write yields.
          const cursor = collector.store.cursor;
          const status = needsStatus ? collector.hookSnapshot() : null;
          const history = needsHistory ? collector.store.hookHistory(req.query) : null;
          needsStatus = false; needsHistory = false;
          if (status) await sendEvent(reply, { event: "hooks-status", id: String(cursor), data: status });
          if (history) await sendEvent(reply, { event: "hooks-history", id: String(cursor), data: history });
        }
      } catch { close(); }
      finally { pumping = false; }
    }
    // Projection streams resnapshot on reconnect, including filter changes and row removals.
    // The generic /api/events/stream provides exact envelope replay by cursor.
    await pump();
  });
}
