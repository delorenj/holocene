# Holocene redesign — verified ground truth (2026-09-06)

Everything below was MEASURED against live services, not read from docs. Docs in 33GOD are
frequently stale; this file supersedes them.

## Who this is for
ONE operator (delorenj). No teams, no roles, no permissions, no onboarding, no staging lane.
He runs a self-hosted agentic dev platform on one box (big-chungus). He is usually in a
terminal (zellij), sometimes on his phone. He pivots hard and fast. He does not want ceremony.

## The five questions he actually asks, ranked
1. "Is anything waiting on ME right now, and which zellij pane do I go to?"
2. "Who is actually working right now, and on what repo/ticket?"
3. "Is anything wedged / stuck / lying to me?"
4. "Is anything on fire — across agents, tickets, services, and the event pipe?"
5. "What happened in the last hour / to this ticket / in this session?"

## LIVE DATA THAT EXISTS TODAY (all verified)

### ASM — Agent State Machine (bloodbank/services/agent-hooks) — THE CROWN JEWEL
- Redis 127.0.0.1:6379. Written ONLY by core/asm.lua (EVAL-atomic).
- `asm:live` ZSET: **68-70 scopes right now**. Of those only **~13 carry an OBSERVED state**
  (5 tool_running, 4 idle, 2 working, 2 delegating, 1 starting). The other **~55 are `unknown`** —
  found in /proc, never emitted a hook.
- Scope key: `{cli}:p:{pid}.{starttime}` (processes) or `{cli}:a:{profile}` (Hermes profiles).
- `asm:a:<scope>` HASH fields: scope, cli, pid, starttime, cwd, state, main_lane, turn, tools,
  subs, blocked_until, gated_until, block_kind, err_ms, last_ms, since, prev, prev_held_ms, seq,
  basis, zellij_session, zellij_pane, correlationid, session_id, profile.
- States + PRIORITY ORDER (from asm.lua):
  gone > stale > awaiting_human > failed > delegating > tool_running > working > starting > idle.
  `awaiting_human` deliberately outranks `tool_running`. Plus `unknown`.
- **bell vs gate** (`block_kind`): a *bell* is a soft notification, caps at 30 min.
  A *gate* is a permission prompt — the operator IS the bottleneck — 12h ceiling, and a surface
  may NEVER clear it (asm.lua structurally restores gated_until). Only `block_kind` preserves
  this distinction. THIS IS THE MOST IMPORTANT BIT ON THE BOARD.
- **The sweeper IS built and running**: core/sweep.py via asm-sweep.timer, 15s cadence.
  `asm:sweeper` key (EX 60) is its liveness oracle. If absent, stale/gone are unknowable and
  every green row on the page is fiction.
- **`asm:transitions` Redis pub/sub channel** carries every edge as JSON, live, 1 subscriber.
  Measured flap rate: tool_running<->working every 88-342ms on a busy PM. **Coalesce ~750ms-1s
  or the table strobes.**
- The sweeper ALREADY writes a Holocene-shaped card to `holocene:tooling:stat:agent-state-machine`
  every 15s (TTL 84s), served today at /api/modules/tooling/stats/agent-state-machine.
- The 55 unknown rows include real garbage: 20+ codex processes sitting in
  `/tmp/jimb-169-prod-incident-20260901 (deleted)` for 19h+. They're alive in /proc so `gone`
  will NEVER fire. Permanent residents until killed.

### Candystore — the event read API (127.0.0.1:8683) — MASSIVELY UNDERUSED
918,762 events since 2026-05-24. Postgres `public.events`, trigram-indexed `search_text`.
- `GET /lenses` -> pre-built IA grouping WITH LIVE COUNTS (24h):
  **pm 127, decisions 22, sessions 147, turns 185, agents 250, tools 15461, errors 171, ops 58, reports 3**
  Its own description says tools are "96% of the trail by volume; usually what you collapse."
