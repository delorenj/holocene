import { createHmac } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This handler is reached through the authenticated Holocene router. Direct API access
// is denied unless the request is signed here with the existing server-only bot secret.
export async function GET(request: Request) {
  const secret = process.env.TELEGRAM_HQ_BOT_TOKEN;
  if (!secret) return Response.json({ error: "Catalog unavailable" }, { status: 503 });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret).update(`artifacts:${timestamp}`).digest("hex");
  const internal = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");
  const url = new URL(`${internal}/api/modules/artifacts/catalog`);
  url.search = new URL(request.url).search;
  try {
    const upstream = await fetch(url, { cache: "no-store", headers: { "x-artifacts-signature": signature, "x-artifacts-timestamp": timestamp } });
    return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Catalog unavailable" }, { status: 503 });
  }
}
