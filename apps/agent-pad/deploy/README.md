# HOLOC-29 same-origin pad activity

The public pad must expose **only** `GET /api/pad/activity`. This API allowlist
uses the same cached hub model as Holocene, filtered to registry-declared memo
routes (the `memo_common.registry_route` capability rule). It returns:

- `generatedAt` from the hub snapshot;
- `sources`: only `name`, `ageSeconds`, `maxSeconds`, `down` for the required sources;
- `agents`: only `id`, `signal`, and nullable `lastWorkAt`.

No evidence, cwd/filesystem paths, projects, tickets, contractors, invocation
context, avatar metadata, source values/errors, or nonroutable identities belong
in this response. **Never proxy `/api/modules/hub/agents` onto the public pad.**
That full response remains behind Holocene's existing OIDC boundary. The pad
continues to use its separate routable roster for names, avatars, and memo targets.
`lastWorkAt` uses the hub's observed event, invocation, and ASM state-change
recency, never provision time or operator contact; the existing `lastActiveAt`
provision fallback remains unchanged for other hub clients. Unknown work is null.
The finite event window/invocation cap still applies; this is not all-time history.

## Deployment handoff (not performed on this candidate branch)

Include `hub-agents.nginx.conf` **inside** the existing `server` block in
`/home/delorenj/docker/stacks/websites/agent-pad/nginx.conf`. Preserve `/upload`,
`/roster`, avatars, and SPA locations. The snippet's only upstream is the narrow
pad path; it strips credentials and disables caching. Do not use the public
`holocene.delo.sh` hostname as upstream (OIDC redirects would not produce JSON).
The configured `172.19.0.1:4000` is the current Docker `proxy` network host gateway;
verify it with `docker inspect agent-pad-web --format '{{json .NetworkSettings.Networks}}'`
and the API bind interface with `ss -ltn '( sport = :4000 )'` before installation.

The parent must integrate and build/restart the API before enabling this route,
build the canonical pad checkout's mounted `dist`, validate nginx with
`docker exec agent-pad-web nginx -t`, and reload it. No running service or external
configuration was changed during candidate repair.

Verify `curl -i https://agent-pad.delo.sh/api/pad/activity`: JSON, `no-store`, the
exact allowlist above, and routable IDs only. Verify the full hub path is **not**
proxied publicly, including on failures. Client polling is 3 s, snapshot TTL 8 s,
and required-source freshness is bounded independently. Failure/offline clears
thinking; membership and selected ID remain available from the roster cache.

## Visibility / motion contract

Activity reorders never scroll back to a saved/far-down selection. Only explicit
tile/wheel selection scrolls. Parked tiles remain scrollable; off-screen counts
are measured from the actual clipped thinking-label viewport (including user
scroll), not merely which agents are rendered. The fixed fleet line reports all
thinking agents and how many cues are off-screen.

Driving uses the same compact, scrollable grid and record toggle as parked, without
an oversized header or arbitrary five-tile cap. The full roster stays available
unless the host supplies `maxItems`; a host `maxLabel` limits all displayed labels
and statuses. Selected and reply targets retain slots when a host cap is present
(one slot: selected wins). Every visible thinking label pulses independently until
its own state settles. **Only** the thinking label overrides driving's `.still`
animation ban: reply bounce, record dot, meter, and transitions stay disabled.
Reduced-motion retains the same static labelled “Thinking” cue. A non-driving
`noVideo` restriction still disables all animation.

## Local regression checks

From the repository root:

```
pnpm --filter @holocene/api test
npm --prefix apps/agent-pad test
npx --prefix apps/agent-pad tsc -p apps/agent-pad/tsconfig.json --noEmit
pnpm --filter @holocene/api typecheck
pnpm --filter @holocene/web typecheck
pnpm --filter @holocene/api build
pnpm --filter @holocene/web build
```

Build the standalone pad with `npx vite build --configLoader runner` from
`apps/agent-pad` (or `node -e "import('vite').then(v => v.build({configLoader:'runner'}))"`
when the shell runner mistakes the bounded CLI build for a dev server). The browser
regression uses that built `dist`, a loopback-only
test server, deterministic intercepted responses, and no production requests:

```
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
CHROMIUM_PATH=/absolute/path/to/non-snap/chromium node apps/agent-pad/tests/activity.browser.mjs
```

On this host, Snap Chromium cannot create a profile under Hermes' hidden scratch
path. Use a standalone Playwright Chromium/headless-shell binary with its browser
cache and temporary profile under the active profile's scratch directory; do not
move test state into another Hermes profile or the system temp directory.

It checks saved selection plus three workers in a 400 px parked tile viewport,
no reorder scrolling after explicit selection, truthful scroll/host overflow,
concurrent driving pulse, independent settle, reduced motion, and the unchanged
non-driving noVideo ban. This is a browser regression, not an Android-host/live
verification; the parent still owns that acceptance check.