- `GET /classes` -> actor taxonomy WITH A HEX COLOR AND AN HONEST `coverage` CAVEAT PER CLASS:
  agent 11353, pm_agent 3404, subagent 1308, service 140, ticket_webhook 105, n8n_workflow 0,
  operator 0, other 0. **This is a ready-made legend. Do not invent another one.**
- `GET /events?lens=&class=&project=&cli=&from=&to=&correlationid=&q=&tools=0&limit=&offset=`
  Each event carries a pre-rendered `summary.row{headline, body, actor_label, status, ok, class,
  project_label, duration_ms}`. **The server already did the presentation work.**
  Unknown slug/class -> 400 listing the valid set (deliberate "your typo vs no traffic" distinction).
- `/summary/timeline?hours=N` -> per-minute buckets {bucket, series{class:n}, total}.
- `/summary/by-cli` all-time: claude 485957, codex 298443, hermes 120057, antigravity 3568, copilot 1730.
- `/summary/by-project`, `/summary/daily` (12k-30k events/day), `/summary/heatmap`.
- `/sessions/<correlationid>` + `/summary` -> whole session folded, tool runs collapsed.
- `/projects` -> 24 registered slugs; only 6 have 24h traffic (james-brennan 10210 dominates).
- **`dead_letter` table: 993 all-time, 285 in the last 7 days, STILL GROWING.** Cause:
  hermes-agent emits non-UUID correlationids (`20260906_090133_3ae8b8`). A chunk of the PM
  fleet's traffic reaches NATS and NEVER reaches Candystore. Nothing surfaces this. Highest-value
  unsurfaced fact in the system.

### Bloodbank event/command backbone
- NATS JetStream, monitoring at http://127.0.0.1:8222/jsz?streams=true&config=true
- `BLOODBANK_EVENTS` (`bloodbank.evt.>`) 143,633 msgs / 466 MB, 7d retention, 36 bound subjects.
  Consumers: `candystore-events` + an orphan `curator-drain`.
- `BLOODBANK_COMMANDS` (`bloodbank.cmd.>` + `bloodbank.rpy.>`) workqueue, 24h, durable
  `bloodbank-hermes-gateway`.
- Subject shape `bloodbank.evt.<domain>.<entity>.<action>`. CloudEvents 1.0 + 33GOD extensions
  (kind, actor{cli,provider,agent_id,model}, producer, service, domain, correlationid, causationid,
  ordering_key, and a NEW `ephemeral{path,branch,repo,main_checkout}` for worktree-origin events).
- Declared: 14 domains / 87 schemas. **Actually fired in 7d: 35 types across 8 domains.**
  `attendance`, `lifecycle`, `llm`, `cli` have schemas and ZERO traffic ever — 6 of 14 "active"
  domains are dead on the wire. Do not build nav for dead domains.
- Rate: 12k-30k/day, peak hour 2,950 (~50/min). `agent.tool.requested`+`agent.tool.completed`
  = 96% of volume. Everything the operator cares about is a trickle underneath:
  decisions 44/day, repo.maintenance.failed 0.6/day, finance.projection.breached 1.3/day.
- **EXACTLY ONE dispatchable command is wired end-to-end**: `bloodbank.cmd.agent.invocation.start`.
  5 more schemas exist with no consumer. Do not design a command console for 6 commands.
- **`deckard.evt.attention` is published to CORE NATS, not JetStream.** Notification /
  PermissionRequest / TeammateIdle are `publish:false` on the contract stream. Any JetStream-only
  consumer is structurally blind to awaiting_human. Attention must come from ASM/Redis.
- **event-toaster pushes EVERY event to ntfy at priority 5** — ~20k phone notifications/day, no filter.

### Normalized hook system
- ONE SSOT: `bloodbank/services/agent-hooks/hooks.master.json` (mtime 2026-09-05).
- 10 normalized lifecycle roles: session_start, session_end, prompt_submit, turn_complete,
  pre_tool, tool_invoked (declared, emitted:false), post_tool, invocation_start, subagent_stop,
  invocation_failed. Plus a non-publishing pseudo-role `attention`.
