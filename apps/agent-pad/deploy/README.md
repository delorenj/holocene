# HOLOC-29 same-origin read projection

Deployment owner: include the contents of `hub-agents.nginx.conf` **inside**
the existing `server` block in
`/home/delorenj/docker/stacks/websites/agent-pad/nginx.conf`. Preserve all existing
locations, especially `/upload` and `/roster`. No browser CORS or credentials are
required; this forwards only the canonical read projection. **Do not proxy the
public `holocene.delo.sh` hostname:** its OIDC middleware redirects anonymous
requests to Google, so the pad would receive no JSON. The snippet reaches the
Holocene API systemd service on port 4000 through the pad container's current
Docker `proxy` network gateway (`172.19.0.1`). Before installation, verify the
gateway with `docker inspect agent-pad-web --format '{{json .NetworkSettings.Networks}}'`
and update the address in the snippet if the network changed. Confirm that the
API binds to a reachable interface (`ss -ltn '( sport = :4000 )'`).

From the external stack, validate with `docker exec agent-pad-web nginx -t`,
then `docker exec agent-pad-web nginx -s reload`. Build this worktree's pad with
`cd apps/agent-pad && npx vite build --configLoader runner` and have the parent integrate the source
and build the canonical checkout's mounted `dist` before production verification.
No external configuration or running service was modified by the carrier.

Verify `curl -i https://agent-pad.delo.sh/api/modules/hub/agents`: JSON (not SPA
HTML), `Cache-Control: no-store`, `generatedAt`, `sources`, and `agents`. Verify
three working agents, independent completion, offline expiry, and parked versus
driving/reduced-motion cues in the actual Auto host. Until this location ships,
the client deliberately reports “Thinking status unknown” and never guesses.

When a host permits only one tile, selected takes that slot; the existing hero
still identifies a playing reply. With two or more slots both selected and
reply are retained. Hidden working agents are counted in an always-visible
static status line; parked shows the full scrollable routable roster.
