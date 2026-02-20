# Holocene Observability v2 Data Contract

> **Author**: Grolf 🪨, Director of Engineering  
> **Date**: 2026-02-20  
> **Purpose**: Canonical data models and API contracts for Observability v2

---

## TypeScript Interfaces

### Domain Models

```typescript
/**
 * Initiative: A project or major work stream with measurable progress
 */
export interface Initiative {
  id: string; // UUID
  name: string; // Human-readable name
  projectId: string; // Foreign key to Project
  projectColor: string; // Hex color (e.g., "#10b981")
  
  // Metrics
  tokenSpend7d: number; // Token count last 7 days
  tokenSpend30d: number; // Token count last 30 days
  progressPercent: number; // 0-100
  velocityScore: number; // Computed: (commits * 2) + (tasks * 5) + (events * 0.1)
  
  // Meta
  targetMilestone: 'sprint' | 'mvp' | 'launch';
  activeAgentIds: string[]; // Currently assigned agents
  lastActivityAt: string; // ISO 8601 timestamp
  
  // Anomaly detection
  isAnomaly: boolean; // Computed: tokenSpend7d > threshold && progressPercent < 20
  anomalyReason?: string; // Optional explanation
}

/**
 * ProjectTokens: Token spend breakdown by project
 */
export interface ProjectTokens {
  projectId: string;
  projectName: string;
  projectColor: string; // Hex color
  tokenCount: number; // Absolute count
  percentage: number; // 0-100
}

/**
 * DailySummary: Actual vs planned token distribution for a given date
 */
export interface DailySummary {
  date: string; // YYYY-MM-DD
  actuals: ProjectTokens[];
  planned: ProjectTokens[];
  deltas: {
    projectId: string;
    delta: number; // actual % - planned %
    severity: 'ok' | 'warning' | 'critical';
  }[];
}

/**
 * InitiativePriority: Priority ranking with upvote/downvote tracking
 */
export interface InitiativePriority {
  initiativeId: string;
  initiativeName: string;
  priorityScore: number; // 0-100, computed from upvotes + system metrics
  upvotes: number; // Total upvote count
  downvotes: number; // Total downvote count
  lastUpvotedAt: string | null; // ISO 8601 or null
  lastUpvotedBy: string | null; // User ID or null
}

/**
 * TradeoffWarning: Impact analysis when upvoting a priority
 */
export interface TradeoffWarning {
  targetInitiativeId: string;
  targetInitiativeName: string;
  
  impacts: {
    initiativeId: string;
    initiativeName: string;
    tokenDelta: number; // Negative = loses tokens
    progressDelta: number; // Percentage points
    delayDays: number; // Estimated delay
  }[];
  
  riskLevel: 'low' | 'medium' | 'high';
  riskReason: string;
}
```

### Request/Response Types

```typescript
/**
 * GET /api/v2/initiatives response
 */
export interface GetInitiativesResponse {
  initiatives: Initiative[];
}

/**
 * GET /api/v2/initiatives/:id/metrics response
 */
export interface GetInitiativeMetricsResponse {
  initiative: Initiative;
  tokenSpendHistory: {
    date: string; // YYYY-MM-DD
    tokenCount: number;
  }[];
  progressHistory: {
    date: string;
    progressPercent: number;
  }[];
}

/**
 * GET /api/v2/daily-summary response
 */
export interface GetDailySummaryResponse extends DailySummary {}

/**
 * POST /api/v2/daily-summary/sync request
 */
export interface SyncDailySummaryRequest {
  // Empty body — uses current actuals as new baseline
}

/**
 * POST /api/v2/daily-summary/sync response
 */
export interface SyncDailySummaryResponse {
  success: boolean;
  newBaseline: ProjectTokens[];
  syncedAt: string; // ISO 8601
}

/**
 * GET /api/v2/daily-summary/history response
 */
export interface GetDailySummaryHistoryResponse {
  summaries: DailySummary[];
}

/**
 * GET /api/v2/priorities response
 */
export interface GetPrioritiesResponse {
  priorities: InitiativePriority[];
}

/**
 * POST /api/v2/priorities/:id/upvote request
 */
export interface UpvoteRequest {
  userId: string;
}

/**
 * POST /api/v2/priorities/:id/upvote response
 */
export interface UpvoteResponse {
  requiresConfirmation: boolean;
  tradeoffWarning?: TradeoffWarning;
}

/**
 * POST /api/v2/priorities/:id/upvote/confirm request
 */
export interface ConfirmUpvoteRequest {
  userId: string;
  acknowledgedTradeoffs: boolean; // Must be true
}

/**
 * POST /api/v2/priorities/:id/upvote/confirm response
 */
export interface ConfirmUpvoteResponse {
  success: boolean;
  newPriority: InitiativePriority;
}

/**
 * POST /api/v2/priorities/:id/downvote request
 */
export interface DownvoteRequest {
  userId: string;
}

/**
 * POST /api/v2/priorities/:id/downvote response
 */
export interface DownvoteResponse {
  success: boolean;
  newPriority: InitiativePriority;
}
```