- **SIX CLI dialects ONLY**: claude, copilot, codex, hermes, antigravity, openclaw.
  **opencode / cursor / aider are NOT in the SSOT** — they appear only in the banned-token list
  and as /proc comm names. Holocene's own hook-health card inventories a DIFFERENT set
  (claude, hermes, codex, kimi, gemini, opencode) and is therefore permanently red for a
  contract that does not exist. Its Redis TTL is ~30 DAYS so it outlives its own producer.
- `asm:seen` HASH: `<cli>|<event type>` -> last-fired ms. 84 fields. This is the real telemetry.
- **THREE Redis cards answer ONE question and two are known-wrong by their successor's own
  docstring**: agent-hook-health (superseded, 30d TTL), agent-hook-tests (superseded),
  agent-hook-telemetry (the correct one). Consolidate to telemetry, retire the other two.

### Krebs — ticketing lifecycle
- **Spec repo, ZERO executable code.** adapters/ webhooks/ mcp/ observability/ each contain
  exactly one README describing software that does not exist.
- What it genuinely owns: `spec/lifecycle.v1.yaml` — 9 phases (backlog, triage, refining, ready,
  in_progress, review, qa, done, blocked), per-phase staleness budgets, WIP=1, 4-criterion AC
  rubric, qa.max_retries=3. One runtime consumer: `lifecycle.sh`, a read-only query CLI.
- **NOT ONE EVENT IN CANDYSTORE CARRIES A KREBS PHASE.** `data.phase` holds Plane state names
  (Backlog/Todo/In Progress/Done/Cancelled). `data.previous_phase` is CORRUPT (raw UUIDs, "none",
  "urgent"). `task.flagged` has 0 events and no schema — staleness detection does not exist.
- **Build the pipeline view on `tp_band`** (backlog / unstarted / started / in_review / completed).
  It is the ONE lifecycle field correctly and consistently populated across all 993 live events.
  NEVER on `data.phase`. Note: Plane "Cancelled" maps to band `completed` — read
  `ticket.state.name` to tell cancelled from done.
- The lifecycle actually in production is a Plane LABEL system: `lifecycle:triaged` (latch) and
  `agent:working` (lease). 16 tickets carry `agent:working` live. Known failure mode: leases that
  never self-clear. **Show the lease AGE, and cross-check against a live hermes-worker-proc scope.**
- Webhook path is n8n, not Krebs: every live task event carries producer=`n8n-plane-webhook`.
- Cardinality: 72 projects, ~40 bound boards, **only 12 with events in 14 days**, 227 active
  tickets — james-brennan alone is 134 of them. HOLOC: 8 tickets, all Backlog, none assigned.
- Per-ticket timeline is the BEST-SUPPORTED query in the domain: `ordering_key = task:<repo>:<ticket_id>`.
- Staleness budgets (from lifecycle.sh): in_progress 120m, qa 60m, refining 30m, review 15m, triage 10m.
- The autonomous review protocol parks accepted work in the REVIEW lane as the operator's queue.
  **That is a first-class operator inbox with no UI today.**

### Org / Flume / DeLoCompany
- **Flume is NOT the org chart owner today.** It's a public GitHub repo (delorenj/flume, last push
  2026-02-22, 6.5 months cold), NOT checked out locally, NOT in .gitmodules (orphan
  .git/modules/flume/config only), listed in README/PRD as PLANNED. Its contribution is VOCABULARY
  ONLY — Employee/Manager/Contributor + EmployeeStatus, already vendored into
  holocene/packages/org-model/src/index.ts.
- **"DeLoCompany" exists nowhere on disk or in the GitHub org.** Nearest real thing:
  `delorenj/delonet-company` at ~/code/delonet-company — a Python "DeLoNET Director" portfolio
  control plane, FastAPI on :8790 NOT LISTENING, its own README marks Telegram/systemd as Deferred.
  It is a sibling company-level intake/router, NOT a rename or successor of DeloHQ.
