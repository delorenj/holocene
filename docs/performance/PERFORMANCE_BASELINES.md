# Holocene Dashboard - Performance Baselines & Optimization Guide

## Executive Summary

This document establishes performance baselines, identifies potential bottlenecks, and provides optimization recommendations for the Holocene mission control dashboard.

---

## 1. Architecture Performance Analysis

### 1.1 Tech Stack Performance Characteristics

| Component | Technology | Performance Impact | Optimization Priority |
|-----------|------------|-------------------|----------------------|
| Frontend | React + Vite + TypeScript | Fast HMR, Tree-shaking | Medium |
| UI Framework | shadcn/ui + Tailwind | Minimal runtime overhead | Low |
| Database | Postgres | ACID compliance, query optimization critical | High |
| Cache Layer | Redis | Sub-millisecond reads | High |
| Auth | Email/password + GitHub OAuth | Session management overhead | Low |

### 1.2 Performance Budget Recommendations

```yaml
Build Performance:
  initial_build_time: < 30s
  incremental_build_time: < 5s
  hot_reload_time: < 500ms

Bundle Size Budgets:
  initial_js: < 200KB (gzipped)
  initial_css: < 50KB (gzipped)
  chunk_size_warning: 250KB
  chunk_size_max: 500KB

Runtime Performance:
  first_contentful_paint: < 1.5s
  largest_contentful_paint: < 2.5s
  time_to_interactive: < 3.5s
  cumulative_layout_shift: < 0.1
  first_input_delay: < 100ms

API Response Times:
  p50_latency: < 100ms
  p95_latency: < 500ms
  p99_latency: < 1000ms
```

---

## 2. Entity Model Performance Analysis

### 2.1 Data Model Complexity Assessment

The proposed data model has significant relational complexity:

```
Entity Relationship Depth Analysis:
├── Project (Level 0)
│   ├── Repos (1:N) - Level 1
│   │   ├── Decisions (1:N) - Level 2
│   │   ├── Sessions (1:N) - Level 2
│   │   │   └── Checkpoints (1:N) - Level 3
│   │   ├── Employees (M:N) - Level 2
│   │   │   ├── Tasks (1:N) - Level 3
│   │   │   ├── MemoryShards (1:N) - Level 3
│   │   │   └── DailyStandups (1:N) - Level 3
│   │   └── Worktrees (1:N) - Level 2
│   ├── Tasks (1:N) - Level 1
│   │   ├── Sessions (1:N) - Level 2
│   │   ├── Contributors (M:N) - Level 2
│   │   └── Events (1:N) - Level 2
│   └── Briefs (1:N) - Level 1
```

**Performance Concern**: Deep nesting creates N+1 query risks and expensive JOINs.

### 2.2 Abstraction Overhead Hot Spots

| Entity | Concern | Mitigation |
|--------|---------|------------|
| Employee.MemoryShards | Unbounded growth, polymorphic storage | Pagination, lazy loading, archive strategy |
| Session.Events | High cardinality (every input/output) | Event aggregation, time-windowed rollups |
| Task.Lifecycle | State machine complexity | Denormalize current state, index transitions |
| Brief (rollups) | Recursive aggregation across repos | Pre-compute, materialized views |
| Agent Constellation | Graph traversal for collaboration | Graph DB or adjacency list caching |

---

## 3. Query Performance Patterns

### 3.1 Critical Read Paths

#### Portfolio Overview (Highest Frequency)
```sql
-- ANTI-PATTERN: N+1 queries
SELECT * FROM projects;
-- Then for each project:
SELECT * FROM repos WHERE project_id = ?;
SELECT * FROM decisions WHERE repo_id IN (...);

-- OPTIMIZED: Single query with aggregation
SELECT
  p.id,
  p.name,
  COUNT(DISTINCT r.id) as repo_count,
  COUNT(DISTINCT d.id) as decision_count,
  MAX(d.created_at) as latest_activity,
  -- Momentum calculation as window function
  SUM(CASE WHEN d.created_at > NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as momentum_24h
FROM projects p
LEFT JOIN repos r ON r.project_id = p.id
LEFT JOIN decisions d ON d.repo_id = r.id
GROUP BY p.id
ORDER BY momentum_24h DESC
LIMIT 3;
```

#### Decision Radar (High Frequency)
```sql
-- Index recommendations:
CREATE INDEX idx_decisions_impact_time ON decisions(impact_score DESC, created_at DESC);
CREATE INDEX idx_decisions_autonomy ON decisions(autonomy_level, created_at DESC) WHERE autonomy_level > threshold;

-- Query with covering index
SELECT id, title, impact_score, autonomy_level, created_at
FROM decisions
WHERE created_at > NOW() - INTERVAL '7 days'
ORDER BY impact_score DESC, created_at DESC
LIMIT 20;
```

