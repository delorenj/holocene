import type { FastifyReply } from "fastify";
import type { SSEMessage } from "@fastify/sse";

/** Bound slow clients; replay comes from the collection, never an unbounded per-client queue. */
export async function sendEvent(reply: FastifyReply, message: SSEMessage) {
  if (!reply.sse.isConnected) throw new Error("stream_closed");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reply.sse.send(message),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("stream_backpressure_timeout")), 10000);
        timeout.unref();
      }),
    ]);
  } finally { clearTimeout(timeout); }
}

export function streamHeaders(reply: FastifyReply) {
  reply.header("Cache-Control", "no-cache, no-transform");
  reply.header("X-Accel-Buffering", "no");
}
