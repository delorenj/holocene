# Holocene Observability v2 Specification

> **Author**: Grolf 🪨, Director of Engineering  
> **Date**: 2026-02-20  
> **Status**: Design / Pre-Implementation  
> **Feature Flag**: `VITE_FEATURE_OBS_V2` (default: `false`)

---

## Overview

Holocene Observability v2 introduces **initiative-level visibility**, **daily accountability**, and **adversarial priority management** to give Jarad and the team clear insight into:

1. **Where tokens are going** vs. **where progress is happening**
2. **Per-project contribution** against planned work
3. **Tradeoff warnings** when upvoting priorities (adversarial mode, not blind reprioritization)

These features prioritize **monetization urgency** and **autonomy** by surfacing high-spend/low-progress anomalies and forcing honest conversations about resource allocation.

---

## Feature 1: Initiative Bubble Map 🫧

### Purpose
Visual representation of all active initiatives/projects sized by token spend, colored by project identity, with progress indicators and anomaly callouts.

### UX Behavior

**Visual Layout**:
- **Bubble chart** (D3.js or Recharts bubble chart)
- **X-axis**: Progress % against sprint/MVP target (0-100%)
- **Y-axis**: Velocity score (commits, task completions, event throughput)
- **Bubble size**: Total token spend (last 7 days)
- **Bubble color**: Project identity color (consistent with existing project palette)
- **Callout badges**: 🚨 High-token low-progress anomaly when `tokenSpend > threshold && progress < 20%`

**Interaction**:
- **Hover**: Tooltip shows:
  - Project name
  - Token spend (7d, 30d)
  - Progress % vs target
  - Active agents
  - Last activity timestamp
- **Click**: Drill into project detail view (Phase 2)
- **Filter controls** (top bar):
  - Time range: 7d / 30d / all-time
  - Show/hide completed initiatives
  - Anomaly threshold slider

**State Management**:
- Zustand store: `useObservabilityStore`
  - `initiatives: Initiative[]`
  - `timeRange: '7d' | '30d' | 'all'`
  - `anomalyThreshold: number` (default: 1000 tokens)
  - `showCompleted: boolean`

### Data Model

```typescript
interface Initiative {
  id: string;
  name: string;
  projectId: string;
  projectColor: string; // hex color
  
  // Metrics
  tokenSpend7d: number;
  tokenSpend30d: number;
  progressPercent: number; // 0-100
  velocityScore: number; // computed
  
  // Meta
  targetMilestone: 'sprint' | 'mvp' | 'launch';
  activeAgentIds: string[];
  lastActivityAt: string; // ISO 8601
  
  // Anomaly detection
  isAnomaly: boolean; // computed
  anomalyReason?: string;
}
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/initiatives` | GET | List all initiatives with metrics |
| `/api/v2/initiatives/:id/metrics` | GET | Detailed metrics for one initiative |

**Example Response** (`/api/v2/initiatives`):

```json
{
  "initiatives": [
    {
      "id": "init-001",
      "name": "Holocene Observability v2",
      "projectId": "proj-holocene",
      "projectColor": "#10b981",
      "tokenSpend7d": 45000,
      "tokenSpend30d": 120000,
      "progressPercent": 15,
      "velocityScore": 32,
      "targetMilestone": "mvp",
      "activeAgentIds": ["agent-grolf"],
      "lastActivityAt": "2026-02-20T16:55:00Z",
      "isAnomaly": true,
      "anomalyReason": "High token spend (45k) with <20% progress"
    }
  ]
}
```

---

## Feature 2: Daily Pie Chart 🥧

### Purpose
Show **per-project token contribution** today vs. **planned work distribution** to surface allocation drift.

### UX Behavior

**Visual Layout**:
- **Two pie charts** side-by-side (mobile: stacked):
  - Left: **Actual token spend today** (per project)
  - Right: **Planned work distribution** (from sprint planning or backlog weights)
- **Legend** below showing:
  - Project name
  - Actual % | Planned %
  - Delta (red if actual > planned + 10%, green if within ±10%, amber otherwise)

