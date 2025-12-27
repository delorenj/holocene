# Holocene - Performance-Friendly Architectural Patterns

## Overview

This document provides code patterns that ensure architectural changes maintain high performance. These patterns are designed to work with the Holocene tech stack (React + Vite + TypeScript, Postgres + Redis).

---

## 1. Module Boundary Patterns

### 1.1 Feature Module Structure

Each feature should be self-contained with lazy-loaded entry points:

```
src/features/
├── portfolio-overview/
│   ├── index.ts              # Public API (lazy export)
│   ├── PortfolioOverview.tsx # Main component
│   ├── hooks/
│   │   ├── usePortfolio.ts   # Data fetching
│   │   └── useMomentum.ts    # Derived state
│   ├── components/           # Internal components
│   ├── api/                  # API layer
│   └── types.ts              # TypeScript types
├── decision-radar/
├── agent-constellation/
└── briefing-mode/
```

### 1.2 Lazy Loading Pattern

```typescript
// src/App.tsx
import { lazy, Suspense } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

// Lazy load feature modules
const PortfolioOverview = lazy(() =>
  import('./features/portfolio-overview').then(m => ({ default: m.PortfolioOverview }))
);

const DecisionRadar = lazy(() =>
  import('./features/decision-radar').then(m => ({ default: m.DecisionRadar }))
);

const AgentConstellation = lazy(() =>
  import('./features/agent-constellation').then(m => ({ default: m.AgentConstellation }))
);

// Feature boundary with loading state
const FeatureBoundary = ({ children }: { children: React.ReactNode }) => (
  <Suspense fallback={<FeatureSkeleton />}>
    {children}
  </Suspense>
);

// Route-based code splitting
const routes = [
  {
    path: '/portfolio',
    element: <FeatureBoundary><PortfolioOverview /></FeatureBoundary>,
  },
  {
    path: '/decisions',
    element: <FeatureBoundary><DecisionRadar /></FeatureBoundary>,
  },
  {
    path: '/agents',
    element: <FeatureBoundary><AgentConstellation /></FeatureBoundary>,
  },
];
```

### 1.3 Cross-Module Communication

```typescript
// src/shared/event-bus.ts
// Decouple modules with typed event bus

type EventMap = {
  'decision:created': { decision: Decision; projectId: string };
  'task:completed': { task: Task; agentId: string };
  'brief:requested': { type: 'AM' | 'PM'; scope: string };
  'cache:invalidate': { patterns: string[] };
};

class TypedEventBus {
  private listeners = new Map<keyof EventMap, Set<Function>>();

  on<K extends keyof EventMap>(event: K, callback: (data: EventMap[K]) => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
    return () => this.listeners.get(event)?.delete(callback);
  }

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]) {
    this.listeners.get(event)?.forEach(cb => cb(data));
  }
}

export const eventBus = new TypedEventBus();

// Usage in module
eventBus.on('decision:created', ({ projectId }) => {
  queryClient.invalidateQueries(['portfolio', projectId]);
});
```

---

## 2. Data Layer Patterns

### 2.1 Repository Pattern with Caching

