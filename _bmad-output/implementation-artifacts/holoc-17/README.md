# HOLOC-17 Holocene Mini

DeloHQ is now **Holocene Mini**: one UI (`apps/web/app/hq/hq-client.tsx`, `MiniApp({mode})`) served two ways.

| Where | Mode | Auth |
|---|---|---|
| `https://holocene.delo.sh/hq` (bot menu button) | telegram | Telegram initData on every call, verified by `/hq/api/*` (unchanged `verify-init-data.ts`); /hq stays outside Google auth |
| `https://holocene.delo.sh/mini` | browser | existing Google auth; calls `/api/modules/org/tree` and `/api/modules/hermes-fleet/*` like the hub |

Bot (via Bot API): name "Holocene Mini", short description, menu button "Holocene Mini" (default and operator chat).
BotFather-only, not done: username stays @DeLoHQBot; Main Mini App unset (`has_main_web_app=false`).

No recorder: Mini App microphone support is undocumented and was not verified on a device. A recorder needs an
on-device mic check first. Agent rows open the agent's Telegram DM (Telegram's own mic records).

Checks: `mise run mini:smoke` (11 checks against prod: signed 200, tampered/missing/stale 401 with reasons, unsigned
control action 401, path pin 400, /hq open, /mini + /api + control route gated by Google auth).

Reviews (`reviews.json`): SPEC PASS_WITH_NOTES, QUALITY PASS_WITH_NOTES. Fixed after review (commit after ff92055):
expired Google session (forward-auth answers fetch with 401) now shows the sign-in banner instead of a circular
"open from Telegram" message; a 503 in browser mode is a fleet error, not "set TELEGRAM_HQ_BOT_TOKEN"; the dialect
guard scans `apps/web/app/mini`; the smoke asserts reason strings, the unsigned control action and the Google redirect.