#### Agent Constellation (Medium Frequency, High Complexity)
```sql
-- Pre-compute collaboration edges in materialized view
CREATE MATERIALIZED VIEW agent_collaboration AS
SELECT
  e1.id as agent_a,
  e2.id as agent_b,
  COUNT(*) as collaboration_count,
  array_agg(DISTINCT t.id) as shared_tasks
FROM employees e1
JOIN task_contributors tc1 ON tc1.employee_id = e1.id
JOIN task_contributors tc2 ON tc2.task_id = tc1.task_id AND tc2.employee_id != e1.id
JOIN employees e2 ON e2.id = tc2.employee_id
JOIN tasks t ON t.id = tc1.task_id
WHERE t.created_at > NOW() - INTERVAL '30 days'
GROUP BY e1.id, e2.id;

-- Refresh strategy: every 15 minutes or on significant changes
REFRESH MATERIALIZED VIEW CONCURRENTLY agent_collaboration;
```

### 3.2 Index Strategy

```sql
-- Primary performance indexes
CREATE INDEX idx_repos_project_id ON repos(project_id);
CREATE INDEX idx_tasks_assignee_state ON tasks(assignee_id, state) WHERE state != 'closed';
CREATE INDEX idx_sessions_task_time ON sessions(task_id, started_at DESC);
CREATE INDEX idx_employees_active_task ON employees(active_task_id) WHERE active_task_id IS NOT NULL;
CREATE INDEX idx_events_type_time ON events(event_type, created_at DESC);
CREATE INDEX idx_briefs_type_window ON briefs(brief_type, time_window_start, time_window_end);

-- Partial indexes for common filters
CREATE INDEX idx_tasks_open ON tasks(created_at DESC) WHERE state = 'open';
CREATE INDEX idx_tasks_ready ON tasks(created_at DESC) WHERE state = 'ready';
CREATE INDEX idx_decisions_recent ON decisions(impact_score DESC) WHERE created_at > NOW() - INTERVAL '7 days';
```

---

## 4. Caching Architecture

### 4.1 Multi-Tier Caching Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client-Side Cache                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │ React Query │  │ Service     │  │ IndexedDB   │            │
│  │ (5min TTL)  │  │ Worker      │  │ (offline)   │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     CDN / Edge Cache                            │
│  Static assets, public API responses with Cache-Control         │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Application Cache (Redis)                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │ Session Cache   │  │ Query Cache     │  │ Computed      │  │
│  │ (auth, prefs)   │  │ (API responses) │  │ Aggregates    │  │
│  │ TTL: 30min      │  │ TTL: 1-5min     │  │ TTL: 15min    │  │
│  └─────────────────┘  └─────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Database (Postgres)                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐  │
│  │ Connection Pool │  │ Prepared        │  │ Materialized  │  │
│  │ (pgBouncer)     │  │ Statements      │  │ Views         │  │
│  └─────────────────┘  └─────────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Cache Key Design

```typescript
// Redis cache key patterns
const cacheKeys = {
  // User-scoped
  session: (userId: string) => `session:${userId}`,
  userPrefs: (userId: string) => `prefs:${userId}`,

  // Entity caches
  portfolio: (userId: string) => `portfolio:${userId}:overview`,
  project: (projectId: string) => `project:${projectId}`,
  decisions: (projectId: string, page: number) => `decisions:${projectId}:page:${page}`,

  // Computed aggregates
  momentum: (projectId: string) => `momentum:${projectId}:24h`,
  agentGraph: (projectId: string) => `agents:${projectId}:graph`,

  // Briefings (pre-computed)
  briefAM: (date: string) => `brief:am:${date}`,
  briefPM: (date: string) => `brief:pm:${date}`,
};

// Cache invalidation patterns
const invalidationGroups = {
  onDecisionCreate: ['decisions:*', 'momentum:*', 'portfolio:*'],
  onTaskComplete: ['portfolio:*', 'agents:*:graph'],
  onSessionEnd: ['brief:*', 'agents:*:graph'],
};
```

### 4.3 Cache Warming Strategy

```typescript
// Pre-warm caches on startup and schedule
const warmingSchedule = {
  // Every minute: active user portfolios
  everyMinute: ['portfolio:*:overview'],

  // Every 5 minutes: decision radar
  every5Min: ['decisions:*:page:1'],

  // Every 15 minutes: materialized view refresh + agent graph
  every15Min: ['agents:*:graph'],

  // 6 AM daily: pre-compute AM brief
  daily6AM: ['brief:am:*'],

  // 6 PM daily: pre-compute PM brief
  daily6PM: ['brief:pm:*'],
};
```

---

## 5. Frontend Performance Patterns

