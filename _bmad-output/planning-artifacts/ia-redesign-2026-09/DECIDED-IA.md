# Holocene IA — the decided design
Synthesized from 3 proposals + 2 adversarial judges. Where they conflicted, this file decides.

## The one-line principle
**Present tense on top, past tense underneath, and the machine must pay for its silence.**
Redis is authoritative for "now". Candystore is authoritative for "what happened".
Nothing renders as healthy that hasn't proved it, and an empty alarm state is a claim that
must be itemized, not a blank.

## The decision the panel forced
Operator-fit chose the interrupt queue; feasibility chose the lens spine. Both flagged the
other's landing route as its central flaw. **So do not split them.** `/` is ONE route:
an attention band that expands to a queue when something wants him and collapses to an
auditable receipt when nothing does, sitting directly above the live agent board. He gets
interrupt discipline AND ambient "the machine is alive" from the same screen, with no route
choice to get wrong.

## The severity ladder (5 rungs, one vocabulary, replaces all four existing ones)

| rung | glyph | meaning | sole authority |
|---|---|---|---|
| **BLOCKED** | ◆ filled | operator is the bottleneck, wall-clock burning | ASM `awaiting_human` + `block_kind=gate` |
| **BROKEN** | ● filled | failed and stays failed without intervention. Includes a **blind oracle** | ASM `failed`; systemd `Attention`; probe 404/410/5xx/timeout; dead sweeper |
| **STUCK** | ▲ filled | running but past its own budget, not progressing | time-derived ONLY, never state-derived |
| **NUDGE** | · | soft attention that self-clears | ASM `bell` (30m cap); probe 429; review-state tickets |
| **OK** | ─ | normal. idle, working, tool_running, delegating, 2xx/3xx, scheduled | everything else |

Rules that make it work:
- **OK is GREY, not green.** A wall of green rewards the machine for a claim it hasn't earned.
  Green is reserved for one thing: a row that LEFT the queue in the last 6h.
- **Confidence is an orthogonal axis rendered as FORM, never hue.**
  OBSERVED = solid glyph · STALE = 50% opacity + leading `~` · UNOBSERVED = HOLLOW glyph on
  diagonal hatch, value SUPPRESSED and replaced by literal `no signal 98d`.
  **An UNOBSERVED thing can never be green, never be red, and never enters the queue.**
  This single rule kills both "Needs attention 26/29" and delodocs-pm-working-on-a-98-day-heartbeat.
- Mapping in: busy_state error→BROKEN, stalled→STUCK, blocked→**STUCK not BLOCKED** (a sentinel
  file carries no block_kind, so it cannot prove a gate — ASM/Redis is the ONLY gate oracle),
  busy/idle→OK, unknown→OK@UNOBSERVED printing `active_work.reason` verbatim.
  Heartbeat age >50m forces STALE; >24h forces UNOBSERVED and suppresses the state string.
  HTTP: 2xx/3xx→OK, 401/403/405→OK badged `walled`, 429→NUDGE, 404/410/408/5xx/timeout→BROKEN.
  (204 is 2xx → OK, fixing naipkins rendering red today.)
  stateBucket: Attention→BROKEN, everything else→OK / OK@UNOBSERVED.
  tooling `severity`: critical→BROKEN, warning→NUDGE, ok→OK.

## Routes (7 + 4 detail families). Every one deep-linkable — the app has NO routing today.
- `/`          **Now** — attention band + live agent board *(default)*
- `/trail`     Past tense. Children are Candystore's OWN lenses: `/trail/pm|decisions|sessions|turns|agents|tools|errors|ops|reports`
- `/board`     227 tickets by `tp_band` across 12 live boards
- `/fleet`     29 Hermes PMs, the org, and the ephemeral worker depth the chart flattens
- `/systems`   476 inventory items + 80 probes unified — "what is broken on this box"
- `/hooks`     the CLI × role telemetry matrix
- `/truth`     sources & trust — **p0, not an admin afterthought**
- details: `/a/:scope` · `/s/:correlationid` · `/t/:key` · `/u/:unit`

## Landing surface, top to bottom
1. **Truth strip** (24px, monospace, sticky, every route):
   `sweeper 8s · asm 68/13 · candystore 918,762 · nats 143,633 · probes 3m · fleet 41s`
   Each token coloured by its own age against its own cadence. **No client-side fake motion** —
   it updates when data updates. If any oracle dies the token flips to `sweeper DOWN` in BROKEN-red
   and the viewport grows a 3px rule.
2. **Attention band** — expands to a ranked queue when non-empty; when empty collapses to the
   **receipt**: `Nothing needs you. 9 detectors evaluated, newest 4s ago` + a per-detector line
   naming what each scanned, how many, and its last-eval age. This is the mechanism that lets
   him trust silence, and it's the only thing preventing "26 of 29" re-forming one level up.
3. **Live agent board** — the ~13 OBSERVED ASM scopes. Columns:
   `state ◆●▲·─ | held | cli | repo (cwd basename) | pane | tools/subs`.
   Sorted severity, then held_for desc. The ~55 UNOBSERVED rows collapse to ONE expandable line
   (`55 alive, never observed`), and any `cwd` ending ` (deleted)` is marked **abandoned** —
   those are permanent residents, `gone` will never fire for them.
