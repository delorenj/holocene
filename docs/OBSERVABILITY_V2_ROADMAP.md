# Holocene Observability v2 Roadmap

> **Author**: Grolf 🪨, Director of Engineering  
> **Date**: 2026-02-20  
> **Goal**: MVP in 1-2 days, then incremental enhancements

---

## Phase 0: Foundation (Complete Today)

**Duration**: 2-3 hours  
**Owner**: Grolf 🪨

### Deliverables

- [x] `OBSERVABILITY_V2_SPEC.md` — complete design doc
- [x] `OBSERVABILITY_V2_ROADMAP.md` — this file
- [ ] `OBSERVABILITY_V2_DATA_CONTRACT.md` — data models + API contracts
- [ ] Feature flag setup: `VITE_FEATURE_OBS_V2=false` in `.env`
- [ ] Zustand stores scaffolded (empty implementations)
- [ ] Component placeholders created (no real UI yet)
- [ ] Route added to App.tsx: new tab "Observability v2 🔬"
- [ ] Mock data fixtures created

### File Checklist

```
✅ docs/OBSERVABILITY_V2_SPEC.md
✅ docs/OBSERVABILITY_V2_ROADMAP.md
⬜ docs/OBSERVABILITY_V2_DATA_CONTRACT.md

⬜ src/web/stores/observabilityV2/useObservabilityStore.ts
⬜ src/web/stores/observabilityV2/useDailySummaryStore.ts
⬜ src/web/stores/observabilityV2/usePriorityStore.ts

⬜ src/web/components/observability-v2/index.ts
⬜ src/web/components/observability-v2/InitiativeBubbleMap.tsx
⬜ src/web/components/observability-v2/DailySummaryPies.tsx
⬜ src/web/components/observability-v2/PriorityUpvotePanel.tsx
⬜ src/web/components/observability-v2/TradeoffWarningModal.tsx
⬜ src/web/components/observability-v2/ObservabilityV2View.tsx

⬜ src/web/fixtures/observabilityV2MockData.ts
```

### Success Criteria

- Feature flag toggles new tab visibility
- Tab renders "Coming soon" placeholder with wireframe
- No breaking changes to existing workstreams/agent-graph/events tabs
- `npm run dev` works without errors
- All TypeScript types compile

---

## Phase 1: MVP (1-2 Days)

**Duration**: 1-2 days  
**Owner**: Grolf 🪨 (with potential delegation to CodeWeaver/Architect agents)

### Goal

Ship **working UI** with **mock data** for all three features:
1. Initiative bubble map (static, no drill-down)
2. Daily pie charts (actual vs planned)
3. Priority upvote panel (no tradeoff warnings yet)

### Tasks

#### Day 1 Morning (4 hours)

**Bubble Map**:
- [ ] Install Recharts: `npm install recharts`
- [ ] Implement `InitiativeBubbleMap.tsx` with:
  - Recharts ScatterChart (bubbles)
  - Mock data from `observabilityV2MockData.ts`
  - Basic tooltip on hover
  - Filter controls: time range selector (7d/30d/all)
  - Anomaly badge (🚨) on bubbles where `isAnomaly === true`
- [ ] Wire up `useObservabilityStore`:
  - `fetchInitiatives()` loads mock data
  - `setTimeRange()` filters data client-side
  - `setAnomalyThreshold()` recomputes anomaly flags

**Tests**:
- [ ] Unit test: `useObservabilityStore` time range filter
- [ ] Snapshot test: `InitiativeBubbleMap` with 5 mock initiatives

#### Day 1 Afternoon (4 hours)

**Daily Pie Charts**:
- [ ] Implement `DailySummaryPies.tsx` with:
  - Two Recharts PieCharts side-by-side
  - Legend showing project name + delta (actual % - planned %)
  - "Sync" button (logs action, updates store)
- [ ] Wire up `useDailySummaryStore`:
  - `fetchDailySummary()` loads mock data
  - `syncPlannedFromActuals()` copies actuals to planned

**Tests**:
- [ ] Unit test: `useDailySummaryStore` sync logic
- [ ] Visual regression: Storybook story for pie charts

#### Day 2 Morning (4 hours)

**Priority Upvote Panel**:
- [ ] Implement `PriorityUpvotePanel.tsx` with:
  - List of initiatives sorted by `priorityScore`
  - Upvote/downvote buttons
  - Click upvote → log to console (no modal yet)
- [ ] Wire up `usePriorityStore`:
  - `fetchPriorities()` loads mock data
  - `upvote()` increments count, recalculates score
  - `downvote()` decrements count

**Tests**:
- [ ] Unit test: `usePriorityStore` upvote logic
- [ ] E2E test: Click upvote → score updates

#### Day 2 Afternoon (4 hours)

**Integration + Polish**:
- [ ] Add `ObservabilityV2View.tsx` container component
- [ ] Integrate all three components into view
- [ ] Add loading states (skeleton UI)
- [ ] Add error states (retry button)
- [ ] Mobile responsiveness: stack charts vertically on <768px
- [ ] Update App.tsx: new tab "Observability v2 🔬"
- [ ] Feature flag: only show tab if `import.meta.env.VITE_FEATURE_OBS_V2 === 'true'`

