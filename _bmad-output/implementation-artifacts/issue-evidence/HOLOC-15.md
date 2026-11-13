# Evidence: HOLOC-15 — Agent Pad: use Telegram avatars with project-logo fallbacks

## Issue
- Ticket: HOLOC-15
- Milestone / horizon: n/a
- Worker: Hermes delegated implementer subagent (automaticai/auto) this pass; full pipeline built across earlier HOLOC-15 passes (commits 1ab5c4c, eabfa96, 67d286f, e40ed8e, 807bef6, 49fb8d5)
- Orchestrated by: holocene-pm (Hermes PM)

## Acceptance Criteria
1. Agent tiles render each agent's real Telegram profile photo via the live roster (letter-initial tiles gone).
2. Agents whose bot has no Telegram photo wear current project branding (9 traced logos) or operator-authorized generated marks (8); zero letter-only tiles, zero broken images.
3. Image load failures fall back safely (letter tile + 15s/60s/240s retry backoff); names, selection, recording-disabled state, touch targets, car 1280x720 and phone layouts preserved.
4. No bot tokens or op:// references in client assets, served roster, logs, or commits.
5. Checks green plus independent adversarial review verdict PASS verified against live production.

## Repo Changes
- Branch: main (base c937b45; pipeline head 49fb8d5; this pass adds the dev-proxy fix below)
- Files changed (this pass):
  - `apps/agent-pad/vite.config.ts` — dev-only `/roster` proxy now blanks referer/origin headers; the forwarded Referer previously tripped Cloudflare hotlink protection (403 on every avatar in dev; prod same-origin unaffected)
- Migrations / schema: none

## Verification
- Commands executed and results:
  - `cd apps/agent-pad && npx tsc --noEmit` → clean
  - `cd apps/agent-pad && node --test src/*.test.ts` → 32 pass / 0 fail (incl. avatar allowlist + retry-backoff cases)
  - `cd apps/agent-pad && npx vite build` → green (dist/assets/index-Co507Jdj.js 256.57 kB)
  - `cd services/pad-roster && python3 -m pytest -q` → 9 passed
  - Secrets sweep of src/dist/config/html + pad-roster + live roster.json → 0 matches for op://, bot-token patterns, TELEGRAM_BOT_TOKEN
- AC → evidence mapping:
  - AC1 → live roster.json: 28 agents, 28 non-empty avatar URLs; headless Chrome on https://agent-pad.delo.sh measured picSwatches=28, imgsLoaded=28, letterSwatches=0 (reviewer screenshot: agents/hermes/pm/runtime/workers/HOLOC-15/shots/review-live.png)
  - AC2 → 9 project logos traced per hermes-project-avatar (branding-results.json), 8 generated marks uploaded via holocene.delo.sh/settings; zero letter tiles observed live
  - AC3 → Swatch onError path falls back to letter tile with retry backoff; covered by node tests; no UI/layout code changed this pass
  - AC4 → secrets sweep zero matches; reviewer independently re-swept
  - AC5 → independent reviewer (fresh Hermes subagent, automaticai/auto; distinct spawn from implementer) verdict PASS, 11/11 checks, 0 discrepancies; verdicts at agents/hermes/pm/runtime/workers/HOLOC-15/{review.md,review-verdict.json}
- Production state: avatar serving is live and verified (roster + avatar files + rendered pad); the dev-proxy fix produces no production artifact, so no deploy is required for it.

## Ledger Update
- Bloodbank decision/events emitted: decision a2665802-9b65-4b8c-8dbc-1e00c9a6642d (start), plus accept/close decision in bloodbank-events.jsonl
- Ledger updated: yes

## Known Gaps
- Aesthetic confirmation remains an operator choice for the 8 generated marks (replace anytime at holocene.delo.sh/settings); functional coverage is complete
- delonet-director and delonet-company-reporter share one generated mark (same project); flagged to operator as a question, not a defect

## Close Recommendation
- Close recommendation: ready
- Rationale: live production verified zero letter tiles with 28/28 avatars; independent adversarial review PASS with zero discrepancies; all checks green.
