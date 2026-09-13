import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { registerHookHubRoutes } from "./hook-hub.js";

test("hook receipts preserve outcomes and encode bounded filters", async () => {
  const app = Fastify();
  const calls: string[] = [];
  registerHookHubRoutes(app, {
    baseUrl: "http://hub.test",
    fetch: (async (url) => {
      calls.push(String(url));
      return Response.json({ invocations: [{ invocation_id: "one", status: "timed_out" }], total: 1 });
    }) as typeof fetch,
  });
  try {
    const response = await app.inject("/api/modules/hooks/invocations?cli=codex&native=PostToolUse&status=timed_out&limit=20");
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().invocations[0].status, "timed_out");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(calls[0], "http://hub.test/v1/hooks/invocations?cli=codex&native=PostToolUse&status=timed_out&limit=20");
    assert.equal((await app.inject("/api/modules/hooks/invocations?limit=10000")).statusCode, 400);
    assert.equal(calls.length, 1);
  } finally { await app.close(); }
});

test("an unavailable hub is never presented as an empty healthy history", async () => {
  const app = Fastify();
  registerHookHubRoutes(app, { fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
  try {
    const response = await app.inject("/api/modules/hooks/status");
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().available, false);
    assert.match(response.json().error, /unavailable/);
  } finally { await app.close(); }
});

test("missing invocation and unsafe identifiers do not become fabricated receipts", async () => {
  const app = Fastify();
  registerHookHubRoutes(app, { fetch: (async () => new Response("missing", { status: 404 })) as typeof fetch });
  try {
    assert.equal((await app.inject("/api/modules/hooks/invocations/missing-id")).statusCode, 404);
    assert.equal((await app.inject("/api/modules/hooks/invocations/a%2Fb")).statusCode, 400);
  } finally { await app.close(); }
});