4. **Wedge rail** — the 12 worker scopes. **10 have been ACTIVE since 2026-09-02, four days.**
   They are wedged, not bursty. Design for stuck.

## Things the panel proved, that change the design
- **`asm:t:<scope>` is a per-scope Redis STREAM** (XLEN 510 on james-brennan-pm) with a `reason`
  field per edge. Free causal history. Render the 88-342ms flap as **texture** — a proportional
  30-minute state band on `/a/:scope` — instead of coalescing it away from a strobing table.
- **The blind-oracle detector already ships**: `agent-hook-telemetry` computes
  `codex|attention → {severity: critical, verdict: silent, lastSeenAgo: never, agentsAlive: 41}`.
  **41 codex agents are alive and the attention hook has NEVER fired — gates on codex are
  structurally invisible.** That is the highest-value row in the product and it costs zero backend.
  It also means BLOCKED is currently under-counted, which is exactly why `/truth` is p0.
- **`correlationid` is empty on all 68 asm:live members** → there is NO live seam from a running
  scope to its Candystore session. Do not design one. `/a/:scope` and `/s/:cid` are separate.
- **`zellij_pane` is on only 10 of 68 scopes and empty on every PM** → "go to pane" is a
  conditional affordance, never the primary action.
- **No review lane on `tp_band`** — `in_review` occurs ZERO times. Review = `ticket.state.name`
  ∈ {Awaiting Decision, Ready for QA, Complete but Unacknowledged}, which live in bands
  started/completed. All three proposals got this wrong and put a permanently-empty column at
  the top of their ladder.
- **`agent:working` lease age** is the ownership signal (16 tickets). Show the AGE and cross-check
  against a live worker scope; a lease with no matching scope renders STUCK with the reason,
  never silently clean.

## The inferred-edge contract (adopted from the losing proposal — it's the best rule in the set)
Every parse-derived relationship (worker→PM, scope→project from cwd, ticket→worker from a
filename fragment) renders with a **dotted affordance** and a tooltip naming the exact parse; the
**raw source string is shown ABOVE its parsed fields**; and — load-bearing — **an inferred edge may
never drive a severity count.** A failed parse becomes a visible anomaly, not clean-looking data.
Note: transient scopes have **no ExecStart and MainPID 0** — identity is in `Description=`.

## Deletions (all three proposals independently agreed)
Orwell clock from slot #1 (its `/api/clock/state` is 500 — move to ⌘K) · Ticket Velocity entirely
(0 rows, every bar synthesized at page.tsx:403) · the "Needs attention 26/29" tile (page.tsx:517)
· the Consumer + Sentinel columns and 174 of 261 buttons targeting units that don't exist ·
`agent-hook-health` + `agent-hook-tests` (superseded by their successor's own docstring; health
has a 30-DAY TTL and inventories a CLI set that isn't the SSOT) · `LiveStatPanel` +
`<pre>{JSON.stringify}</pre>` (tooling.tsx:353-368) · the 4-tab component-state shell · two of
three palettes · `hq.css` as a fork (keep the /hq LAYOUT — it's the better product — kill its
private palette) · the phantom Inter declaration and `.stitch/DESIGN.md`'s 8-scale system built
on a font that has never once rendered · the "bridge-bound" badge on 26 agents while the bridge
is down · both fake SSE endpoints · the 155MB readFileSync · the two unconfirmed header buttons.
**Keep** `/hq/api/snapshot` — it's a working initData-gated HMAC proxy, not a stub.

## Promote (already good, badly placed)
The Systems faceted filter bar (typed chips with live counts) becomes the shared filter primitive
across `/systems`, `/board` and `/trail`. The Systems preview interaction (hover card → modal →
"Open in Alacritty") becomes the shared detail primitive. The "Over Time" sparkline row becomes
the shared trend primitive, fed by `/summary/timeline`. /hq's attention-chip row, Right Now ticker,
bottom-sheet, reduced-motion guard and bridge card get promoted INTO the desktop.

## Future seams (nothing here is built on data that doesn't exist)
- **Flume** → `/fleet` already speaks its Employee/Manager/Contributor vocabulary via `org-model`.
  Seam: keep `employeeRole` + `EmployeeStatus` in the row model. Needs: a checkout and a contract.
- **DeLoCompany** → `/hq` is the phone surface today. Seam: the shared token layer + severity
  ladder, so a second Mini App skins rather than forks. Needs: the product to exist at all.
- **Krebs runtime** → `/board` is built on `tp_band`. Seam: a `phase` column that renders only
  when a phase field is ever populated. Needs: Krebs to emit anything.
- **Command dispatch** → exactly ONE command is wired end-to-end
  (`bloodbank.cmd.agent.invocation.start`). Seam: the ⌘K `>` prefix. Do not build a console for 6.
- **New event domains** → `/trail` reads `/lenses` and `/classes` at runtime with their own colors
  and counts, so a new lens appears without a frontend change. 6 of 14 declared domains have
  ZERO traffic ever — build nav from live counts, never from the schema list.
