#!/usr/bin/env node
// Holocene Mini smoke check against a live deployment (default https://holocene.delo.sh).
//
// Telegram side (/hq): signs initData exactly as Telegram does (HMAC-SHA256 with the bot token, the scheme
// apps/web/app/hq/lib/verify-init-data.ts verifies) and asserts signed -> 200, tampered -> 401, missing -> 401,
// stale (>24 h) -> 401. Browser side (/mini, /api/modules/org/tree): asserts Google auth still fronts them (307)
// while /hq stays reachable without it. The bot token and operator id are read from 1Password at run time and never
// printed. Exit code 0 only when every check passes.
//
// usage: node apps/web/tools/mini-smoke.mjs [base-url]
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";

const base = (process.argv[2] ?? "https://holocene.delo.sh").replace(/\/$/, "");
const op = (ref) => execFileSync("op", ["read", "--no-newline", ref], { encoding: "utf8" }).trim();
const token = process.env.TELEGRAM_HQ_BOT_TOKEN || op("op://DeLoSecrets/DeLoHQ Bot/token");
const operatorId = Number(process.env.HQ_OPERATOR_TELEGRAM_ID || op("op://DeLoSecrets/Telegram/id"));

export function signInitData(botToken, fields) {
  const params = new URLSearchParams(fields);
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: operatorId, first_name: "smoke" });
const signed = signInitData(token, { auth_date: String(now), query_id: "mini-smoke", user });
const stale = signInitData(token, { auth_date: String(now - 25 * 3600), query_id: "mini-smoke", user });
const tampered = signed.replace("smoke", "smokf");

const results = [];
async function check(name, url, init, expect, { reason, google } = {}) {
  const res = await fetch(url, { redirect: "manual", ...init });
  const want = [expect].flat();
  let ok = want.includes(res.status);
  let extra = "";
  if (ok && reason) {
    const got = (await res.clone().json().catch(() => ({})))?.reason;
    ok = got === reason;
    extra = ` reason=${got}`;
  }
  if (ok && google && res.status !== 401) {
    // a redirect must point at Google, not just anywhere
    ok = (res.headers.get("location") ?? "").includes("accounts.google.com");
    extra = ` -> ${(res.headers.get("location") ?? "").slice(0, 40)}`;
  }
  results.push(ok);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${res.status}${extra} (want ${want.join(" or ")}${reason ? ` reason=${reason}` : ""})`);
  return res;
}
// Google auth answers a browser with a 307 to accounts.google.com and a script (no cookie, fetch) with 401.
const GATED = [302, 307, 401];

const tma = (d) => ({ headers: { authorization: `tma ${d}` } });
const tree = await check("signed initData -> org tree", `${base}/hq/api/org-tree`, tma(signed), 200);
if (tree.status === 200) {
  const body = await tree.json();
  const n = body?.totals?.agents;
  const good = typeof n === "number" && n > 0;
  results.push(good);
  console.log(`${good ? "ok  " : "FAIL"} org tree has agents: ${n}`);
}
await check("tampered initData", `${base}/hq/api/org-tree`, tma(tampered), 401, { reason: "bad signature" });
await check("missing initData", `${base}/hq/api/org-tree`, {}, 401, { reason: "missing initData" });
await check("stale initData (25 h)", `${base}/hq/api/org-tree`, tma(stale), 401, { reason: "expired initData" });
await check("unsigned control action refused", `${base}/hq/api/action`,
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/api/modules/hermes-fleet/agents/none/services/gateway/stop" }) }, 401);
await check("action proxy refuses a path outside hermes-fleet", `${base}/hq/api/action?path=${encodeURIComponent("/api/modules/avatars")}`, tma(signed), 400);
await check("/hq page loads without Google auth (Telegram WebView)", `${base}/hq`, {}, 200);
await check("/mini is behind Google auth", `${base}/mini`, {}, GATED, { google: true });
await check("/api/modules/org/tree is behind Google auth", `${base}/api/modules/org/tree`, {}, GATED, { google: true });
await check("browser-mode control route is behind Google auth", `${base}/api/modules/hermes-fleet/agents/none/services/gateway/stop`,
  { method: "POST" }, GATED, { google: true });

const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
