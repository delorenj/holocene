# HOLOC-57 acceptance source

Read-only capture from dispatched live ticket `c04040ad-090a-44e9-9f89-8e8279306467`, 2026-11-20. Parsed each JSONL envelope, then its `content[0]` JSON. Eight acceptance paragraphs below are verbatim text, HTML removed. Source: profile scratch `holoc57-dispatch-live.jsonl`; owning board https://plane.delo.sh/33god/browse/HOLOC-57/.

## AC1

/products has clearly labelled Preparing to launch and Live sections, working links to all three current launch dashboards, and an Earshot entry opening its existing Live management surface. The Products bookmark remains stable when a product changes lifecycle or its dashboard publication changes.

## AC2

Classification uses authoritative lifecycle declarations, not a guessed list or board lane. Reuse project discovery and existing publication receipts/configuration; missing, invalid or unavailable sources are visible and do not turn into false empty or healthy states. A launch-to-live fixture moves the same product without duplicate identity, and steady projects are not presented as launching or live.

## AC3

Stitch produces desktop and phone concepts using Holocene's current visual language and actual routes. Record screen references and a reasoned PM design decision, reconcile the chosen direction into the repo's visual and behavior contracts, and implement that direction. Do not block reversible design details on another operator sign-off or treat old unselected concepts as approved.

## AC4

Shared hierarchical navigation replaces the expanding primary tab strip, gives Products a major position, and offers its launch/live subsets. Existing hub destinations remain reachable, current location and parent group are clear, and old direct links including /live, /?view=agents, /?view=projects and focus parameters still work with back/forward and modified-link behavior preserved.

## AC5

Desktop and narrow-phone layouts remain usable without horizontal page overflow. Keyboard-only traversal, visible focus, current-page semantics and accessible group controls work; any mobile drawer supports Escape and focus return. Preserve day/night themes and reduced motion. Do not require every legacy page to be visually redesigned.

## AC6

Add focused automated coverage for lifecycle discovery, dashboard link resolution, unavailable sources, route preservation and navigation interactions. Run both API/web typechecks and relevant regression tests. Product metadata stays behind the existing authentication boundary, credential references remain server-side, and linked destinations use safe schemes.

## AC7

Independent spec and quality reviewers exercise the candidate's actual navigation and links on desktop and phone viewports, including opening each launch dashboard and Earshot's existing Live view. Record what ran and what did not; mockups, source inspection or a login redirect alone are not browser proof.

## AC8

The owning PM preserves a reviewed local implementation checkpoint and clear handoff for the normal production procedure. Public /products serving and authenticated live browser acceptance remain unmet until push/deploy authority exists. No change to the currently running app is authorized by this ticket alone.

## Original attribution and verified-input context

The three dashboard URLs returned their expected product pages during intake; the three committed declarations say launch and Earshot says live. HOLOC-55 is completed reusable work, not a dependency to reopen. Tolt PM is filing intake only; Holocene PM owns acceptance and queue order, and Krebs alone dispatches implementation. Pillars: Chase the Check; Dogfood the Platform; Build LEGO, Not Statues.

## Authority overlay for this phase

Latest worker instruction: phase 1 investigation/spec/private Stitch only. No final implementation until owning PM selects design; no board writes, merge, push, deployment, restart or production commands. Later commit/push authorization exists at parent level but is not exercised by this phase. The original ticket no-push text above is retained, not silently rewritten.