**Tests**:
- [ ] E2E test: Navigate to Observability v2 tab → all charts render

### Success Criteria

- All three charts render with mock data
- Upvote/downvote buttons work (client-side state only)
- Time range filter works on bubble map
- No console errors
- Mobile responsive (tested on iPhone 13 viewport)
- Feature flag controls tab visibility

---

## Phase 2: Real Data + Tradeoff Engine (1 Week)

**Duration**: 5 days  
**Owner**: TBD (likely delegated to backend-focused agent)

### Goal

Replace mock data with **real metrics** from Bloodbank events and implement **tradeoff warning** adversarial mode.

### Tasks

#### Backend Infrastructure (Days 1-2)

- [ ] Create PostgreSQL tables:
  - `initiatives` (id, name, project_id, target_milestone, created_at)
  - `initiative_metrics` (initiative_id, date, token_spend, progress_percent, velocity_score)
  - `priority_votes` (id, initiative_id, user_id, vote_type, created_at)
  - `priority_changes` (id, initiative_id, new_score, changed_by, tradeoffs_acknowledged, created_at)
- [ ] Create API endpoints (FastAPI or Express):
  - `GET /api/v2/initiatives` → query from `initiative_metrics`
  - `GET /api/v2/daily-summary` → aggregate today's token spend
  - `POST /api/v2/daily-summary/sync` → insert new planned baseline
  - `GET /api/v2/priorities` → list with vote counts
  - `POST /api/v2/priorities/:id/upvote` → calculate tradeoff warning
  - `POST /api/v2/priorities/:id/upvote/confirm` → apply priority change
- [ ] Bloodbank event consumers:
  - `agent.task.started` → track token spend
  - `agent.task.completed` → update velocity
  - `flume.task.progress` → update progress %
- [ ] Redis caching layer:
  - Cache daily summary (TTL: 1 hour)
  - Cache initiative metrics (TTL: 5 minutes)

#### Tradeoff Calculation Engine (Day 3)

- [ ] Implement `calculateTradeoffWarning()` service:
  - Input: `targetInitiativeId`, `currentPriorities[]`
  - Logic:
    1. Determine token reallocation (zero-sum game: total tokens fixed)
    2. Calculate impact on other initiatives (progressDelta, delayDays)
    3. Compute risk score based on dependency graph
  - Output: `TradeoffWarning` object
- [ ] Add dependency graph to initiative model (manual config for MVP, auto-detect later)

#### Frontend Integration (Days 4-5)

- [ ] Update Zustand stores to call real API endpoints (replace mock data)
- [ ] Implement `TradeoffWarningModal.tsx`:
  - Display impacts table
  - Show risk level badge
  - Confirmation buttons
- [ ] Wire up WebSocket for real-time priority updates
- [ ] Add optimistic UI updates (local state change before server confirmation)
- [ ] Add error handling + retry logic

#### Testing

- [ ] Integration tests: API endpoints with test database
- [ ] E2E test: Full upvote flow with tradeoff warning
- [ ] Load test: 100 initiatives, 10 concurrent upvotes

### Success Criteria

- All charts display real data from database
- Tradeoff warning modal appears on upvote
- Priority changes propagate to all connected clients via WebSocket
- No data races or stale state issues

---

## Phase 3: Enhancements (2 Weeks)

**Duration**: 10 days  
**Owner**: TBD

### Features

#### Week 1: Drill-Down + History

