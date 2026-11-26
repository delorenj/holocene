# Agents inspector sidebar: Stitch suggestions, 2026-11-26

Project `14104283770497705087`. Jarad asked to implement the Stitch-suggested sidebar updates. Three screens were new since the HOLOC-57 handoff, downloaded privately into their own directories here (HTML is untrusted reference; never executed or shipped):

| Screen | Title | Device | Role |
|---|---|---|---|
| `17222125430182367783` | image.png (IMAGE upload) | n/a | Screenshot of the live Agents page that seeded the concepts |
| `7d0b73a7cf104dbc889dcb4c313fda66` | Holocene Agents — Org Chart Redesign | DESKTOP | Agent inspector: identity row + status tag, Task first, compact Project, Directs chips, pinned actions |
| `d470bfc8c3bb455d8217d367890ffa0f` | Holocene Agents — Mission Dispatch Sidebar | DESKTOP | Director overview: fact tiles, archived missions, pinned actions |

Canvas: https://stitch.google.com/projects/14104283770497705087?node-id=7d0b73a7cf104dbc889dcb4c313fda66 and ?node-id=d470bfc8c3bb455d8217d367890ffa0f

## Accepted (layout), applied to every hub inspector (Agents and Projects)

- Identity row: avatar/icon tile, eyebrow, name, id, and a signal-tinted status tag (`state · held`) on the right.
- Two-up fact tiles from d470bfc8, filled only with sourced values (gateway, last moved, tools, subagent lanes; fleet stats on You; ticket/dependency counts on projects). An absent value hides its tile.
- Ruled sections whose label row carries a tag or count. Working on moves to the top; Project is compact with a repo field; Directs become focusable chips.
- Actions pinned to the bottom, using only routes and handlers that already exist: Open project, Agent settings, Open PM/director, Open delegator.

## Rejected as invented or ungrounded

Missions (active mission, mission IDs, quote, archived missions, task counts), Stage/Uptime/Health tiles, LIVE SYNC badge, Draft New Mission, Export Audit, Ping (Holocene publishes no commands besides harvest.start), Inspect Session (no session surface exists), header counters (AGENTS 12 / PROJECTS 4), nav without icons, Media collapsed into a single leaf. Toolbar filter (All/Active/Directors) and zoom controls are canvas changes, not sidebar, and remain unimplemented.
