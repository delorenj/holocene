# Performance Regression Checklist

## Pre-Commit Checks

### Bundle Size
- [ ] Run `npm run build && npx bundlesize` before committing
- [ ] Main bundle < 200KB gzipped
- [ ] No single chunk > 250KB
- [ ] New dependencies justified and tree-shakeable

### Query Performance
- [ ] No N+1 queries introduced (use DataLoader or batch queries)
- [ ] All new queries have EXPLAIN ANALYZE run
- [ ] New columns have appropriate indexes
- [ ] No unbounded SELECTs (always LIMIT or paginate)

### React Performance
- [ ] Large lists use virtualization (@tanstack/react-virtual)
- [ ] Expensive computations wrapped in useMemo
- [ ] Callbacks passed to children wrapped in useCallback
- [ ] Components that receive objects/arrays are memoized

### API Performance
- [ ] Response payloads minimized (select only needed fields)
- [ ] Appropriate cache headers set
- [ ] Bulk endpoints used for multiple items
- [ ] No blocking operations in request handlers

---

## Code Review Performance Flags

### Red Flags (Block PR)
```typescript
// N+1 Query Pattern
for (const project of projects) {
  const repos = await db.query('SELECT * FROM repos WHERE project_id = $1', [project.id]);
}

// Unbounded fetch
const allEvents = await db.query('SELECT * FROM events');

// Synchronous heavy computation in render
const Component = () => {
  const result = expensiveCalculation(data); // Not memoized
  return <div>{result}</div>;
};

// Missing loading states
const { data } = useQuery(['key']);
return <div>{data.map(...)}</div>; // Crashes if undefined
```

### Yellow Flags (Discuss)
```typescript
// Large inline objects/arrays (cause unnecessary re-renders)
<Component style={{ padding: 10 }} items={[1, 2, 3]} />

// useEffect with object dependencies
useEffect(() => {
  // ...
}, [someObject]); // Will re-run on every render

// Fetching in loops without batching
const results = await Promise.all(ids.map(id => fetchById(id)));
```

### Green Patterns (Encourage)
```typescript
// Batched queries
const repos = await db.query('SELECT * FROM repos WHERE project_id = ANY($1)', [projectIds]);

// Proper memoization
const expensive = useMemo(() => calculate(data), [data]);

// Virtualized lists
const virtualizer = useVirtualizer({ count, getScrollElement, estimateSize });

// Proper cache invalidation
queryClient.invalidateQueries({ queryKey: ['decisions', projectId] });
```

---

## Performance Testing Commands

```bash
# Build analysis
npm run build
npx bundlesize --config bundlesize.config.json
npx vite-bundle-visualizer

# Lighthouse audit
npx lighthouse http://localhost:3000 --view

# Database query analysis
npm run db:explain -- "SELECT ..."

# Load testing
npx k6 run tests/load/api.js
```

---

## Monitoring Dashboards

| Metric | Warning Threshold | Critical Threshold |
|--------|------------------|-------------------|
| LCP | > 2.5s | > 4.0s |
| FID | > 100ms | > 300ms |
| CLS | > 0.1 | > 0.25 |
| API p95 | > 500ms | > 1000ms |
| Error Rate | > 0.1% | > 1% |
| Cache Hit Ratio | < 90% | < 80% |

---

**Last Updated**: 2025-12-27