### 5.1 React Component Optimization

```typescript
// Portfolio Overview - Virtualized list for large datasets
import { useVirtualizer } from '@tanstack/react-virtual';

const PortfolioList = ({ projects }) => {
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: projects.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120, // Estimated row height
  });

  return (
    <div ref={parentRef} className="h-[600px] overflow-auto">
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <ProjectCard
            key={virtualRow.key}
            project={projects[virtualRow.index]}
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          />
        ))}
      </div>
    </div>
  );
};

// Memoization for expensive renders
const AgentConstellation = memo(({ agents, connections }) => {
  // Graph visualization - only re-render when data changes
  const graphData = useMemo(() =>
    computeGraphLayout(agents, connections),
    [agents, connections]
  );

  return <ForceGraph data={graphData} />;
});
```

### 5.2 Data Fetching Patterns

```typescript
// React Query configuration for optimal caching
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      cacheTime: 1000 * 60 * 30, // 30 minutes
      refetchOnWindowFocus: false,
      retry: 2,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    },
  },
});

// Query with proper caching
const usePortfolioOverview = () => {
  return useQuery({
    queryKey: ['portfolio', 'overview'],
    queryFn: fetchPortfolioOverview,
    staleTime: 1000 * 60, // 1 minute for frequently updating data
    select: (data) => ({
      ...data,
      // Compute derived values once
      topMovers: data.projects.slice(0, 3),
      totalMomentum: data.projects.reduce((sum, p) => sum + p.momentum, 0),
    }),
  });
};

// Optimistic updates for better UX
const useUpdateDecision = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateDecision,
    onMutate: async (newDecision) => {
      await queryClient.cancelQueries({ queryKey: ['decisions'] });
      const previous = queryClient.getQueryData(['decisions']);
      queryClient.setQueryData(['decisions'], (old) =>
        old.map(d => d.id === newDecision.id ? { ...d, ...newDecision } : d)
      );
      return { previous };
    },
    onError: (err, newDecision, context) => {
      queryClient.setQueryData(['decisions'], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['decisions'] });
    },
  });
};
```

### 5.3 Bundle Optimization

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor splitting
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'query-vendor': ['@tanstack/react-query'],
          'ui-vendor': ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu'],
          'chart-vendor': ['recharts', 'd3'],

          // Feature-based splitting
          'feature-constellation': ['./src/features/agent-constellation'],
          'feature-briefing': ['./src/features/briefing-mode'],
        },
      },
    },
    chunkSizeWarningLimit: 250,
  },
  optimizeDeps: {
    include: ['react', 'react-dom', '@tanstack/react-query'],
  },
});
```

---

## 6. Briefing Mode Performance

### 6.1 Pre-Computation Strategy

```typescript
// Briefing generation should be background processed
interface BriefingJob {
  type: 'AM' | 'PM';
  scope: 'portfolio' | 'project' | 'repo';
  scopeId: string;
  timeWindow: { start: Date; end: Date };
}

// Background job processor
class BriefingProcessor {
  async generateBrief(job: BriefingJob): Promise<Brief> {
    // 1. Fetch aggregated data (use cached views)
    const data = await this.fetchAggregatedData(job);

    // 2. Compute deltas and highlights
    const deltas = this.computeDeltas(data);

    // 3. Generate narrative (can be async/streaming)
    const narrative = await this.generateNarrative(deltas);

    // 4. Cache the result
    await this.cacheBrief(job, { data, deltas, narrative });

    return { data, deltas, narrative };
  }

  private async fetchAggregatedData(job: BriefingJob) {
    // Use materialized views for efficiency
    return db.query(`
      SELECT * FROM brief_aggregates
      WHERE scope_type = $1
      AND scope_id = $2
      AND time_window @> $3::timestamptz
    `, [job.scope, job.scopeId, job.timeWindow.start]);
  }
}

// Schedule jobs
cron.schedule('0 6 * * *', () => briefingQueue.add({ type: 'AM', ... }));
cron.schedule('0 18 * * *', () => briefingQueue.add({ type: 'PM', ... }));
```

### 6.2 Incremental Brief Updates

```typescript
// Instead of regenerating entire briefs, use incremental updates
interface BriefDelta {
  additions: DecisionSummary[];
  completions: TaskSummary[];
  alerts: Alert[];
  momentumChange: number;
}

