Holocene "Now" — the desktop landing of the 33GOD control plane (route `/`), 1440px wide. One operator runs a self-hosted pipeline of AI agents; this screen answers, in order: What is waiting on me? Who is working on what? Is anything stuck or broken? What just happened?

Visual system "Spruce" (dark): page ground #141714 with no panel fills — panels sit directly on the ground, separated by 1px hairlines #282d29; floating things only use surface #1b1e1b; wells and chips use sunken #0e110e. Text ink #e3e8e3, secondary #b6bcb7, metadata #909590. Exactly five signal hues, each with one meaning and a soft tint behind its own text: ochre #d8b36e = needs YOU (only things the operator can act on, plus the focus ring); brick #de8c7a = broken; heather #b3a2ca = stuck (over time budget); lake #89b5cd = working; moss #92b98d = cleared recently. Healthy is quiet grey, never a wall of green. Corners barely soften (2–6px). No shadows except on floating things. Dense rows, 36px tall.

Type: one Newsreader serif statement per view only; all interface text in Atkinson Hyperlegible Next; everything a machine wrote (agent ids, ticket keys like HOLOC-8, SHAs, units, panes, paths, durations, counts) in Atkinson Hyperlegible Mono as small copyable chips. Sentence case, no emoji, no exclamation marks. Buttons are verbs naming exactly what happens ("Approve push", "Go to pane", "Acknowledge").

Layout, top to bottom:
1. Truth strip: a 24px sticky monospace bar of data sources, each token coloured by its own age, e.g. "sweeper 8s · asm 68/13 · candystore 918,762 · nats 143,633 · probes 3m · fleet 41s"; one token dead shows "sweeper DOWN" in brick.
2. Statement in the serif: "Two things need you."
3. Attention band, expanded as a ranked queue of two ochre rows: "codex wants approval to run git push --force-with-lease" (worker scope, held 12m) and "holocene-pm asks whether HOLOC-8 should land as one PR or three" (held 1h 06m), each with the raw machine state beside the sentence and one primary action.
4. Live agent board table, columns: state glyph | held | cli | repo | pane | tools. Rows sorted by severity then held time: one stuck worker (heather triangle, "4d 02h"), one broken (brick disc), several working (lake), the rest quiet grey. A single collapsed line at the bottom: "55 alive, never observed" in hollow glyphs on a faint diagonal hatch, with values suppressed.
5. A narrow "wedge rail" summarizing 12 long-running worker scopes, 10 marked stuck.

Every status has a distinct shape before colour: filled diamond = blocked on you, filled disc = broken, filled triangle = stuck, dot = nudge, dash = OK. Stale readings show a leading "~" at 50% opacity; never-observed shows "No signal in 98d", never zero.
