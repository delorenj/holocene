# Home

The operator home: the kit assembled, answering in order whether anything is waiting on you, who is working, whether anything is broken or stuck, and what just happened.

## Composition, top to bottom

1. **Bar.** The mark and wordmark, then the `SourceStrip` (the page's receipt), then Jump to with `mod+k`.
2. **Statement.** One `display` sentence that answers the page ("Two things need you."), then one line of context.
3. **NeedsYou list.** Full width, gates first.
4. **Two columns.**
   - Working now: `AgentLine`s.
   - Readings: two or three of them.
5. **Last 24 hours.** `Strata` with a window control.
6. **Two columns.**
   - Recent events, with tool calls folded.
   - HTTP probes as a `Census`.

## Rules

- The statement changes with the state: "Two things need you." when items are waiting, "Nothing needs you." when none are, "Holocene can't see the fleet." when the sources are down.
- The page uses no boxes. Hairlines, space and one ochre row do all the grouping.