const updateBriefIncrementally = async (
  existingBrief: Brief,
  recentEvents: Event[]
): Promise<Brief> => {
  const delta = computeDelta(existingBrief.lastEventId, recentEvents);

  return {
    ...existingBrief,
    decisions: [...existingBrief.decisions, ...delta.additions],
    tasks: mergeTaskUpdates(existingBrief.tasks, delta.completions),
    alerts: [...existingBrief.alerts, ...delta.alerts],
    momentum: existingBrief.momentum + delta.momentumChange,
    lastEventId: recentEvents[recentEvents.length - 1]?.id,
    updatedAt: new Date(),
  };
};
```

---

## 7. Monitoring & Alerting

### 7.1 Key Performance Indicators (KPIs)

```yaml
Frontend Metrics:
  - core_web_vitals:
      lcp_p75: < 2.5s
      fid_p75: < 100ms
      cls_p75: < 0.1
  - bundle_size_main: < 200KB
  - initial_load_time_p50: < 2s
  - api_request_count_per_page: < 5

Backend Metrics:
  - api_latency_p50: < 100ms
  - api_latency_p95: < 500ms
  - db_query_time_p95: < 50ms
  - cache_hit_ratio: > 90%
  - error_rate: < 0.1%

Database Metrics:
  - connection_pool_utilization: < 80%
  - slow_query_count: 0 (queries > 1s)
  - index_hit_ratio: > 99%
  - replication_lag: < 100ms

Redis Metrics:
  - memory_utilization: < 70%
  - eviction_rate: < 1%
  - connection_count: < 80% of max
```

### 7.2 Alert Thresholds

```typescript
const alertConfig = {
  critical: {
    api_latency_p99: { threshold: 5000, window: '5m' },
    error_rate: { threshold: 1, window: '5m' },
    db_connection_pool: { threshold: 95, window: '1m' },
  },
  warning: {
    api_latency_p95: { threshold: 1000, window: '5m' },
    cache_hit_ratio: { threshold: 80, window: '15m' },
    bundle_size: { threshold: 250000, on: 'deploy' },
  },
  info: {
    slow_queries: { threshold: 5, window: '1h' },
    memory_usage: { threshold: 70, window: '5m' },
  },
};
```

---

## 8. Performance Regression Prevention

### 8.1 CI/CD Performance Gates

```yaml
# .github/workflows/perf-check.yml
performance-check:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Build and analyze bundle
      run: |
        npm run build
        npx bundlesize --config bundlesize.config.json

    - name: Run Lighthouse CI
      uses: treosh/lighthouse-ci-action@v9
      with:
        budgetPath: ./lighthouse-budget.json
        uploadArtifacts: true

    - name: Database query analysis
      run: |
        npm run db:analyze-queries
        npm run db:check-missing-indexes

    - name: API performance test
      run: |
        npm run test:perf
        # Fail if p95 > 500ms
```

### 8.2 Performance Budget Configuration

```json
// bundlesize.config.json
{
  "files": [
    {
      "path": "dist/assets/index-*.js",
      "maxSize": "200 kB",
      "compression": "gzip"
    },
    {
      "path": "dist/assets/index-*.css",
      "maxSize": "50 kB",
      "compression": "gzip"
    },
    {
      "path": "dist/assets/feature-constellation-*.js",
      "maxSize": "100 kB",
      "compression": "gzip"
    }
  ]
}
```

---

## 9. Recommendations for Coder Agent

### 9.1 High Priority Optimizations

1. **Implement Connection Pooling**: Use pgBouncer or built-in pool with max 20-50 connections
2. **Add Redis Caching Layer**: Start with portfolio overview and decision radar
3. **Create Materialized Views**: For agent collaboration graph and momentum scores
4. **Implement React Query**: Replace any manual fetching with proper cache management

### 9.2 Performance Anti-Patterns to Avoid

```typescript
// AVOID: N+1 queries
const projects = await db.query('SELECT * FROM projects');
for (const project of projects) {
  const repos = await db.query('SELECT * FROM repos WHERE project_id = $1', [project.id]);
  // ...
}

// AVOID: Unbounded data fetching
const allEvents = await db.query('SELECT * FROM events'); // Could be millions

// AVOID: Synchronous heavy computation in render
const AgentGraph = ({ agents }) => {
  const layout = computeExpensiveLayout(agents); // Blocks render
  return <Graph data={layout} />;
};

// AVOID: Missing loading states
const Dashboard = () => {
  const { data } = useQuery(['portfolio']); // No suspense boundary
  return <div>{data.map(...)}</div>; // Crashes if data undefined
};
```

---

## 10. Performance Monitoring Dashboard

### Recommended Tools

| Category | Tool | Purpose |
|----------|------|---------|
| APM | DataDog / New Relic | Full-stack observability |
| RUM | Vercel Analytics / Sentry | Real user performance |
| Database | pg_stat_statements | Query performance |
| Caching | Redis Insight | Cache monitoring |
| Frontend | Lighthouse CI | Core Web Vitals |

---

**Document Version**: 1.0.0
**Last Updated**: 2025-12-27
**Author**: Performance Optimizer Agent (High Council of Architects)
