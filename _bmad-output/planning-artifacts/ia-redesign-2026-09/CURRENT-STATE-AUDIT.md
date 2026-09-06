# Holocene live tour — raw observations (2026-09-06, 1600x1100, https://holocene.delo.sh)

## Global shell
- Header: eyebrow "33GOD CONTROL PLANE" + h1 "Holocene" + two destructive-ish global
  buttons ("Restart gateways", "Sync defaults") floated top-right with no confirmation.
- Nav: 4 flat text tabs (Fleet / Tooling / Systems / Containers). No hierarchy, no
  counts, no attention badges. Tabs are the ONLY navigation. No URL routing (tab state
  is component state — no deep links, no back button, no shareable view).
- Container width is INCONSISTENT per tab: Fleet/Tooling/Containers = 1280px (.shell
  max-width), Systems = ~1470px. Visible jump when switching tabs.
- No global search. No time control. No refresh indicator beyond a "Snapshot 9:00:27 AM"
  stat card. No dark/light (dark only, fine). No density control.

## Tab 1 — Fleet
1. **"Orwell" clock card occupies the #1 slot** — the single most valuable pixel block on
   the dashboard is a manual clock-in/clock-out with two giant 50/50 candy-colored buttons
   (mint green / salmon pink) and "Last state: unknown". It is a personal timesheet toggle
   sitting above the entire fleet.
2. Stat row: Agents 29 · Working 2 · **Needs attention 26** · Snapshot <time>.
   26/29 "need attention" = the alarm is meaningless. An always-red metric is not a metric.
   "Snapshot" (a clock) is given equal visual weight to the alert count.
3. **Ticket Velocity** — an hour-wide swimlane grid (-55m -> now) with only 2-3 rows and
   ~95% empty cells. Legend uses 3 colors for "1/2/3 tick" severity. Bars are placed at
   -55m and never move. Enormous space, near-zero information.
4. **Right Now** — expanded cards per agent. Shows "RUNNING 97d 23h", "97d 23h quiet",
   "Refreshed 97d ago" while the badge says **"Checking"** in yellow.
   *** The dashboard reports a process that died 97 days ago as actively checking. ***
   Same for Drumjangler: "Blocked ... 83d 9h quiet", "exit 0 83d ago".
   This is the credibility killer: nothing on screen tells you the data is fossilized.
5. **Fleet table** — 29 rows x (Agent, Repo, Gateway, Consumer, Sentinel, Work, Issue,
   Updated). Every row carries **9 tiny icon buttons** (play/restart/stop x3 columns)
   => ~260 identical unlabeled controls in one table, no tooltips, no confirmation.
   Column values are near-constant: Consumer="Missing" on 29/29 rows,
   Sentinel="Inactive" on 29/29, Work="Unknown" on 26/29, Updated="unknown" on 26/29.
   Three columns are pure noise; the table is 8 columns wide to carry ~2 bits of signal.
   Gateway is the only varying column (Active/Inactive/Activating/Missing).

## Tab 2 — Tooling  (the worst offender, and the biggest opportunity)
Four stacked sections, all rendered by the same generic collection renderer:
1. **Hook Health** — 6 huge pill chips (Claude FAIL, Hermes FAIL, Codex FAIL, Kimi WARN,
   Gemini OK, OpenCode FAIL) with diagonal barber-pole stripes + a floating status coin
   that overlaps the pill's left edge. Chips are ~340x60px each for one bit of state.
   *** CONTRADICTION: "Claude FAIL" here, while the section directly below reports
   claude - post_tool "live - last 0s ago - 5 alive". Two panels, same subject,
   opposite answers, no reconciliation. ***