**Interaction**:
- **Hover segment**: Tooltip shows project name, token count, percentage
- **Click segment**: Filter initiative map to that project
- **Sync button** (top-right): "Update planned from current actuals" (captures current state as new baseline)

**State Management**:
- Zustand store: `useDailySummaryStore`
  - `dailyActuals: ProjectTokens[]`
  - `plannedDistribution: ProjectTokens[]`
  - `lastSyncedAt: string`

### Data Model

```typescript
interface ProjectTokens {
  projectId: string;
  projectName: string;
  projectColor: string;
  tokenCount: number;
  percentage: number; // 0-100
}

interface DailySummary {
  date: string; // YYYY-MM-DD
  actuals: ProjectTokens[];
  planned: ProjectTokens[];
  deltas: {
    projectId: string;
    delta: number; // actual % - planned %
    severity: 'ok' | 'warning' | 'critical';
  }[];
}
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/daily-summary` | GET | Today's actual vs planned |
| `/api/v2/daily-summary/sync` | POST | Capture current actuals as new baseline |
| `/api/v2/daily-summary/history` | GET | Historical daily summaries (for trends) |

**Example Response** (`/api/v2/daily-summary`):

```json
{
  "date": "2026-02-20",
  "actuals": [
    {
      "projectId": "proj-holocene",
      "projectName": "Holocene",
      "projectColor": "#10b981",
      "tokenCount": 12000,
      "percentage": 35.3
    },
    {
      "projectId": "proj-bloodbank",
      "projectName": "Bloodbank",
      "projectColor": "#ef4444",
      "tokenCount": 8000,
      "percentage": 23.5
    }
  ],
  "planned": [
    {
      "projectId": "proj-holocene",
      "projectName": "Holocene",
      "projectColor": "#10b981",
      "tokenCount": 10000,
      "percentage": 40.0
    },
    {
      "projectId": "proj-bloodbank",
      "projectName": "Bloodbank",
      "projectColor": "#ef4444",
      "tokenCount": 5000,
      "percentage": 20.0
    }
  ],
  "deltas": [
    {
      "projectId": "proj-holocene",
      "delta": -4.7,
      "severity": "ok"
    },
    {
      "projectId": "proj-bloodbank",
      "delta": 3.5,
      "severity": "ok"
    }
  ]
}
```

---

## Feature 3: Priority Upvote Controls ⬆️

### Purpose
Allow users to **upvote urgency** on initiatives/tasks while surfacing **tradeoff warnings** to prevent blind reprioritization. Adversarial mode: system pushes back with cost/impact analysis.

### UX Behavior

**Visual Layout**:
- **Priority control panel** (right sidebar or bottom drawer):
  - List of all active initiatives sorted by current priority score
  - Each row shows:
    - Initiative name
    - Current priority score (0-100)
    - Upvote button (👍) with count
    - Downvote button (👎) with count
  - **Tradeoff warning modal** appears when upvoting:
    - "Upvoting {initiative} will deprioritize {other initiatives}"
    - Shows token reallocation impact
    - Requires confirmation: "Yes, shift focus" or "Cancel"

**Interaction Flow**:
1. User clicks upvote on "Bloodbank Event Refactor"
2. System calculates:
   - Required token reallocation (e.g., -5000 from Holocene)
   - Impact on other initiatives' velocity
   - Risk score (based on dependencies)
3. Modal displays:
   ```
   ⚠️ Upvoting "Bloodbank Event Refactor" will:
   - Shift 5,000 tokens/day from Holocene (-12% progress)
   - Delay Holocene MVP by ~2 days
   - Risk: Medium (Holocene has 3 dependent initiatives)
   
   Continue?
   [Cancel] [Yes, shift focus]
   ```
4. If confirmed, priority score updates and system logs the decision
5. All agents receive priority update via Bloodbank event

**State Management**:
- Zustand store: `usePriorityStore`
  - `priorities: InitiativePriority[]`
  - `upvotePending: string | null` (initiative ID)
  - `tradeoffWarning: TradeoffWarning | null`

### Data Model