- What EXISTS: `~/.hermes/org.yaml` (hand-edited, 6 departments) + `~/.hermes/agents-registry.yaml`
  (29 agents) merged by packages/org-model into `GET /api/modules/org/tree`, rendered by the
  DeloHQ Telegram Mini App at /hq (live, HTTP 200).
- Hierarchy is **3 levels and FLAT**: 1 CEO -> 6 departments -> 29 agents, **26 of which are
  interchangeable `<repo>-pm` project managers with ZERO reports.** Departments: Platform 6,
  Developer Tooling 6, Voice & AI 2, Finance & Trading 2, Products 4, Unassigned 9.
  3 of 6 departments have NO manager.
- org.yaml (2026-08-28) predates the registry (2026-09-06) and OMITS 9 provisioned agents.
- **The live overlay is nearly dead**: 25 of 29 report busy_state "unknown". Only tonnybox-pm has
  a fresh heartbeat. **delodocs-pm renders as "working" on a 98-DAY-OLD heartbeat** and increments
  the Working tile.
- **The REAL depth the chart flattens away**: PM -> N ephemeral workers.
  12 live `hermes-worker-proc_<hex>.scope` systemd units, **10 of them spawned by james-brennan-pm**.
  Identity exists only inside the command line (parent profile, ticket id e.g. JIMB-284, worktree,
  harness). Absent from org-model, the registry, and the chart entirely.
- **Plane bridge is DOWN**: hermes-plane-webhook-bridge.service inactive, healthOk false,
  projectsMapped 0, nothing on :8477 — yet 26 agents carry a "bridge-bound" badge whose tooltip
  says "reacts to its board." Largest single source of misinformation on the current screen.

## HOLOCENE AS BUILT — what to keep, kill, and fix

### Stack
Next 15 App Router + React 18, Fastify API on :4000 (`holocene-api.service`, up 11 days),
web in a node:22 container behind Traefik. pnpm workspace, turbo.
Hand-written CSS: `globals.css` 1792 lines + `hq/hq.css` 688 lines. NO framework, NO token layer
beyond 11 color vars. Radix installed (dialog, hover-card, toggle-group) and barely used.
`page.tsx` is one 944-line "use client" component. Tab state is component state — **no routing,
no deep links, no back button, no shareable view.**

### Measured cardinality (LAYOUT-DETERMINING)
- 29 Hermes PM agents (25 unknown / 2 busy / 1 blocked / 1 idle; exactly 1 has an issue_id)
- 68-70 live ASM processes (~13 observed, ~55 unknown)  <- the real "right now" number
- 12 live ephemeral worker scopes (bursty: 0 or 12)
- 36 org nodes (1 + 6 + 29)
- 80 HTTP probe targets (49 healthy / 26 unhealthy / 5 unknown)
- 476 system inventory items (9 failed) — table HARD-TRUNCATES at 400 rows
- 227 active tickets across 12 live boards
- 4 tooling stats with wildly different payload sizes (6 / 5 / 59 / 16 items) through ONE renderer

### Dead / lying / broken (verified)
- **Ticket Velocity is fake.** velocity_history = 0 rows. The Candystore join measures zero
  because live events carry `actor.agent_id = 'bloodbank.agent.claude'`, never a Hermes registry id.
  Every bar is synthesized client-side by `buildCurrentVelocitySegment` (page.tsx:403). It is the
  LARGEST block on the landing tab.
- **"Needs attention: 26 of 29"** — page.tsx:517 counts busy_state 'unknown' as attention.
  25 agents are unknown for one boring identical fixable reason: no sentinel state file was
  ever written. `fleet.ts:412-420` already returns the reason string; nothing shows it.
- **174 of the fleet table's 261 buttons target units that do not exist.** All 29 consumer units
  report 'missing' because `consumer_unit` is unset in the registry so `fleet.ts:775` invents a
  nonexistent name; all 29 sentinel timers are 'inactive'.