---

## API Endpoints

### Base URL

```
http://localhost:3000/api/v2
```

### Endpoints

#### Initiatives

**`GET /initiatives`**

List all initiatives with metrics.

**Query Parameters**:
- `timeRange` (optional): `7d` | `30d` | `all` (default: `7d`)
- `showCompleted` (optional): `true` | `false` (default: `false`)

**Response**: `200 OK`

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

**`GET /initiatives/:id/metrics`**

Get detailed metrics for one initiative.

**Response**: `200 OK`

```json
{
  "initiative": {
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
  },
  "tokenSpendHistory": [
    { "date": "2026-02-20", "tokenCount": 12000 },
    { "date": "2026-02-19", "tokenCount": 15000 },
    { "date": "2026-02-18", "tokenCount": 18000 }
  ],
  "progressHistory": [
    { "date": "2026-02-20", "progressPercent": 15 },
    { "date": "2026-02-19", "progressPercent": 12 },
    { "date": "2026-02-18", "progressPercent": 8 }
  ]
}
```

#### Daily Summary

**`GET /daily-summary`**

Get today's actual vs planned token distribution.

**Query Parameters**:
- `date` (optional): `YYYY-MM-DD` (default: today)

**Response**: `200 OK`

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

**`POST /daily-summary/sync`**

Capture current actuals as new planned baseline.

**Request**: Empty body

**Response**: `200 OK`

```json
{
  "success": true,
  "newBaseline": [
    {
      "projectId": "proj-holocene",
      "projectName": "Holocene",
      "projectColor": "#10b981",
      "tokenCount": 12000,
      "percentage": 35.3
    }
  ],
  "syncedAt": "2026-02-20T16:55:00Z"
}
```

**`GET /daily-summary/history`**

Get historical daily summaries.

**Query Parameters**:
- `days` (optional): Number of days to retrieve (default: 30)

**Response**: `200 OK`

```json
{
  "summaries": [
    {
      "date": "2026-02-20",
      "actuals": [...],
      "planned": [...],
      "deltas": [...]
    },
    {
      "date": "2026-02-19",
      "actuals": [...],
      "planned": [...],
      "deltas": [...]
    }
  ]
}
```

#### Priorities

**`GET /priorities`**

List all initiative priorities sorted by score.

**Response**: `200 OK`

```json
{
  "priorities": [
    {
      "initiativeId": "init-002",
      "initiativeName": "Bloodbank Event Refactor",
      "priorityScore": 87,
      "upvotes": 5,
      "downvotes": 1,
      "lastUpvotedAt": "2026-02-20T14:30:00Z",
      "lastUpvotedBy": "user-jarad"
    },
    {
      "initiativeId": "init-001",
      "initiativeName": "Holocene Observability v2",
      "priorityScore": 72,
      "upvotes": 3,
      "downvotes": 0,
      "lastUpvotedAt": "2026-02-19T10:15:00Z",
      "lastUpvotedBy": "user-grolf"
    }
  ]
}
```

**`POST /priorities/:id/upvote`**

Upvote an initiative (returns tradeoff warning if applicable).

**Request**:

```json
{
  "userId": "user-jarad"
}
```

**Response**: `200 OK`

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

**`POST /priorities/:id/upvote/confirm`**

Confirm upvote after acknowledging tradeoffs.

**Request**:

```json
{
  "userId": "user-jarad",
  "acknowledgedTradeoffs": true
}
```

**Response**: `200 OK`

