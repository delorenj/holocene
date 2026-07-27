import { verifyInitData } from "../../lib/verify-init-data";

// initData-gated proxy for the DeloHQ org chart. Served under the /hq Traefik
// carve-out (no google-auth), so this handler is the sole access control: it
// validates the Telegram initData (HMAC + auth_date freshness + operator
// allowlist) before forwarding to the internal Holocene org-tree endpoint.
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
    // One-shot diagnostic (no secrets): what does the failing initData claim?
    let seen = "unparseable";
    try {
      const raw = initDataFromRequest(request);
      const p = new URLSearchParams(raw);
      let uid: unknown;
      try {
        uid = JSON.parse(p.get("user") ?? "{}")?.id;
      } catch {
        uid = "?";
      }
      const ad = Number(p.get("auth_date") ?? 0);
      const ageH = ad ? ((Date.now() / 1000 - ad) / 3600).toFixed(1) : "?";
      seen = `user.id=${uid} auth_age_h=${ageH} has_hash=${p.has("hash")} has_signature=${p.has("signature")} len=${raw.length}`;
    } catch {
      /* leave 'unparseable' */
    }
    console.warn(`[hq] org-tree unauthorized: ${result.reason} | ${seen} | allowlist=${allowedUserIds.length}`);
    return Response.json({ ok: false, error: "unauthorized", reason: result.reason }, { status: 401 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiInternalUrl}/api/modules/org/tree`, {
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