- **Restart failures are invisible**: page.tsx:573-604 never checks `response.ok`.
- **`/api/clock/state` is returning HTTP 500 right now** — the Orwell card at the top of the
  landing page permanently reads "Last state: unknown".
- **`agent-state-machine` and `agent-hook-telemetry` have NO renderer** — they fall through to
  `<pre>{JSON.stringify(...)}</pre>` at tooling.tsx:353-368. All four stats declare
  `chrome:'minimal'` and LiveStatPanel then DISCARDS their title, status, freshness and Redis key.
  tooling.tsx was last modified 2026-06-07 — three months before ASM shipped. Holocene renders ASM
  today BY ACCIDENT OF SHAPE, not by design.
- **Nothing is push-based.** Both "SSE" endpoints (server.ts:422, 453) are server-side setInterval
  polls recomputing the full payload every 5s. `packages/bloodbank-client` is a stub imported by
  zero files. 4 of 6 workspace packages are imported by nothing.
- **Performance**: every fleet snapshot spawns **116 sequential `systemctl --user is-active`
  subprocesses** (0.65-1.3s), pushed over SSE every 5s per client, while /hq independently polls
  org/tree which recomputes the same snapshot every 5s. The Containers endpoint
  **readFileSync's a 155 MB / 1.63-million-line log and splits it into an array on EVERY request,
  every 15 seconds.**
- Two endpoints have zero callers; `/hq/api/snapshot` is a dead route file.

### Genuinely good — KEEP AND PROMOTE
1. **The Systems faceted filter bar** — semantic search + source/project/board selects + typed
   chips with LIVE COUNTS (TYPE: cron 16, docker 117, sys-svc 162... STATE: Attention 9,
   Running 369... HAS: Actionable 276, PM 119, Board 119). Best thing in the app. Buried behind
   a default view that opens on `apparmor.service`.
2. **The Systems preview interaction** — hover card + modal + "Open in Alacritty". The single
   best-built interaction in the product, buried in tab 3, column 5 of a 9-column 476-row table.
3. **The "Over Time" sparkline row** — real trend, peak annotation, 6h/1d/3d/7d control, and an
   honest source note. Only honest charting in the app.
4. **/hq, the 700-line phone app, is the better-designed product.** Real transitions, a
   reduced-motion guard, safe-area insets, an attention-chip row above the fold, a "Right now"
   ticker, a bottom-sheet detail pattern, and a **Plane bridge card the desktop does not have at
   all**. It shares ZERO class names with the main app.

