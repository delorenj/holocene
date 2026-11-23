// Ticket-local read-only QA adapter; never imported by production services.
import Fastify from "../../../apps/api/node_modules/fastify/fastify.js";
import { getRegisteredProjects } from "../../../apps/api/src/hub.js";
import { createProductsDirectory, defaultProductsDeps, registerProductsRoutes } from "../../../apps/api/src/products.js";
const app = Fastify();
registerProductsRoutes(app, createProductsDirectory(defaultProductsDeps(getRegisteredProjects)));
for (const path of ["/api/modules/live/apps", "/api/modules/hub/agents", "/api/modules/hub/projects"]) {
  app.get(path, async (_req, reply) => {
    const response = await fetch(`http://127.0.0.1:4000${path}`, { signal: AbortSignal.timeout(30_000) });
    reply.code(response.status).header("Cache-Control", "no-store").type("application/json");
    return response.text();
  });
}
await app.listen({ port: 4162, host: "127.0.0.1" });
console.log(JSON.stringify({ cwd: process.cwd(), pid: process.pid, host: "127.0.0.1", port: 4162, mode: "candidate-products-and-read-only-existing-operations" }));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
