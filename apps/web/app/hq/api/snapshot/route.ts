import { verifyInitData } from "../../lib/verify-init-data";

// initData-gated proxy for the DeloHQ Mini App. Served under the /hq Traefik
// carve-out (no google-auth), so this handler is the sole access control:
// it validates the Telegram initData (HMAC + auth_date freshness + operator
// allowlist) before forwarding to the internal Holocene fleet snapshot.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const apiInternalUrl = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(/\/$/, "");
const botToken = process.env.TELEGRAM_HQ_BOT_TOKEN ?? "";
const allowedUserIds = (process.env.HQ_OPERATOR_TELEGRAM_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

function initDataFromRequest(request: Request): string {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("tma ")) return auth.slice(4).trim();
  return request.headers.get("x-telegram-init-data") ?? "";
}

export async function GET(request: Request) {
  if (!botToken) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message: "TELEGRAM_HQ_BOT_TOKEN is not set on the server yet. Create @DeloHQBot and set the token."
      },
      { status: 503 }
    );
  }

  const result = verifyInitData(initDataFromRequest(request), botToken, { allowedUserIds });
  if (!result.ok) {
    return Response.json({ ok: false, error: "unauthorized", reason: result.reason }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiInternalUrl}/api/modules/hermes-fleet/snapshot`, {
      headers: { accept: "application/json" },
      cache: "no-store"
    });
  } catch (err) {
    return Response.json(
      { ok: false, error: "upstream_unreachable", message: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      "cache-control": "no-store",
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
    }
  });
}