```typescript
interface InitiativePriority {
  initiativeId: string;
  initiativeName: string;
  priorityScore: number; // 0-100, computed from upvotes + system metrics
  upvotes: number;
  downvotes: number;
  lastUpvotedAt: string | null;
  lastUpvotedBy: string | null;
}

interface TradeoffWarning {
  targetInitiativeId: string;
  targetInitiativeName: string;
  
  impacts: {
    initiativeId: string;
    initiativeName: string;
    tokenDelta: number; // negative = loses tokens
    progressDelta: number; // percentage points
    delayDays: number;
  }[];
  
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
}

interface UpvoteRequest {
  initiativeId: string;
  userId: string;
  acknowledgedTradeoffs: boolean;
}
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/priorities` | GET | List all initiative priorities |
| `/api/v2/priorities/:id/upvote` | POST | Upvote an initiative (returns tradeoff warning) |
| `/api/v2/priorities/:id/downvote` | POST | Downvote an initiative |
| `/api/v2/priorities/:id/upvote/confirm` | POST | Confirm upvote after acknowledging tradeoffs |

**Example Request** (`/api/v2/priorities/:id/upvote`):

```bash
POST /api/v2/priorities/init-002/upvote
{
  "userId": "user-jarad"
}
```

**Example Response** (tradeoff warning):

```json
{
  "requiresConfirmation": true,
  "tradeoffWarning": {
    "targetInitiativeId": "init-002",
    "targetInitiativeName": "Bloodbank Event Refactor",
    "impacts": [
      {
        "initiativeId": "init-001",
        "initiativeName": "Holocene Observability v2",
        "tokenDelta": -5000,
        "progressDelta": -12,
        "delayDays": 2
      }
    ],
    "riskLevel": "medium",
    "riskReason": "Holocene has 3 dependent initiatives"
  }
}
```

**Confirm Request** (`/api/v2/priorities/:id/upvote/confirm`):

```bash
POST /api/v2/priorities/init-002/upvote/confirm
{
  "userId": "user-jarad",
  "acknowledgedTradeoffs": true
}
```

---

## State Management Architecture

### Zustand Stores

**`useObservabilityStore`** (Initiative Map):

```typescript
interface ObservabilityStore {
  // State
  initiatives: Initiative[];
  timeRange: '7d' | '30d' | 'all';
  anomalyThreshold: number;
  showCompleted: boolean;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  fetchInitiatives: () => Promise<void>;
  setTimeRange: (range: '7d' | '30d' | 'all') => void;
  setAnomalyThreshold: (threshold: number) => void;
  toggleShowCompleted: () => void;
}
```

**`useDailySummaryStore`** (Daily Pie Chart):

```typescript
interface DailySummaryStore {
  // State
  summary: DailySummary | null;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  fetchDailySummary: () => Promise<void>;
  syncPlannedFromActuals: () => Promise<void>;
}
```

**`usePriorityStore`** (Priority Upvote):

```typescript
interface PriorityStore {
  // State
  priorities: InitiativePriority[];
  upvotePending: string | null;
  tradeoffWarning: TradeoffWarning | null;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  fetchPriorities: () => Promise<void>;
  upvote: (initiativeId: string, userId: string) => Promise<void>;
  confirmUpvote: (initiativeId: string, userId: string) => Promise<void>;
  cancelUpvote: () => void;
  downvote: (initiativeId: string, userId: string) => Promise<void>;
}
```

---

## Component Architecture

### File Structure

```
src/web/
├── components/
│   └── observability-v2/
│       ├── index.ts
│       ├── InitiativeBubbleMap.tsx
│       ├── DailySummaryPies.tsx
│       ├── PriorityUpvotePanel.tsx
│       ├── TradeoffWarningModal.tsx
│       └── atoms/
│           ├── BubbleChartTooltip.tsx
│           ├── PieChartLegend.tsx
│           └── PriorityRow.tsx
├── stores/
│   └── observabilityV2/
│       ├── useObservabilityStore.ts
│       ├── useDailySummaryStore.ts
│       └── usePriorityStore.ts
└── App.tsx (add new tab: 'observability-v2')
```

### Component Hierarchy