```typescript
// src/data/repositories/ProjectRepository.ts

interface CacheConfig {
  ttl: number;
  staleWhileRevalidate?: boolean;
}

abstract class BaseRepository<T> {
  constructor(
    protected db: Database,
    protected cache: RedisClient,
    protected cachePrefix: string
  ) {}

  protected async getCached<R>(
    key: string,
    fetcher: () => Promise<R>,
    config: CacheConfig
  ): Promise<R> {
    const cacheKey = `${this.cachePrefix}:${key}`;

    // Try cache first
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      // Stale-while-revalidate pattern
      if (config.staleWhileRevalidate) {
        this.refreshCache(cacheKey, fetcher, config.ttl);
      }
      return JSON.parse(cached);
    }

    // Fetch and cache
    const data = await fetcher();
    await this.cache.setex(cacheKey, config.ttl, JSON.stringify(data));
    return data;
  }

  private async refreshCache<R>(
    key: string,
    fetcher: () => Promise<R>,
    ttl: number
  ) {
    // Background refresh
    fetcher().then(data => {
      this.cache.setex(key, ttl, JSON.stringify(data));
    });
  }

  abstract invalidate(id: string): Promise<void>;
}

// Concrete implementation
class ProjectRepository extends BaseRepository<Project> {
  constructor(db: Database, cache: RedisClient) {
    super(db, cache, 'project');
  }

  async getOverview(userId: string): Promise<PortfolioOverview> {
    return this.getCached(
      `overview:${userId}`,
      () => this.fetchOverview(userId),
      { ttl: 60, staleWhileRevalidate: true }
    );
  }

  private async fetchOverview(userId: string): Promise<PortfolioOverview> {
    // Single optimized query
    return this.db.query(`
      SELECT
        p.id, p.name,
        COUNT(DISTINCT r.id) as repo_count,
        COALESCE(m.momentum_24h, 0) as momentum
      FROM projects p
      LEFT JOIN repos r ON r.project_id = p.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) as momentum_24h
        FROM decisions d
        WHERE d.repo_id = r.id
        AND d.created_at > NOW() - INTERVAL '24 hours'
      ) m ON true
      WHERE p.owner_id = $1
      GROUP BY p.id, m.momentum_24h
      ORDER BY m.momentum_24h DESC
      LIMIT 10
    `, [userId]);
  }

  async invalidate(projectId: string) {
    const patterns = [
      `project:${projectId}`,
      `project:overview:*`,
      `momentum:${projectId}:*`,
    ];
    await Promise.all(patterns.map(p => this.cache.del(p)));
  }
}
```

### 2.2 Query Optimization Patterns

```typescript
// src/data/queries/optimized-queries.ts

// Pattern 1: Batch loading to prevent N+1
class DataLoader<K, V> {
  private batch: Map<K, { resolve: (v: V) => void; reject: (e: Error) => void }[]> = new Map();
  private scheduled = false;

  constructor(private batchFn: (keys: K[]) => Promise<Map<K, V>>) {}

  async load(key: K): Promise<V> {
    return new Promise((resolve, reject) => {
      if (!this.batch.has(key)) {
        this.batch.set(key, []);
      }
      this.batch.get(key)!.push({ resolve, reject });
      this.schedule();
    });
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    process.nextTick(() => this.executeBatch());
  }

  private async executeBatch() {
    const keys = Array.from(this.batch.keys());
    const callbacks = new Map(this.batch);
    this.batch.clear();
    this.scheduled = false;

    try {
      const results = await this.batchFn(keys);
      for (const [key, cbs] of callbacks) {
        const value = results.get(key);
        cbs.forEach(({ resolve, reject }) => {
          if (value !== undefined) resolve(value);
          else reject(new Error(`Not found: ${key}`));
        });
      }
    } catch (error) {
      for (const cbs of callbacks.values()) {
        cbs.forEach(({ reject }) => reject(error as Error));
      }
    }
  }
}

// Usage
const repoLoader = new DataLoader<string, Repo[]>(async (projectIds) => {
  const repos = await db.query(`
    SELECT * FROM repos WHERE project_id = ANY($1)
  `, [projectIds]);

  const byProject = new Map<string, Repo[]>();
  for (const repo of repos) {
    if (!byProject.has(repo.project_id)) {
      byProject.set(repo.project_id, []);
    }
    byProject.get(repo.project_id)!.push(repo);
  }
  return byProject;
});

// Pattern 2: Cursor-based pagination
interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

async function paginatedQuery<T>(
  baseQuery: string,
  params: any[],
  options: { cursor?: string; limit: number; orderBy: string }
): Promise<PaginatedResult<T>> {
  const { cursor, limit, orderBy } = options;

  let query = baseQuery;
  const queryParams = [...params];

  if (cursor) {
    const [id, timestamp] = Buffer.from(cursor, 'base64').toString().split(':');
    query += ` AND (${orderBy}, id) < ($${queryParams.length + 1}, $${queryParams.length + 2})`;
    queryParams.push(timestamp, id);
  }

  query += ` ORDER BY ${orderBy} DESC, id DESC LIMIT $${queryParams.length + 1}`;
  queryParams.push(limit + 1);

  const items = await db.query<T>(query, queryParams);
  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem
    ? Buffer.from(`${lastItem.id}:${lastItem[orderBy]}`).toString('base64')
    : null;

  return { items, cursor: nextCursor, hasMore };
}
```

