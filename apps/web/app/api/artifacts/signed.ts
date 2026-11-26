import { createHmac } from "node:crypto";

// The one signed hop from the authenticated Holocene router to the artifacts API. Direct API
// access is denied unless the request is signed here with the existing server-only bot secret.
// Bodies stream through; only the headers each endpoint needs are passed on.
const PASS: Record<"catalog" | "document" | "download", string[]> = {
  catalog: [],
  document: [],
  download: ["content-disposition", "content-length", "x-content-type-options", "content-security-policy"]
};

export async function proxyArtifacts(request: Request, endpoint: "catalog" | "document" | "download") {
  const secret = process.env.TELEGRAM_HQ_BOT_TOKEN;
  if (!secret) return Response.json({ error: "Catalog unavailable" }, { status: 503 });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`artifacts:${timestamp}`).digest("hex");
  const internal = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const url = new URL(`${internal}/api/modules/artifacts/${endpoint}`);
  url.search = new URL(request.url).search;
  try {
    const upstream = await fetch(url, { cache: "no-store", headers: { "x-artifacts-signature": signature, "x-artifacts-timestamp": timestamp } });
    const headers = new Headers({ "Cache-Control": "private, no-store" });
    const json = endpoint !== "download" || !upstream.ok;
    headers.set("Content-Type", json ? "application/json" : "application/octet-stream");
    if (!json) for (const name of PASS[endpoint]) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return Response.json({ error: "Catalog unavailable" }, { status: 503 });
  }
}
