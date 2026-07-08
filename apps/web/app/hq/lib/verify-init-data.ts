import crypto from "node:crypto";

// Server-side validation of a Telegram Mini App `initData` string.
// Algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret_key = HMAC_SHA256(key="WebAppData", msg=<bot_token>)
//   hash       = HMAC_SHA256(key=secret_key, msg=data_check_string)
// where data_check_string is the alphabetically-sorted `key=value` pairs
// (excluding `hash` and the third-party `signature` field) joined by "\n".

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
};

export type VerifyResult =
  | { ok: true; user: TelegramUser; authDate: number }
  | { ok: false; reason: string };

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

export function verifyInitData(
  initData: string,
  botToken: string,
  opts: { allowedUserIds?: number[]; maxAgeSeconds?: number } = {}
): VerifyResult {
  if (!initData) return { ok: false, reason: "missing initData" };
  if (!botToken) return { ok: false, reason: "server missing bot token" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "malformed initData" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash" || key === "signature") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }

  const authDate = Number(params.get("auth_date") ?? 0);
  const maxAge = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const nowSec = Math.floor(Date.now() / 1000);
  if (!authDate || nowSec - authDate > maxAge) {
    return { ok: false, reason: "expired initData" };
  }

  const userRaw = params.get("user");
  let user: TelegramUser | undefined;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramUser;
    } catch {
      return { ok: false, reason: "malformed user" };
    }
  }
  if (!user?.id) return { ok: false, reason: "missing user" };

  if (opts.allowedUserIds && opts.allowedUserIds.length > 0 && !opts.allowedUserIds.includes(user.id)) {
    return { ok: false, reason: "user not allowed" };
  }

  return { ok: true, user, authDate };
}