### Styling reality
- **Three unreconciled palettes in one file**: the `:root` ramp (--bg #0b1020, --panel #121a2d,
  --line #26324d, --text #eef3ff, --muted #9aa8c7, --blue #7fb0ff, --green #69d3a5,
  --yellow #ffd166, --red #ff7a90); an rgba-white neutral ramp governing the ENTIRE Systems tab
  (globals.css:1203-1579); and a **Catppuccin accent set** (#8aadf4 / #ed8796 / #a6da95 / #f5a97f)
  in the systems chips and charts. None resolve to the same values.
- **Inter is declared in globals.css:30 and loaded NOWHERE** — no @font-face, no next/font, no
  <link>. `.stitch/DESIGN.md` (305 lines) specifies a complete Inter type system across 8 scales
  that has never once rendered.
- NO spacing scale, NO type scale, NO radius scale (8px everywhere), NO elevation, NO motion tokens.
- **Exactly one `:focus` rule and no `:focus-visible`.**
- One 820px breakpoint against 960px and 980px min-widths.
- **One dashed grey `.empty` box doing triple duty as loading, empty AND error.**
- Container max-width is INCONSISTENT per tab (1280px vs ~1470px) — visible jump on tab switch.
- **FOUR incompatible severity vocabularies**: busy_state (idle/busy/blocked/stalled/error/unknown),
  HTTP status code, stateBucket (Attention/Running/Waiting/Inactive/Other), and
  ok/warning/critical. Plus ASM's 10-state ladder. Nothing reconciles them.

## HARD CONSTRAINTS
- Dark-first. Operator lives in a terminal. Monospace is a legitimate primary voice here.
- Desktop 1600px+ is the main surface; the PHONE surface is /hq via Telegram Mini App (initData-gated,
  bypasses the Traefik google-auth wall). Main route is behind Google SSO.
- No new heavy runtime dependency without a reason. Radix is already there.
- Do not design for data that does not exist. Every panel must name its verified source.
- Do not invent a fifth severity vocabulary. Pick one and map everything onto it.
- Respect the operator's time: he will not configure a dashboard. Defaults must be right.

# ============================================================================
# CORRECTIONS — verified by two adversarial judges against live services.
# These OVERRIDE anything above. Where they conflict, the correction wins.
# ============================================================================

## Facts above that were WRONG
- **`tp_band` has NO `in_review` value.** It derives from Plane `state.group` =
  backlog | unstarted | started | completed | cancelled. Across 1000 ticket events / 14 days:
  backlog 147, unstarted 326, started 86, completed 117, none 324. `in_review` occurs **ZERO times**.
  The REAL review signal is `ticket.state.name` ∈ {Awaiting Decision, Ready for QA,
  Complete but Unacknowledged} — all of which sit in bands `started`/`completed`.
  DO NOT build a review lane on tp_band. DO NOT put review at the top of a severity ladder.
- `tp_band` is present on only **77 of 108** ticket_webhook events in 24h.
  `plane.ticket.commented` events carry NEITHER tp_band NOR ticket_key.
  **`previous_tp_band` is populated 0 times.** There is no band-transition edge to render.
- **`?ordering_key=` is SILENTLY IGNORED by `/events`.** Passing a bogus value returns
  unfiltered rows with HTTP 200. The per-ticket timeline query DOES NOT EXIST over HTTP.
  `?q=JIMB-284&lens=pm` returns 0 rows; bare `?q=JIMB-284` returns agent *Bash* events.
- **`correlationid` is EMPTY on all 68 members of `asm:live`.** There is no live seam from an
  ASM scope to its Candystore session. Present-tense ↔ past-tense joining is 0% populated.
- **`zellij_pane` is populated on only 10 of 68 scopes** and is EMPTY on **every**
  `hermes:a:<profile>` scope — i.e. on the entire PM fleet. "Go to pane" cannot be the
  primary action on half the rows. Also `zellij action go-to-tab-name` takes a TAB name;
  `zellij_session` is `Workspace`, the session — that command as written is wrong.
- **`block_kind` IS populated whenever `awaiting_human` occurs.** A live bell was measured
  (`claude:p:703908`, pane 13, `block_kind=bell`). Do NOT ship an "unset = fail safe to gate" rule.
- The `agent-state-machine` card **does** stamp severity correctly: 15 items,
  `Counter({ok: 13, critical: 1, unknown: 1})` — the `failed` row is `critical`.
  Do not re-derive severity client-side to work around a bug that does not exist.
- **87 `systemctl` subprocesses per fleet snapshot, not 116.** `consumer_unit` is unset so
  `unitState(undefined)` returns 'missing' with no exec; only gateway + sentinel service +
  sentinel timer actually shell out (29×3).
- Containers log is 161,450,272 bytes / 1,632,709 lines (confirmed), but a **warm request
  measures 0.32s** end to end. The allocation churn is real; the latency framing was not.
- **The Catppuccin accent set does NOT appear in globals.css.** That claim was inherited,
  not checked. Verify the palette yourself before citing three palettes.
- `systems.tsx:821` renders "Showing first 400 of {N} — narrow the filter." The 400-row
  truncation is STATED, not silent.
- **Radix ships no Command primitive.** Installed: @radix-ui/react-dialog, react-hover-card,
  react-toggle-group. ⌘K needs `cmdk` (a separate package) or a hand-roll.
- `/hq/api/snapshot` has zero callers but is NOT a stub — it is a working initData-gated HMAC
  proxy with an operator allowlist. Deleting it discards the auth pattern the other /hq routes share.

## Exact API paths (previous guesses were wrong)
- Systems unit action: `POST /api/modules/systems/items/:type/:name/:action`   (server.ts:368)
- Fleet unit action:   `POST /api/modules/hermes-fleet/agents/:agentId/services/:service/:action` (server.ts:481)
- Global actions: `/actions/restart-gateways`, `/actions/sync-template-defaults`
- Real line numbers: tooling SSE **399**, fleet SSE **438**, restart-gateways **461**, sync-defaults **470**.

## NEW discoveries the brief did not have
- **`asm:t:<scope>` is a real per-scope Redis STREAM of every transition.** Verified:
  TYPE stream; `XLEN asm:t:hermes:a:james-brennan-pm` = **510**; each entry is a `j` field of JSON
  `{from, to, reason, held_ms, at_ms, seq, tools, subs, turn, cwd, basis, pid, zellij_pane}` —
  including a **`reason`** string ('quiesce', 'tool_done'). This is the ONLY per-agent causal
  history in the platform. It answers "is this thing wedged and how did it get here" with ZERO
  new backend, and it is the right response to the 88-342ms flap: render churn as TEXTURE
  (a proportional state band over the last 30 min) instead of coalescing it away from a strobing table.
- **The blind-oracle detector already ships, computed server-side.** Read verbatim out of
  `holocene:tooling:stat:agent-hook-telemetry`:
  `{severity: critical, verdict: silent, lastSeenAgo: never, agentsAlive: 41}` for `codex|attention`.
  41 codex agents alive and the attention hook has NEVER fired — meaning gates on codex are invisible.
  That row ships with zero new backend.
- **The telemetry card already carries normalized `detail.cli` + `detail.role` across 58 rows.**
  Use it. Do NOT build a matrix from raw `asm:seen`: HLEN is 85 but the prefixes are
  hermes 21, codex 16, claude 15, copilot 13, antigravity 8, **profile 7, reportctl 2, test 1**,
  `__tracking_since`, and one empty key — **openclaw has never fired**. That is 33 distinct
  event TYPES across 10 prefixes, not a clean 6×10 grid of roles.
- **The 12 worker scopes are WEDGED, not bursty.** 10 of them entered ACTIVE on 2026-09-02 —
  four days ago — all under james-brennan-pm. Design for stuck workers, not for churn.
- **Transient systemd scopes have NO `ExecStart` and `MainPID` is 0.** Worker identity lives in
  `Description=[systemd-run] /usr/bin/zsh -lic "hermes --profile james-brennan-pm chat -Q ...
  --query-file /tmp/jimb169-...txt"`. Any design parsing ExecStart reads null.
- **The systems inventory contains ZERO scopes.** `byType` = {cron 16, sys-svc 162, sys-timer 21,
  usr-svc 108, usr-timer 50, docker 118}. Worker discovery needs a NEW
  `systemctl --user list-units --type=scope` read; it cannot ride the inventory endpoint.
- **Ticket events are enormous.** Each carries `description`, `description_html`,
  `description_json`, `description_binary` AND `description_stripped`.
  `/events?class=ticket_webhook&from=-14d&limit=1000` = **12,177,523 bytes**.
  `/events` silently defaults to a 24h window. Never poll the 14-day ticket slice.
- Systems inventory `stateBucket` and `actionable` are **client-side functions**
  (systems.tsx:123), not API fields. `/counts` returns only {total, failed, unhealthy, byType} —
  every STATE and HAS facet count is client-derived.
- Candystore has no `/dead_letters`, `/dead_letter`, `/docs` or `/openapi.json` — all 404.
  The dead-letter count is reachable only via psql today.
- The probe target list (`targets.txt`) is three whitespace columns (url, service, container)
  for 80 rows. There is **no auth-walled marker and no `expect` field** — any "expected status"
  design is a stub, not a read.