2. **Agent Hook Telemetry** — ~70 full-width stacked cards, each ~72px tall, each reading
   `<cli> - <hook>` / `<state>` / `event - last Xs ago - N alive`.
   This is an (8 CLI x ~8 hook) MATRIX rendered as a 1-column list = ~15 screens of
   scrolling. Every card is visually identical. Cannot compare claude vs codex without
   scrolling past 20 rows. **This is a heatmap that was built as a feed.**
   Mixed into the same list: `hermes - <profile>-pm` rows ("silent - gateway is up but
   this profile has never emitted an event") — a completely different entity type
   (profiles, not hooks) interleaved alphabetically with hook rows.
3. **Agent Hook Tests** — 5 more barber-pole chips (Antigravity OK, Claude/Codex/Copilot/
   Hermes FAIL). Same visual language as Hook Health, different meaning. Unexplained.
4. **Agent State Machine** — *** THE BURIED TREASURE ***
   Live ASM data: "claude - holocene / tool_running / tool_running for 76s - pane 14",
   "codex - skillex / tool_running for 66m - pane 21", "hermes - 33GOD / delegating for 2.6h",
   "codex - slowburns / delegating for 52m - pane 2".
   Plus a header row: "56 agent(s) alive, not yet observed - discovered - Found in /proc
   but has not emitted a hook event yet".
   This is the ONLY real-time "who is doing what right now" view in the entire product and
   it is at the bottom of the 4th section of the 2nd tab, ~18 screens down, rendered as
   the same undifferentiated 72px cards. Duplicate keys visible (claude - holocene twice,
   claude - james-brennan twice) with no disambiguation beyond pane id.

## Tab 3 — Systems (best-built tab)
- Stat row: Background tasks 475 / Failed 9 / Unhealthy-restarting 0 / Snapshot.
- **"Over Time"** — 4 sparkline cards (Load 1m, Containers running, Problem units, Failed
  user services) with a 6h/1d/3d/7d segmented control. Genuinely good: real trend, real
  peak annotation, honest source note ("srvls inventory -> node-exporter textfile ->
  Prometheus, every 5 minutes"). The 4th card orphans onto its own row (3-col grid, 4 items).
- **Inventory** — 475 rows, unpaginated, with a genuinely strong faceted filter bar:
  semantic search, source/project/board selects, and TYPE (cron 16, docker 117, sys-svc 162,
  sys-timer 21, usr-svc 109, usr-timer 50) / STATE (Attention 9, Running 369, Waiting 85,
  Inactive 9, Other 3) / HAS (Actionable 276, Preview 472, PM 119, Board 119, Scheduled 136)
  chips with live counts. **The filter design is the best thing in the app.**
  But the DEFAULT is unfiltered, so the first thing you see is `apparmor.service`,
  `cups.service`, `dbus.service`, `alsa-restore.service` — raw OS noise. The 9 things that
  are actually broken are behind a click nobody knows to make.
  Actions column reads "read-only" on every row.

## Tab 4 — Containers
- Stats: Total 80 / Healthy 49 / **Unhealthy 26** / Unknown 5 / In Cooldown 0.
  "In Cooldown 0" orphans onto its own row (4-col grid, 5 items).
- 80 cards, 4-up, **alphabetical**, no filter, no sort, no grouping. The 26 broken ones
  are scattered evenly through 20 rows of green. You must visually scan all 80 to triage.
- Card = name / HTTP status / URL. Status color semantics are wrong:
  `naipkins 204` renders RED (204 is success), `minio-api 403` renders with a GREEN dot,
  `fileshare 404` green dot + red border. Dot color and number color disagree.
- **Name is not unique**: holocene-web x2, naipkins x4, svgme x2, plane-minio-service x2,
  plane-* x5. The URL is the real identity but it's the smallest text on the card.
- Nothing is clickable. No restart, no logs, no last-transition time, no "since when".

## /hq (DeloHQ Telegram Mini App)
- Correctly gated: renders "Open this from Telegram. DeloHQ is a Telegram Mini App —
  launch it from the @DeloHQBot menu button..." Good honest empty state (better copy than
  anything on the main dashboard). Separate stylesheet (hq.css, 688 lines) — a visual fork.

## Foundation
- Hand-rolled CSS: globals.css 1791 lines + hq/hq.css 688 lines. No Tailwind, no CSS-in-JS.
- Tokens exist but are skeletal: 5 semantic colors (--blue/--green/--yellow/--red), 5
  surfaces (--bg/--panel/--panel-2/--line/--ink), 2 text (--text/--muted).
  NO spacing scale, NO type scale, NO radius scale (8px everywhere), NO elevation,
  NO motion tokens, NO state colors beyond the 4 hues.
- Radix is installed (dialog, hover-card, toggle-group) but barely used.
- Font: Inter via system stack only — never actually loaded, so it silently falls back.
- 316 className vs 6 inline styles — the CSS discipline is fine; the SYSTEM is missing.
- Next.js 15 App Router, React 18, but page.tsx is one 944-line "use client" component.