- [ ] Initiative detail view (click bubble → modal with:
  - Token spend trend (7d sparkline)
  - Active agents list
  - Task breakdown
  - Decision history
- [ ] Historical daily summaries:
  - Line chart showing actual vs planned over last 30 days
  - Anomaly detection: flag days with >20% deviation
- [ ] Export reports:
  - Daily summary → Markdown
  - Initiative metrics → CSV
  - Priority change log → PDF

#### Week 2: Predictive + Mobile

- [ ] Predictive anomaly detection:
  - ML model (simple linear regression or ARIMA) predicts next 3 days
  - Preemptive alerts: "Holocene projected to exceed budget by 15% in 2 days"
- [ ] Mobile app (React Native or PWA):
  - Push notifications for priority changes
  - Quick upvote action from notification
  - Simplified chart views (fewer data points)
- [ ] Slack/Discord integration:
  - Bot command: `/holocene priorities` → list top 5
  - Bot command: `/holocene upvote <initiative>` → trigger upvote
  - Daily summary posted at 9am ET

### Success Criteria

- Drill-down view provides actionable insights
- Historical trends help identify allocation patterns
- Mobile app has >70% feature parity with web
- Slack bot used by at least 3 team members

---

## Phase 4: Optimization (Ongoing)

### Performance Tuning

- [ ] Lazy load bubble chart (only render on tab activation)
- [ ] Virtualized list for priority panel (if >50 initiatives)
- [ ] Server-side pagination for historical data
- [ ] Database query optimization (indexed columns, materialized views)

### UX Refinements

- [ ] Animated transitions (bubbles growing/shrinking on data update)
- [ ] Drag-to-reorder priorities (alternative to upvote)
- [ ] Custom anomaly threshold per project
- [ ] Color palette customization (accessibility + branding)

### Security Hardening

- [ ] Rate limiting on upvote endpoint (10/day per user)
- [ ] Audit log retention policy (90 days)
- [ ] Role-based access control (PM/Director only for upvotes)

---

## Risk Mitigation

### Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Recharts performance issues with 50+ bubbles | High | Medium | Use pagination or switch to D3.js |
| Tradeoff calculation too slow (>2s latency) | Medium | Low | Pre-compute on priority change, cache results |
| WebSocket connection drops | Medium | Medium | Fallback to polling every 10s |
| Mock data doesn't match real schema | Low | High | Define data contract early (Phase 0) |

### Product Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Users ignore tradeoff warnings | High | Medium | A/B test: adversarial vs advisory tone |
| Too many upvotes → priority inflation | Medium | High | Cap upvotes per user per day |
| Anomaly threshold too sensitive → alert fatigue | Medium | Medium | Start with high threshold (2000 tokens), tune based on feedback |

---

## Dependencies

- **External**:
  - Recharts library (charts)
  - Bloodbank event stream (real data)
  - PostgreSQL + Redis (backend)
  - FastAPI or Express (backend API)
- **Internal**:
  - Plane API for task data (already integrated)
  - Agent execution logs (for token tracking)
  - Flume task progress events

---

## Rollout Plan

1. **Alpha** (Phase 1 complete):
   - Internal team only (Jarad + Grolf + 2 agents)
   - Feature flag: `VITE_FEATURE_OBS_V2=true` (manual env var)
2. **Beta** (Phase 2 complete):
   - All internal team members
   - Feature flag: user setting (opt-in via UI toggle)
3. **GA** (Phase 3 complete):
   - Default-on for all users
   - Feature flag: opt-out (for rollback safety)

---

## Success Metrics

### MVP (Phase 1)

- [ ] 3/3 charts render without errors
- [ ] <1s load time for Observability v2 tab
- [ ] 0 console errors in production build

### Real Data (Phase 2)

- [ ] 95%+ uptime for `/api/v2/*` endpoints
- [ ] <500ms P95 latency for tradeoff calculation
- [ ] 100% of priority changes logged to audit table

### Adoption (Phase 3)

- [ ] 5+ upvotes per week (team engagement)
- [ ] 3+ daily summary exports per week (utility)
- [ ] 0 reports of stale/incorrect data

---

## Next Steps (Immediate)

1. ✅ Finish `OBSERVABILITY_V2_SPEC.md`
2. ✅ Finish `OBSERVABILITY_V2_ROADMAP.md` (this file)
3. ⬜ Write `OBSERVABILITY_V2_DATA_CONTRACT.md`
4. ⬜ Scaffold Zustand stores + component files
5. ⬜ Add feature flag to `.env.example`
6. ⬜ Commit Phase 0 scaffolding
7. ⬜ Kick off Phase 1 MVP work

---

## Stakeholder Alignment

- **Jarad** (CEO): Needs visibility into token spend vs progress (bubble map) and daily accountability (pie chart)
- **Grolf** 🪨 (Director of Engineering): Needs adversarial priority management to prevent scope creep (upvote warnings)
- **Agents**: Need clear priority signals to optimize work allocation

**Communication plan**:
- Daily standup: 5-min demo of progress
- Phase 1 complete: Loom walkthrough + feedback session
- Phase 2 complete: Live demo with real data
- Phase 3 complete: Launch announcement + training doc

---

## Appendix: Alternative Approaches Considered

### Bubble Map Alternatives

1. **TreeMap** (rectangular boxes sized by token spend)
   - **Pros**: Easier to compare sizes, better space utilization
   - **Cons**: Harder to show 2D positioning (progress vs velocity)
   - **Decision**: Rejected — bubble map more intuitive for multi-dimensional data

2. **Bar Chart** (horizontal bars for each initiative)
   - **Pros**: Simple, accessible, works on mobile
   - **Cons**: Can't show multiple dimensions simultaneously
   - **Decision**: Rejected — too limiting for complex analysis

### Priority System Alternatives

1. **Drag-and-drop reordering** (no upvotes, just manual sorting)
   - **Pros**: Direct control, no voting dynamics
   - **Cons**: Doesn't track team sentiment, no adversarial feedback
   - **Decision**: Consider for Phase 4 as alternative mode

2. **Weighted scoring** (assign weights to multiple criteria)
   - **Pros**: More nuanced than upvotes
   - **Cons**: Cognitive overhead, harder to explain
   - **Decision**: Rejected for MVP — upvotes simpler, can add weights later

---

**End of Roadmap**
