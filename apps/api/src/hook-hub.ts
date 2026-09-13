import type { FastifyInstance } from "fastify";

const DEFAULT_HUB_URL = "http://127.0.0.1:8685";
const FILTERS = ["cli", "native", "role", "handler", "status", "limit", "offset"] as const;

export type HookHubOptions = {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

/** A bounded, read-only bridge to the host's canonical hook receipts. */
export function registerHookHubRoutes(app: FastifyInstance, options: HookHubOptions = {}) {
  const baseUrl = (options.baseUrl ?? process.env.HOOK_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/$/, "");
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 4000;

  async function read(path: string) {
    const response = await request(`${baseUrl}/v1/hooks/${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      if (response.status === 404) return { status: 404, body: { error: "Hook invocation was not found." } };
      throw new Error(`Hook hub returned HTTP ${response.status}.`);
    }
    return { status: 200, body: await response.json() };
  }

  async function serve(path: string, reply: { code: (status: number) => unknown; header: (name: string, value: string) => unknown }) {
    reply.header("Cache-Control", "no-store");
    try {
      const result = await read(path);
      reply.code(result.status);
      return result.body;
    } catch (error) {
      app.log.warn({ err: error }, "Hook hub observability is unavailable");
      reply.code(503);
      return {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        available: false,
        error: "The hook hub is unavailable. Execution history cannot be refreshed. Retry when the hub is running.",
      };
    }
  }

  app.get("/api/modules/hooks/status", async (_request, reply) => serve("status", reply));

  app.get<{ Querystring: Partial<Record<(typeof FILTERS)[number], string>> }>(
    "/api/modules/hooks/invocations",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(FILTERS.map((key) => [key,
            key === "limit" ? { type: "integer", minimum: 1, maximum: 200 } :
            key === "offset" ? { type: "integer", minimum: 0, maximum: 100000 } :
            { type: "string", maxLength: 160 },
          ])),
        },
      },
    },
    async (req, reply) => {
      const query = new URLSearchParams();
      for (const key of FILTERS) {
        const value = req.query[key];
        if (value !== undefined && value !== "") query.set(key, String(value));
      }
      if (!query.has("limit")) query.set("limit", "50");
      return serve(`invocations?${query}`, reply);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/modules/hooks/invocations/:id",
    { schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,160}$" } } } } },
    async (req, reply) => serve(`invocations/${encodeURIComponent(req.params.id)}`, reply),
  );
}