```
ObservabilityV2View
├── InitiativeBubbleMap
│   ├── FilterControls
│   ├── BubbleChart (D3 / Recharts)
│   └── BubbleChartTooltip
├── DailySummaryPies
│   ├── PieChart (Actual)
│   ├── PieChart (Planned)
│   └── PieChartLegend
└── PriorityUpvotePanel
    ├── PriorityRow (repeated)
    └── TradeoffWarningModal
```

---

## Backend Data Flow

### Event Integration (Bloodbank)

**Events Consumed**:
- `agent.task.started` → track token spend
- `agent.task.completed` → calculate velocity
- `flume.task.progress` → update progress %
- `imi.commit.*` → velocity score input

**Events Emitted**:
- `holocene.priority.updated` → notify all agents of priority change
  ```json
  {
    "initiativeId": "init-002",
    "newPriorityScore": 87,
    "upvotedBy": "user-jarad",
    "tradeoffsAcknowledged": true,
    "impactedInitiatives": ["init-001"]
  }
  ```

### Metrics Calculation

**Token Spend** (per initiative):
- Source: Agent task execution logs (OpenRouter, Anthropic API calls)
- Aggregation: Sum by initiative ID, grouped by time range
- Storage: Redis cache (hot path) + PostgreSQL (historical)

**Progress Percent**:
- Source: Flume task completion % or sprint milestone tracking
- Formula: `(completed_tasks / total_tasks) * 100`

**Velocity Score**:
- Formula: `(commits_7d * 2) + (tasks_completed_7d * 5) + (events_7d * 0.1)`
- Weighted to prioritize task completion over raw activity

**Anomaly Detection**:
- Threshold: `tokenSpend7d > anomalyThreshold && progressPercent < 20`
- Configurable via UI slider

---

## Security & Permissions

- **Role-based access**: Only PMs/Directors can upvote/downvote
- **Audit log**: All priority changes logged to `priority_changes` table
- **Rate limiting**: Max 10 upvotes per user per day

---

## Performance Considerations

- **Bubble chart**: Limit to 50 initiatives, paginate if > 50
- **Real-time updates**: WebSocket stream for priority changes
- **Caching**: Redis for daily summary (TTL: 1 hour)
- **Query optimization**: Indexed queries on `initiative_id`, `project_id`, `created_at`

---

## Testing Strategy

- **Unit tests**: All Zustand stores, metric calculation functions
- **Integration tests**: API endpoints with mock data
- **E2E tests**: Full upvote → tradeoff warning → confirm flow
- **Visual regression**: Storybook snapshots for charts

---

## Accessibility

- **Keyboard navigation**: Tab through initiatives, Enter to upvote
- **Screen readers**: ARIA labels on all charts, announce tradeoff warnings
- **Color blindness**: Patterns/textures in addition to color for anomalies
- **High contrast mode**: Ensure 4.5:1 contrast ratio

---

## Migration Path

1. **Phase 1** (MVP, 1-2 days):
   - Mock data endpoints
   - Static bubble chart (no drill-down)
   - Basic pie charts
   - Priority upvote without tradeoff warnings
2. **Phase 2** (1 week):
   - Real data from Bloodbank events
   - Tradeoff calculation engine
   - Drill-down to initiative detail
3. **Phase 3** (2 weeks):
   - Historical trend views
   - Predictive anomaly detection
   - Mobile-optimized layouts

---

## Open Questions

1. **Q**: Should tradeoff warnings be opt-out (always show) or opt-in (user setting)?  
   **A**: TBD — default to always-show for adversarial mode, add setting later.

2. **Q**: How to handle multi-agent initiatives (shared token pool)?  
   **A**: TBD — aggregate by initiative, not by agent.

3. **Q**: Should downvotes have the same tradeoff warning?  
   **A**: No — downvoting is less risky, just log the action.

---

## References

- GOD doc: `/home/delorenj/code/33GOD/holocene/GOD.md`
- Roadmap: `/home/delorenj/code/33GOD/holocene/docs/OBSERVABILITY_V2_ROADMAP.md`
- Data contract: `/home/delorenj/code/33GOD/holocene/docs/OBSERVABILITY_V2_DATA_CONTRACT.md`
