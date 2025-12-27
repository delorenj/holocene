# ADR-002: PostgreSQL as Primary Database

**Status**: ACCEPTED
**Date**: 2025-12-27
**Deciders**: System Architect (High Council of Architects)
**Context**: Data persistence strategy for Holocene dashboard

---

## Context and Problem Statement

Holocene needs a robust data persistence layer to store portfolio metrics, decisions, agent metadata, tasks, briefings, risks, and session history. The database must support:
- Complex relational queries (joins, aggregations)
- ACID transactions for consistency
- Full-text search for decisions and tasks
- Time-series data for metrics
- Scalability to 10K+ decisions, 100+ projects

**Problem**: Which database technology should we use as the primary data store?

---

## Decision Drivers

1. **Data Integrity** (CRITICAL): ACID guarantees for multi-step operations
2. **Query Flexibility** (HIGH): Complex joins, aggregations, window functions
3. **Self-Hosted** (CRITICAL): Must run on local infrastructure (data sovereignty)
4. **Maturity** (HIGH): Production-ready with extensive tooling
5. **Performance** (MEDIUM): Sub-100ms query times for most operations
6. **Cost** (LOW): Open-source, no licensing fees

---

## Considered Options

### Option 1: **PostgreSQL**
- **Type**: Relational database (RDBMS)
- **Version**: 16+ (latest stable)
- **Pros**:
  - **ACID Compliance**: Strong consistency guarantees
  - **Rich Feature Set**: Full-text search, JSON support, CTEs, window functions
  - **Mature Ecosystem**: pgAdmin, pg_dump, extensive libraries
  - **Performance**: Excellent query optimization, indexing strategies
  - **Self-Hosted**: Easy Docker deployment
  - **Extensions**: PostGIS (if geospatial needed), pg_trgm (fuzzy search)
- **Cons**:
  - **Vertical Scaling**: Harder to horizontally scale than NoSQL
  - **Schema Migrations**: Requires planning and tooling
  - **Read Replicas**: Additional setup for high-read scenarios

### Option 2: **MongoDB**
- **Type**: NoSQL document database
- **Pros**:
  - **Schema Flexibility**: Easy to iterate on data models
  - **Horizontal Scaling**: Sharding built-in
  - **JSON-Native**: Natural fit for JavaScript/TypeScript
- **Cons**:
  - **No ACID**: Limited transaction support (multi-document ACID in v4+, but complex)
  - **Join Performance**: Lookups slower than SQL joins
  - **Consistency Trade-offs**: Eventual consistency by default
  - **Overkill**: Schema flexibility not needed (well-defined domain models)

### Option 3: **SQLite**
- **Type**: Embedded relational database
- **Pros**:
  - **Zero Configuration**: Single file, no server
  - **Simplicity**: No network overhead
  - **ACID Compliance**: Strong guarantees
- **Cons**:
  - **Concurrency**: Locks entire database for writes
  - **Scalability**: Not suitable for multi-user dashboards
  - **Limited Features**: No full-text search (without extensions)

### Option 4: **MySQL**
- **Type**: Relational database (RDBMS)
- **Pros**:
  - **Mature**: Widely used, extensive tooling
  - **Performance**: Fast for read-heavy workloads
- **Cons**:
  - **Feature Gaps**: Weaker window functions, no CTEs (until 8.0)
  - **Full-Text Search**: Less powerful than Postgres
  - **JSON Support**: Added later, not as robust

---

## Decision Outcome

**Chosen Option**: **PostgreSQL 16+**

### Rationale
1. **ACID Compliance**: Critical for decision tracking, task lifecycle (strong consistency)
2. **Query Power**: Complex analytics (e.g., plan drift detection) require joins, CTEs, window functions
3. **Full-Text Search**: Built-in GIN indexes for decision content, task descriptions
4. **Self-Hosted**: Docker Compose deployment, no vendor lock-in
5. **TypeScript Integration**: Excellent libraries (Drizzle ORM, pg, node-postgres)
6. **Future-Proof**: JSON columns for flexible metadata, extensions for specialized needs