---

## 3. Component Optimization Patterns

### 3.1 Memoization Strategy

```typescript
// src/features/agent-constellation/AgentConstellation.tsx

import { memo, useMemo, useCallback, useDeferredValue } from 'react';

// Level 1: Memoize expensive computations
const useGraphLayout = (agents: Agent[], connections: Connection[]) => {
  return useMemo(() => {
    // Force-directed layout calculation
    const nodes = agents.map(a => ({ id: a.id, x: 0, y: 0, ...a }));
    const links = connections.map(c => ({ source: c.from, target: c.to, weight: c.strength }));

    // Simulate forces
    for (let i = 0; i < 100; i++) {
      applyForces(nodes, links);
    }

    return { nodes, links };
  }, [agents, connections]);
};

// Level 2: Memoize components
const AgentNode = memo(({ agent, position, onClick }: AgentNodeProps) => {
  return (
    <g
      transform={`translate(${position.x}, ${position.y})`}
      onClick={() => onClick(agent.id)}
    >
      <circle r={20} fill={getAgentColor(agent.type)} />
      <text textAnchor="middle" dy={30}>{agent.name}</text>
    </g>
  );
}, (prev, next) => {
  // Custom comparison for performance
  return (
    prev.agent.id === next.agent.id &&
    prev.position.x === next.position.x &&
    prev.position.y === next.position.y
  );
});

// Level 3: Defer non-critical updates
const AgentConstellation = ({ filter }: { filter: string }) => {
  const { data: agents } = useAgents();
  const { data: connections } = useConnections();

  // Defer filter changes to avoid jank
  const deferredFilter = useDeferredValue(filter);

  const filteredAgents = useMemo(() => {
    if (!deferredFilter) return agents;
    return agents?.filter(a =>
      a.name.toLowerCase().includes(deferredFilter.toLowerCase())
    );
  }, [agents, deferredFilter]);

  const layout = useGraphLayout(filteredAgents ?? [], connections ?? []);

  // Stable callback reference
  const handleNodeClick = useCallback((id: string) => {
    // Handle click
  }, []);

  return (
    <svg width={800} height={600}>
      {layout.nodes.map(node => (
        <AgentNode
          key={node.id}
          agent={node}
          position={{ x: node.x, y: node.y }}
          onClick={handleNodeClick}
        />
      ))}
    </svg>
  );
};
```

### 3.2 Virtualization Pattern

```typescript
// src/features/decision-radar/DecisionList.tsx

import { useVirtualizer } from '@tanstack/react-virtual';

interface DecisionListProps {
  decisions: Decision[];
  onLoadMore: () => void;
  hasMore: boolean;
}

const DecisionList = ({ decisions, onLoadMore, hasMore }: DecisionListProps) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: hasMore ? decisions.length + 1 : decisions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 5, // Render 5 extra items outside viewport
  });

  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (!lastItem) return;

    if (lastItem.index >= decisions.length - 1 && hasMore) {
      onLoadMore();
    }
  }, [virtualizer.getVirtualItems(), decisions.length, hasMore, onLoadMore]);

  return (
    <div
      ref={parentRef}
      className="h-[600px] overflow-auto"
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const isLoader = virtualRow.index >= decisions.length;

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {isLoader ? (
                <DecisionSkeleton />
              ) : (
                <DecisionCard decision={decisions[virtualRow.index]} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
```

---

## 4. API Design Patterns

### 4.1 Efficient Endpoints

