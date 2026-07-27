import { verifyInitData } from "../../lib/verify-init-data";

// initData-gated control proxy for the DeloHQ Mini App. The /hq surface is
// served through the Traefik carve-out with NO google-auth, so this handler is
// the sole access control for state-changing fleet actions: it validates the
// Telegram initData (HMAC + auth_date freshness + operator allowlist) and only
// then forwards to the internal Holocene API. The forwarded path is pinned to
// the hermes-fleet module namespace so a valid operator still can't reach
// arbitrary internal endpoints.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const apiInternalUrl = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");
const botToken = process.env.TELEGRAM_HQ_BOT_TOKEN ?? "";
const allowedUserIds = (process.env.HQ_OPERATOR_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const ALLOWED_PREFIX = "/api/modules/hermes-fleet/";

function initDataFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("tma ")) return auth.slice(4).trim();
  return request.headers.get("x-telegram-init-data") ?? "";
}

function notConfigured() {
  return Response.json(
    {
      ok: false,
      error: "not_configured",
      message: "TELEGRAM_HQ_BOT_TOKEN is not set on the server yet. Create @DeloHQBot and set the token."
    },
    { status: 503 }
  );
}

function authorize(request: Request): { ok: true } | { ok: false; response: Response } {
  if (!botToken) return { ok: false, response: notConfigured() };
  const result = verifyInitData(initDataFromRequest(request), botToken, { allowedUserIds });
  if (!result.ok) {
    return { ok: false, response: Response.json({ ok: false, error: "unauthorized", reason: result.reason }, { status: 401 }) };
  }
  return { ok: true };
}

function safePath(path: unknown): path is string {
  return typeof path === "string" && path.startsWith(ALLOWED_PREFIX) && !path.includes("..");
}

async function relay(upstream: Response): Promise<Response> {
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "cache-control": "no-store",
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
    }
  });
}

// POST { path, body } — forwards a control action (bridge/agent service/binding).
export async function POST(request: Request) {
  const auth = authorize(request);
  if (!auth.ok) return auth.response;

  let payload: { path?: unknown; body?: unknown };
  try {
    payload = (await request.json()) as { path?: unknown; body?: unknown };
  } catch {
    return Response.json({ ok: false, error: "bad_request", message: "Body must be JSON." }, { status: 400 });
  }
  if (!safePath(payload?.path)) {
    return Response.json({ ok: false, error: "forbidden_path", message: `path must start with ${ALLOWED_PREFIX}` }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${apiInternalUrl}${payload.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload.body ?? {}),
      cache: "no-store"
    });
    return relay(upstream);
  } catch (err) {
    return Response.json(
      { ok: false, error: "upstream_unreachable", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

// GET ?path= — read-only relay for log tails (same namespace pin).
export async function GET(request: Request) {
  const auth = authorize(request);
  if (!auth.ok) return auth.response;

  const path = new URL(request.url).searchParams.get("path");
  if (!safePath(path)) {
    return Response.json({ ok: false, error: "forbidden_path", message: `path must start with ${ALLOWED_PREFIX}` }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${apiInternalUrl}${path}`, {
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    return relay(upstream);
  } catch (err) {
    return Response.json(
      { ok: false, error: "upstream_unreachable", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
