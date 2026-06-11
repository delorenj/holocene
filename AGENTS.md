# Holocene agent guide

## App overview

Holocene is a 33GOD control-plane dashboard that surfaces live fleet, tooling,
and pipeline health from API services, Redis-backed stats, and SSE/polling
feeds. Its UI is built around generic live data components, where specific
panels like Hook Health are just collection renderers over structured backend
payloads.

## Operating model

Holocene is the 33GOD control-plane dashboard for a single operator. There is
no separate staging lane, no dev/prod handoff, and no second human user group
to protect with release ceremony.

## Production-first rule

Treat the live Holocene deployment as the only target. When you make an
accepted change, propagate it to the production services and verify that it is
served before you call the work done.

- Do not leave finished work only in a dev server.
- Do not describe a future deployment step as completion.
- Do not create separate dev/prod branching, config, or deployment machinery
  unless the user explicitly asks for it.
- Keep local dev servers for implementation and debugging only; they are
  temporary workbenches, not the deliverable.

## Serving path

The live frontend is the `holocene-web` Docker Compose service in
`compose.yml`. It serves `https://holocene.delo.sh` through Traefik and rebuilds
the Next.js app when the container starts.

The live API is the user systemd service `holocene-api.service`. It runs
`apps/api/dist/server.js` on port `4000`.

## Change workflow

Use this workflow for normal Holocene changes:

1. Make the smallest scoped change that satisfies the request.
2. Run the relevant checks from the repo root:

   ```bash
   pnpm --filter @holocene/api typecheck
   pnpm --filter @holocene/web typecheck
   ```

3. If API code or API dependencies changed, rebuild and restart the live API:

   ```bash
   pnpm --filter @holocene/api build
   systemctl --user restart holocene-api.service
   systemctl --user status --no-pager holocene-api.service
   curl -fsS http://127.0.0.1:4000/health
   ```

4. If web code, shared packages, workspace dependencies, or `compose.yml`
   changed, restart the live web service from the repo root:

   ```bash
   docker compose up -d --force-recreate holocene-web
   docker compose ps holocene-web
   docker logs --tail 100 holocene-web
   ```

5. Verify the public route is serving the updated app:

   ```bash
   curl -fsSI https://holocene.delo.sh
   ```

For frontend work, use a browser check against the live route when the change
is visual or interactive. For API-backed UI work, verify the relevant API route
and the rendered UI.

## Repo hygiene

The working tree may contain user or runtime changes unrelated to the current
task. Do not revert unrelated files. If production propagation touches generated
artifacts such as build output or TypeScript cache files, mention that clearly
in the closeout.