```typescript
// src/api/routes/portfolio.ts

// Pattern 1: Aggregate endpoint to reduce round trips
router.get('/api/portfolio/overview', async (req, res) => {
  const { userId } = req.auth;

  // Single request returns all dashboard data
  const [projects, recentDecisions, alerts] = await Promise.all([
    projectRepo.getTopMovers(userId, 3),
    decisionRepo.getRecent(userId, 10),
    alertRepo.getActive(userId),
  ]);

  res.json({
    projects,
    recentDecisions,
    alerts,
    generatedAt: new Date().toISOString(),
  });
});

// Pattern 2: Field selection to reduce payload size
router.get('/api/projects/:id', async (req, res) => {
  const { id } = req.params;
  const { fields } = req.query; // ?fields=id,name,momentum

  const project = await projectRepo.getById(id, {
    select: fields ? fields.split(',') : undefined,
  });

  res.json(project);
});

// Pattern 3: Conditional requests with ETag
router.get('/api/decisions', async (req, res) => {
  const decisions = await decisionRepo.getAll(req.auth.userId);
  const etag = generateETag(decisions);

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.json(decisions);
});
```

### 4.2 Response Compression

```typescript
// src/middleware/compression.ts

import compression from 'compression';

export const compressionMiddleware = compression({
  filter: (req, res) => {
    // Don't compress SSE or WebSocket
    if (req.headers['accept'] === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // Only compress responses > 1KB
  level: 6, // Balance between speed and compression ratio
});

// Usage
app.use(compressionMiddleware);
```

---

## 5. Background Processing Patterns

### 5.1 Job Queue for Heavy Operations

```typescript
// src/jobs/briefing-generator.ts

import { Queue, Worker, Job } from 'bullmq';

interface BriefingJobData {
  type: 'AM' | 'PM';
  userId: string;
  projectIds: string[];
}

// Queue definition
const briefingQueue = new Queue<BriefingJobData>('briefings', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 1000 },
  },
});

// Worker processing
const briefingWorker = new Worker<BriefingJobData>(
  'briefings',
  async (job: Job<BriefingJobData>) => {
    const { type, userId, projectIds } = job.data;

    // Progress tracking
    await job.updateProgress(10);

    // Fetch data for each project
    const projectData = await Promise.all(
      projectIds.map(async (id, i) => {
        const data = await fetchProjectData(id, type);
        await job.updateProgress(10 + (i / projectIds.length) * 60);
        return data;
      })
    );

    await job.updateProgress(70);

    // Generate narrative
    const narrative = await generateNarrative(projectData);
    await job.updateProgress(90);

    // Store result
    const brief = await storeBrief(userId, type, { projectData, narrative });
    await job.updateProgress(100);

    // Notify via WebSocket
    await notifyUser(userId, 'brief:ready', { briefId: brief.id });

    return brief.id;
  },
  { connection: redisConnection, concurrency: 5 }
);

// Schedule daily briefs
import cron from 'node-cron';

cron.schedule('0 6 * * *', async () => {
  const users = await getUsersWithBriefingEnabled();
  await Promise.all(
    users.map(user =>
      briefingQueue.add('am-brief', {
        type: 'AM',
        userId: user.id,
        projectIds: user.projectIds,
      })
    )
  );
});
```

### 5.2 Materialized View Refresh

```typescript
// src/jobs/view-refresh.ts

const MATERIALIZED_VIEWS = [
  {
    name: 'agent_collaboration',
    refreshInterval: 15 * 60 * 1000, // 15 minutes
    concurrent: true,
  },
  {
    name: 'project_momentum',
    refreshInterval: 5 * 60 * 1000, // 5 minutes
    concurrent: true,
  },
  {
    name: 'decision_impact_rankings',
    refreshInterval: 60 * 60 * 1000, // 1 hour
    concurrent: false,
  },
];

class MaterializedViewManager {
  private timers = new Map<string, NodeJS.Timeout>();

  start() {
    for (const view of MATERIALIZED_VIEWS) {
      this.scheduleRefresh(view);
    }
  }

  private scheduleRefresh(view: typeof MATERIALIZED_VIEWS[0]) {
    const refresh = async () => {
      const start = performance.now();
      try {
        await db.query(`
          REFRESH MATERIALIZED VIEW ${view.concurrent ? 'CONCURRENTLY' : ''} ${view.name}
        `);
        const duration = performance.now() - start;
        metrics.recordViewRefresh(view.name, duration);
      } catch (error) {
        logger.error(`Failed to refresh ${view.name}`, error);
      }
    };

    // Initial refresh
    refresh();

    // Scheduled refreshes
    this.timers.set(
      view.name,
      setInterval(refresh, view.refreshInterval)
    );
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
```