```json
{
  "success": true,
  "newPriority": {
    "initiativeId": "init-002",
    "initiativeName": "Bloodbank Event Refactor",
    "priorityScore": 92,
    "upvotes": 6,
    "downvotes": 1,
    "lastUpvotedAt": "2026-02-20T16:55:00Z",
    "lastUpvotedBy": "user-jarad"
  }
}
```

**`POST /priorities/:id/downvote`**

Downvote an initiative (no tradeoff warning).

**Request**:

```json
{
  "userId": "user-jarad"
}
```

**Response**: `200 OK`

```json
{
  "success": true,
  "newPriority": {
    "initiativeId": "init-002",
    "initiativeName": "Bloodbank Event Refactor",
    "priorityScore": 82,
    "upvotes": 5,
    "downvotes": 2,
    "lastUpvotedAt": "2026-02-20T14:30:00Z",
    "lastUpvotedBy": "user-jarad"
  }
}
```

---

## Database Schema (PostgreSQL)

### Tables

#### `initiatives`

```sql
CREATE TABLE initiatives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id),
  target_milestone TEXT CHECK (target_milestone IN ('sprint', 'mvp', 'launch')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_initiatives_project_id ON initiatives(project_id);
```

#### `initiative_metrics`

```sql
CREATE TABLE initiative_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id UUID NOT NULL REFERENCES initiatives(id),
  date DATE NOT NULL,
  token_spend INT NOT NULL DEFAULT 0,
  progress_percent INT CHECK (progress_percent >= 0 AND progress_percent <= 100),
  velocity_score INT NOT NULL DEFAULT 0,
  active_agent_ids TEXT[] NOT NULL DEFAULT '{}',
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_initiative_metrics_unique ON initiative_metrics(initiative_id, date);
CREATE INDEX idx_initiative_metrics_date ON initiative_metrics(date);
```

#### `planned_distributions`

```sql
CREATE TABLE planned_distributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  project_id UUID NOT NULL REFERENCES projects(id),
  token_count INT NOT NULL DEFAULT 0,
  percentage DECIMAL(5, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_planned_distributions_unique ON planned_distributions(date, project_id);
```

#### `priority_votes`

```sql
CREATE TABLE priority_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id UUID NOT NULL REFERENCES initiatives(id),
  user_id TEXT NOT NULL,
  vote_type TEXT CHECK (vote_type IN ('upvote', 'downvote')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_priority_votes_initiative ON priority_votes(initiative_id);
CREATE INDEX idx_priority_votes_user ON priority_votes(user_id);
```

#### `priority_changes`

```sql
CREATE TABLE priority_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiative_id UUID NOT NULL REFERENCES initiatives(id),
  new_priority_score INT NOT NULL,
  changed_by TEXT NOT NULL,
  tradeoffs_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  impacted_initiatives UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_priority_changes_initiative ON priority_changes(initiative_id);
CREATE INDEX idx_priority_changes_created_at ON priority_changes(created_at);
```

---

## Bloodbank Event Contracts

### Events Consumed

#### `agent.task.started`

```json
{
  "eventType": "agent.task.started",
  "agentId": "agent-grolf",
  "taskId": "task-123",
  "initiativeId": "init-001",
  "estimatedTokens": 5000,
  "timestamp": "2026-02-20T16:55:00Z"
}
```

**Handler**: Increment `initiative_metrics.token_spend` (estimated)

#### `agent.task.completed`

```json
{
  "eventType": "agent.task.completed",
  "agentId": "agent-grolf",
  "taskId": "task-123",
  "initiativeId": "init-001",
  "actualTokens": 4800,
  "timestamp": "2026-02-20T17:30:00Z"
}
```

**Handler**: Adjust `initiative_metrics.token_spend` (replace estimate with actual), update `velocity_score`

#### `flume.task.progress`

```json
{
  "eventType": "flume.task.progress",
  "taskId": "task-123",
  "initiativeId": "init-001",
  "progressPercent": 25,
  "timestamp": "2026-02-20T17:00:00Z"
}
```

**Handler**: Update `initiative_metrics.progress_percent`

#### `imi.commit.pushed`

```json
{
  "eventType": "imi.commit.pushed",
  "repoId": "repo-holocene",
  "commitSha": "abc123",
  "initiativeId": "init-001",
  "timestamp": "2026-02-20T17:15:00Z"
}
```