### Key Features We Use
- **Schemas**: Namespace modules (portfolio, decision, agent, etc.)
- **Indexes**: B-tree (primary keys), GIN (full-text), partial (active tasks)
- **Transactions**: Multi-step operations (task assignment + notification)
- **CTEs**: Recursive queries for project hierarchies
- **Window Functions**: Momentum deltas, decision rankings
- **JSON Columns**: Flexible metadata (agent personality, custom fields)

---

## Implementation Details

### Docker Deployment
```yaml
postgres:
  image: postgres:16-alpine
  volumes:
    - postgres-data:/var/lib/postgresql/data
  environment:
    POSTGRES_DB: holocene
    POSTGRES_USER: holocene
    POSTGRES_PASSWORD: ${DB_PASSWORD}
  ports:
    - "5432:5432"
```

### Schema Organization
```sql
-- Separate schemas per module
CREATE SCHEMA portfolio;
CREATE SCHEMA decision;
CREATE SCHEMA agent;
CREATE SCHEMA task;
CREATE SCHEMA briefing;
CREATE SCHEMA risk;
CREATE SCHEMA repo;
CREATE SCHEMA session;
```

### ORM Choice: Drizzle
- **Type-safe**: Full TypeScript inference
- **Lightweight**: No heavy runtime, fast queries
- **Migrations**: Built-in migration tooling
- **Query Builder**: Fluent API, SQL-like syntax

### Example Schema (Portfolio)
```typescript
import { pgTable, serial, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const portfolios = pgTable('portfolio.portfolios', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  metadata: jsonb('metadata').$type<PortfolioMetadata>()
});
```

---

## Consequences

### Positive
- **Data Integrity**: No risk of inconsistent state (ACID)
- **Query Flexibility**: Can build complex analytics without moving to data warehouse
- **Tooling**: pgAdmin, DBeaver, psql for debugging
- **Performance**: Sub-100ms queries with proper indexing
- **Backup/Restore**: Simple pg_dump/pg_restore

### Negative
- **Schema Migrations**: Requires planning (Drizzle migrations help)
- **Scaling**: Read replicas needed for high-traffic scenarios (future)
- **Complexity**: More setup than SQLite, less flexible than NoSQL

### Mitigation Strategies
- **Migrations**: Automated via Drizzle (version-controlled SQL)
- **Indexing Strategy**: Define indexes upfront for common queries
- **Connection Pooling**: Use pg-pool to limit connections
- **Monitoring**: pg_stat_statements for slow query detection

---

## Performance Targets

| Operation | Target | Mitigation |
|-----------|--------|-----------|
| Portfolio overview | < 100ms | Indexes on foreign keys, caching |
| Decision ranking | < 200ms | Partial index on active decisions |
| Agent constellation | < 300ms | Materialized view (future) |
| Full-text search | < 500ms | GIN index on tsvector columns |

---

## Alternative Considered: Hybrid Approach
- **Primary**: PostgreSQL for relational data
- **Analytics**: ClickHouse/TimescaleDB for time-series metrics (future)
- **Search**: Elasticsearch for advanced full-text search (future V2)

**Decision**: Start with Postgres-only (MVP), evaluate later.

---

## Validation Criteria

- [x] ACID transactions work for multi-step operations
- [ ] Full-text search performs under 500ms for 10K+ decisions
- [ ] Schema migrations automated and version-controlled
- [ ] Indexes defined for all common query patterns
- [ ] Backup/restore process documented

---

## References

- [PostgreSQL Documentation](https://www.postgresql.org/docs/16/)
- [Drizzle ORM](https://orm.drizzle.team/)
- [Postgres Performance Tuning](https://wiki.postgresql.org/wiki/Performance_Optimization)

---

## Related Decisions

- **ADR-003**: Redis for Caching Strategy
- **ADR-004**: Drizzle ORM for Type-Safe Queries