---

## 6. Dependency Injection Patterns

### 6.1 Lightweight DI Container

```typescript
// src/di/container.ts

type Factory<T> = () => T | Promise<T>;
type Constructor<T> = new (...args: any[]) => T;

class Container {
  private singletons = new Map<string, any>();
  private factories = new Map<string, Factory<any>>();

  // Register singleton
  singleton<T>(token: string, factory: Factory<T>): void {
    this.factories.set(token, async () => {
      if (!this.singletons.has(token)) {
        this.singletons.set(token, await factory());
      }
      return this.singletons.get(token);
    });
  }

  // Register transient
  transient<T>(token: string, factory: Factory<T>): void {
    this.factories.set(token, factory);
  }

  // Resolve
  async resolve<T>(token: string): Promise<T> {
    const factory = this.factories.get(token);
    if (!factory) throw new Error(`No registration for ${token}`);
    return factory();
  }
}

// Setup
const container = new Container();

container.singleton('database', () =>
  new Database(process.env.DATABASE_URL)
);

container.singleton('cache', () =>
  new RedisClient(process.env.REDIS_URL)
);

container.singleton('projectRepo', async () => {
  const db = await container.resolve<Database>('database');
  const cache = await container.resolve<RedisClient>('cache');
  return new ProjectRepository(db, cache);
});

// Usage in routes
router.get('/api/projects', async (req, res) => {
  const projectRepo = await container.resolve<ProjectRepository>('projectRepo');
  const projects = await projectRepo.getAll(req.auth.userId);
  res.json(projects);
});
```

### 6.2 Context-Based Injection (React)

```typescript
// src/context/services.tsx

interface Services {
  projectRepo: ProjectRepository;
  decisionRepo: DecisionRepository;
  briefingService: BriefingService;
}

const ServicesContext = createContext<Services | null>(null);

export const ServicesProvider = ({ children }: { children: ReactNode }) => {
  const services = useMemo(() => ({
    projectRepo: new ProjectRepository(apiClient),
    decisionRepo: new DecisionRepository(apiClient),
    briefingService: new BriefingService(apiClient),
  }), []);

  return (
    <ServicesContext.Provider value={services}>
      {children}
    </ServicesContext.Provider>
  );
};

export const useServices = () => {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('Must be used within ServicesProvider');
  return services;
};

// Usage in components
const PortfolioOverview = () => {
  const { projectRepo } = useServices();
  const { data } = useQuery({
    queryKey: ['portfolio'],
    queryFn: () => projectRepo.getOverview(),
  });
  // ...
};
```

---

## 7. Error Boundaries & Recovery

```typescript
// src/components/ErrorBoundary.tsx

class PerformanceErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean; errorCount: number }
> {
  state = { hasError: false, errorCount: 0 };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Track error for performance monitoring
    metrics.trackError({
      type: 'render_error',
      message: error.message,
      componentStack: info.componentStack,
    });

    this.setState(prev => ({
      errorCount: prev.errorCount + 1,
    }));
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      // After 3 errors, show permanent failure state
      if (this.state.errorCount >= 3) {
        return <PermanentError />;
      }

      return (
        <div className="error-state">
          {this.props.fallback}
          <button onClick={this.handleRetry}>Retry</button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

---

**Document Version**: 1.0.0
**Last Updated**: 2025-12-27
**Author**: Performance Optimizer Agent (High Council of Architects)
