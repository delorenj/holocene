import type { FastifyInstance } from "fastify";
import type { buildPadActivity } from "./hub-model.js";

/** The only hub-derived read surface intended for the unauthenticated pad origin. */
export function registerPadActivityRoute(app: FastifyInstance, read: () => Promise<ReturnType<typeof buildPadActivity>>) {
  app.get("/api/pad/activity", { exposeHeadRoute: false }, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    try { return await read(); }
    catch { return reply.code(503).send({ error: "activity_unavailable" }); }
  });
}
