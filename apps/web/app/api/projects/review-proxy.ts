import { createHash, createHmac } from "node:crypto";

// HOLOC-70: the one signed hop from the authenticated Holocene router to the review API.
// The edge (Traefik google-auth) sets X-Forwarded-User to the signed-in email on every request
// that reaches holocene-web; this proxy is the only place that turns it into a review author.
// Unlike the catalog's read signature, each request is bound to its method, path, body and author.

export const BODY_LIMIT = 64 * 1024;
const USER = /^[^\s@<>"]{1,128}@[^\s@<>"]{1,125}$/;
const SEGMENT = /^[A-Za-z0-9._~%-]{1,300}$/;
const ROUTE = [/^[^/]+\/home$/, /^[^/]+\/revisions$/, /^[^/]+\/revisions\/[a-f0-9]{64}$/, /^[^/]+\/revisions\/[a-f0-9]{64}\/document$/,
  /^[^/]+\/revisions\/[a-f0-9]{64}\/annotations$/, /^[^/]+\/revisions\/[a-f0-9]{64}\/annotations\/[0-9a-f-]{36}$/, /^[^/]+\/revisions\/[a-f0-9]{64}\/feedback$/];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export function signReview(secret: string, method: string, pathAndQuery: string, body: string, user: string, timestamp: string) {
  const key = createHmac("sha256", secret).update("holocene-reviews/v1").digest();
  return createHmac("sha256", key).update([method.toUpperCase(), pathAndQuery, sha256(body), user, timestamp].join("\n")).digest("hex");
}

/** Same-origin mutation check: a sandboxed frame (origin "null") or another site cannot pass. */
export function mutationAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (!origin || !host || origin !== `${proto}://${host}`) return false;
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json"
    || request.method === "DELETE";
}

export async function proxyReview(request: Request, segments: string[]) {
  const json = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "private, no-store" } });
  const secret = process.env.TELEGRAM_HQ_BOT_TOKEN;
  if (!secret) return json(503, "Reviews unavailable");
  const user = (request.headers.get("x-forwarded-user") ?? "").trim().toLowerCase();
  if (!USER.test(user)) return json(401, "Sign in to review");
  // Segments arrive decoded; re-encode each once so the API sees the canonical single encoding.
  if (!segments.length || segments.length > 6) return json(404, "Not found");
  const encoded = segments.map((s) => encodeURIComponent(s));
  if (!encoded.every((s) => SEGMENT.test(s))) return json(400, "Malformed path");
  const rest = encoded.join("/");
  if (!ROUTE.some((r) => r.test(rest))) return json(404, "Not found");
  const method = request.method.toUpperCase();
  let body = "";
  if (method !== "GET") {
    if (!mutationAllowed(request)) return json(403, "Cross-origin review mutation refused");
    if (method !== "DELETE") {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > BODY_LIMIT) return json(413, "Body too large");
      body = await request.text();
      if (body.length > BODY_LIMIT) return json(413, "Body too large");
      try { JSON.parse(body); } catch { return json(400, "Invalid JSON"); }
    }
  }
  const query = new URL(request.url).search;
  const pathAndQuery = `/api/modules/projects/${rest}${query}`;
  const timestamp = String(Date.now());
  const internal = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");
  try {
    const upstream = await fetch(`${internal}${pathAndQuery}`, {
      // A capture may publish up to 96 MB (publish.py has a 10-minute ceiling); never hang past it.
      method, cache: "no-store", body: body || undefined, signal: AbortSignal.timeout(11 * 60 * 1000),
      headers: { ...(body ? { "content-type": "application/json" } : {}), "x-review-user": user, "x-review-timestamp": timestamp, "x-review-signature": signReview(secret, method, pathAndQuery, body, user, timestamp) }
    });
    const headers = new Headers({ "Cache-Control": "private, no-store" });
    if (upstream.status !== 204) headers.set("Content-Type", "application/json");
    return new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers });
  } catch {
    return json(503, "Reviews unavailable");
  }
}
