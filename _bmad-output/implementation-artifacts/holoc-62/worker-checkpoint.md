# HOLOC-62 local-only candidate checkpoint

Branch `holoc-62-projects-launch-local` in `.worktrees/holoc-62-projects-launch-local`, based on `018b775aa2d800946c9a20994540b354f7451c78`. No push, merge, deployment, live restart, Plane mutation, or lifecycle declaration change. The shared main checkout's unrelated `bloodbank-events.jsonl` modification is untouched.

## Candidate behavior

- One expandable **Projects** navigation parent exposes **Live products**, **Launch mode products**, and separately named **All projects** (original inventory/deep links). **Products** remains a bookmark; **Live management** remains `/live`. The subset routes still use `/products?stage=live|launch`.
- `/api/modules/products` still classifies registered projects using committed `.launch.yaml` only and excludes steady projects. Missing declarations appear under source issues; missing receipts and scripts do not remove launch entries. Project identity is unchanged upon transition to live.
- Existing bounded, no-follow PM publication receipt reader supplies the dashboard locator and already-published launch `items`/`requirements`. The projection allowlists open action and owner-gate counts, a next step, and the **oldest recorded** verification time. Unknown or incomplete observations are labelled unknown, old observations stale, and publication time is explicitly not gate freshness. No reader invokes a script or mutates a ledger. A publication receipt is not proof of readiness.
- Counts and source status are advisory; readiness is never green. Missing/invalid publication never creates an action URL. Destination HTTPS allowlist and edge-owned auth remain unchanged.

## Executed checks (worker, not independent review)

- `pnpm --filter @holocene/api typecheck`: exit 0 after final API change.
- `pnpm --filter @holocene/web typecheck`: exit 0 after final web change.
- `pnpm --filter @holocene/api test`: exit 0, 335 pass / 0 fail (before final narrowly scoped oldest-observation fix); targeted `pnpm --filter @holocene/api exec tsx --test src/products-model.test.ts src/products.test.ts`: exit 0, 13 pass / 0 fail after that fix.
- `pnpm --filter @holocene/web test`: exit 0, 86 pass / 0 fail (before final product-only rendering copy change). Optimized `next build`: exit 0 after final web change.
- `pnpm --filter @holocene/web test:products-browser` against optimized `next start`: exit 0, 3 pass / 0 fail after final changes. Actual Chromium pages at 1440, 390, 320 widths, both themes, keyboard Projects toggle and drawer, focus/escape, all three real published dashboards (title/body checked, no login redirect), Earshot `/live`, history and native modified project links, unknown/stale/missing receipt fixtures. See `browser/real-navigation.json` and corresponding screenshots (`products-*`, `drawer-*`, `dashboard-*`, `earshot-live-*`, `fixture-unavailable-320.png`). Test fixture is not a real destination check.
- Candidate GET `http://127.0.0.1:3162/api/modules/products` returned registry `ok`, launch IDs `greeninbetween`, `gruvato`, `tolt`; live `earshot`; three launch states `unknown`, with owner-blocker/open-action counts but incomplete verified gate observations. This is the candidate adapter, not authenticated public serving.

## Reviewer handoff

- Candidate frontend `http://127.0.0.1:3162/products`, API adapter `http://127.0.0.1:4162/api/modules/products`; both bind loopback only. Adapter runs actual candidate product projection, forwarding only existing operational Live and hub GETs to API 4000. It does **not** start collectors or workflows.
- Start if needed from worktree root: `pnpm --filter @holocene/api exec tsx ../../_bmad-output/implementation-artifacts/holoc-62/workbench.mts`; then `HOLOCENE_API_INTERNAL_URL=http://127.0.0.1:4162 pnpm --filter @holocene/web exec next start --hostname 127.0.0.1 -p 3162`. Dependencies and optimized build are isolated in this worktree.
- Stop **only this candidate** via the owning process sessions (API `proc_80e9e7ce5554`, web `proc_df853856382e`) or verified loopback PIDs; never restart or stop API 4000 or deployed web.
- Independent spec/quality review and authenticated public-serving acceptance remain open. Parent owns the handback. No independent review is claimed here.