**Handler**: Increment `velocity_score` (commits * 2)

### Events Emitted

#### `holocene.priority.updated`

```json
{
  "eventType": "holocene.priority.updated",
  "initiativeId": "init-002",
  "newPriorityScore": 87,
  "upvotedBy": "user-jarad",
  "tradeoffsAcknowledged": true,
  "impactedInitiatives": ["init-001"],
  "timestamp": "2026-02-20T16:55:00Z"
}
```

**Routing Key**: `holocene.priority.updated`

**Consumers**: All agents (to reprioritize task queues)

---

## Mock Data (for Phase 1 MVP)

### `observabilityV2MockData.ts`

```typescript
import type { Initiative, DailySummary, InitiativePriority } from './types';

export const mockInitiatives: Initiative[] = [
  {
    id: 'init-001',
    name: 'Holocene Observability v2',
    projectId: 'proj-holocene',
    projectColor: '#10b981',
    tokenSpend7d: 45000,
    tokenSpend30d: 120000,
    progressPercent: 15,
    velocityScore: 32,
    targetMilestone: 'mvp',
    activeAgentIds: ['agent-grolf'],
    lastActivityAt: '2026-02-20T16:55:00Z',
    isAnomaly: true,
    anomalyReason: 'High token spend (45k) with <20% progress',
  },
  {
    id: 'init-002',
    name: 'Bloodbank Event Refactor',
    projectId: 'proj-bloodbank',
    projectColor: '#ef4444',
    tokenSpend7d: 28000,
    tokenSpend30d: 85000,
    progressPercent: 65,
    velocityScore: 78,
    targetMilestone: 'sprint',
    activeAgentIds: ['agent-architect', 'agent-codeweaver'],
    lastActivityAt: '2026-02-20T15:30:00Z',
    isAnomaly: false,
  },
  {
    id: 'init-003',
    name: 'iMi Worktree Optimization',
    projectId: 'proj-imi',
    projectColor: '#3b82f6',
    tokenSpend7d: 12000,
    tokenSpend30d: 35000,
    progressPercent: 42,
    velocityScore: 55,
    targetMilestone: 'mvp',
    activeAgentIds: ['agent-optimizer'],
    lastActivityAt: '2026-02-20T14:00:00Z',
    isAnomaly: false,
  },
  {
    id: 'init-004',
    name: 'Perth API v2',
    projectId: 'proj-perth',
    projectColor: '#f59e0b',
    tokenSpend7d: 35000,
    tokenSpend30d: 95000,
    progressPercent: 18,
    velocityScore: 28,
    targetMilestone: 'mvp',
    activeAgentIds: ['agent-api-builder'],
    lastActivityAt: '2026-02-20T13:00:00Z',
    isAnomaly: true,
    anomalyReason: 'High token spend (35k) with <20% progress',
  },
  {
    id: 'init-005',
    name: 'HeyMa Voice Commands',
    projectId: 'proj-heyma',
    projectColor: '#8b5cf6',
    tokenSpend7d: 8000,
    tokenSpend30d: 22000,
    progressPercent: 88,
    velocityScore: 92,
    targetMilestone: 'launch',
    activeAgentIds: ['agent-voice'],
    lastActivityAt: '2026-02-20T12:00:00Z',
    isAnomaly: false,
  },
];

export const mockDailySummary: DailySummary = {
  date: '2026-02-20',
  actuals: [
    {
      projectId: 'proj-holocene',
      projectName: 'Holocene',
      projectColor: '#10b981',
      tokenCount: 12000,
      percentage: 35.3,
    },
    {
      projectId: 'proj-bloodbank',
      projectName: 'Bloodbank',
      projectColor: '#ef4444',
      tokenCount: 8000,
      percentage: 23.5,
    },
    {
      projectId: 'proj-imi',
      projectName: 'iMi',
      projectColor: '#3b82f6',
      tokenCount: 5000,
      percentage: 14.7,
    },
    {
      projectId: 'proj-perth',
      projectName: 'Perth',
      projectColor: '#f59e0b',
      tokenCount: 7000,
      percentage: 20.6,
    },
    {
      projectId: 'proj-heyma',
      projectName: 'HeyMa',
      projectColor: '#8b5cf6',
      tokenCount: 2000,
      percentage: 5.9,
    },
  ],
  planned: [
    {
      projectId: 'proj-holocene',
      projectName: 'Holocene',
      projectColor: '#10b981',
      tokenCount: 10000,
      percentage: 40.0,
    },
    {
      projectId: 'proj-bloodbank',
      projectName: 'Bloodbank',
      projectColor: '#ef4444',
      tokenCount: 5000,
      percentage: 20.0,
    },
    {
      projectId: 'proj-imi',
      projectName: 'iMi',
      projectColor: '#3b82f6',
      tokenCount: 4000,
      percentage: 16.0,
    },
    {
      projectId: 'proj-perth',
      projectName: 'Perth',
      projectColor: '#f59e0b',
      tokenCount: 4000,
      percentage: 16.0,
    },
    {
      projectId: 'proj-heyma',
      projectName: 'HeyMa',
      projectColor: '#8b5cf6',
      tokenCount: 2000,
      percentage: 8.0,
    },
  ],
  deltas: [
    { projectId: 'proj-holocene', delta: -4.7, severity: 'ok' },
    { projectId: 'proj-bloodbank', delta: 3.5, severity: 'ok' },
    { projectId: 'proj-imi', delta: -1.3, severity: 'ok' },
    { projectId: 'proj-perth', delta: 4.6, severity: 'ok' },
    { projectId: 'proj-heyma', delta: -2.1, severity: 'ok' },
  ],
};

export const mockPriorities: InitiativePriority[] = [
  {
    initiativeId: 'init-002',
    initiativeName: 'Bloodbank Event Refactor',
    priorityScore: 87,
    upvotes: 5,
    downvotes: 1,
    lastUpvotedAt: '2026-02-20T14:30:00Z',
    lastUpvotedBy: 'user-jarad',
  },
  {
    initiativeId: 'init-005',
    initiativeName: 'HeyMa Voice Commands',
    priorityScore: 82,
    upvotes: 4,
    downvotes: 0,
    lastUpvotedAt: '2026-02-20T13:00:00Z',
    lastUpvotedBy: 'user-grolf',
  },
  {
    initiativeId: 'init-001',
    initiativeName: 'Holocene Observability v2',
    priorityScore: 72,
    upvotes: 3,
    downvotes: 0,
    lastUpvotedAt: '2026-02-19T10:15:00Z',
    lastUpvotedBy: 'user-grolf',
  },
  {
    initiativeId: 'init-003',
    initiativeName: 'iMi Worktree Optimization',
    priorityScore: 65,
    upvotes: 2,
    downvotes: 1,
    lastUpvotedAt: '2026-02-18T16:00:00Z',
    lastUpvotedBy: 'user-jarad',
  },
  {
    initiativeId: 'init-004',
    initiativeName: 'Perth API v2',
    priorityScore: 58,
    upvotes: 2,
    downvotes: 2,
    lastUpvotedAt: '2026-02-17T12:00:00Z',
    lastUpvotedBy: 'user-architect',
  },
];
```

---

## Validation Rules

### Initiative

- `name`: 1-100 characters, required
- `progressPercent`: 0-100, integer
- `tokenSpend7d`, `tokenSpend30d`: >= 0
- `velocityScore`: >= 0
- `targetMilestone`: enum
- `lastActivityAt`: ISO 8601, required

### DailySummary

- `date`: YYYY-MM-DD format, required
- `actuals`, `planned`: non-empty arrays
- Sum of `percentage` in actuals/planned should be ~100 (allow ±1 for rounding)

### InitiativePriority

- `priorityScore`: 0-100, integer
- `upvotes`, `downvotes`: >= 0

### TradeoffWarning

- `riskLevel`: enum
- `impacts`: non-empty array
- All `tokenDelta` values should sum to ~0 (zero-sum game)

---

## Error Responses

All endpoints return consistent error format:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Initiative ID is required",
    "details": {
      "field": "initiativeId",
      "value": null
    }
  }
}
```

**Error Codes**:
- `INVALID_REQUEST`: Validation error (400)
- `NOT_FOUND`: Resource not found (404)
- `RATE_LIMIT_EXCEEDED`: Too many requests (429)
- `INTERNAL_ERROR`: Server error (500)

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-20 | Initial data contract |

---

**End of Data Contract**
