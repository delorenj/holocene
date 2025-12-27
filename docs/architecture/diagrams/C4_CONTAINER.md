# C4 Model: Container Diagram

**Level**: 2 - Container
**Purpose**: Show high-level technology choices and inter-container communication
**Audience**: Developers, architects, DevOps

---

## Diagram

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                            HOLOCENE SYSTEM                                    │
│                                                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                      WEB APPLICATION (SPA)                           │    │
│  │  Technology: React 18 + TypeScript + Vite                            │    │
│  │  Responsibilities:                                                   │    │
│  │    - Portfolio overview rendering                                    │    │
│  │    - Decision radar visualization                                    │    │
│  │    - Agent constellation graph                                       │    │
│  │    - User authentication flow                                        │    │
│  │    - Real-time WebSocket updates                                     │    │
│  └──────────────────┬────────────────────────────────────────────────────┘    │
│                     │ HTTPS (REST)                                            │
│                     ↓                                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                    API GATEWAY (Future)                              │    │
│  │  Technology: Express/Fastify (optional)                              │    │
│  │  Responsibilities:                                                   │    │
│  │    - Request routing and validation                                  │    │
│  │    - Authentication/authorization                                    │    │
│  │    - Rate limiting                                                   │    │
│  │    - Response caching                                                │    │
│  └──────────────────┬────────────────────────────────────────────────────┘    │
│                     │                                                         │
│         ┌───────────┼───────────┐                                             │
│         │           │           │                                             │
│         ↓           ↓           ↓                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                                      │
│  │Portfolio │ │Decision  │ │ Agent    │  ← Application Services (Node.js)    │
│  │ Service  │ │ Service  │ │ Service  │                                      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                                      │
│       │            │            │                                             │
│       └────────────┼────────────┘                                             │
│                    │                                                          │
│                    ↓                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                     POSTGRESQL DATABASE                              │    │
│  │  Technology: PostgreSQL 16 (Docker)                                  │    │
│  │  Schemas:                                                            │    │
│  │    - portfolio: projects, snapshots, momentum_scores                 │    │
│  │    - decision: decisions, impacts, autonomy_alerts                   │    │
│  │    - agent: agents, collaborations, effectiveness_metrics            │    │
│  │    - task: tasks, lifecycles, acceptance_criteria                    │    │
│  │    - briefing: briefs, templates, exports                            │    │
│  │    - risk: risks, blockers, scores                                   │    │
│  │    - repo: repos, checkpoints, worktrees                             │    │
│  │    - session: sessions, events, metrics                              │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                    ↑                                                          │
│                    │ reads/writes                                             │
│                    │                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │                        REDIS CACHE                                   │    │
│  │  Technology: Redis 7 (Docker)                                        │    │
│  │  Data Structures:                                                    │    │
│  │    - Strings: session tokens, cached API responses                   │    │
│  │    - Hashes: portfolio snapshots, agent rankings                     │    │
│  │    - Sets: active sessions, online agents                            │    │
│  │    - Sorted Sets: decision rankings, risk scores                     │    │
│  │    - Pub/Sub: real-time updates channel                              │    │
│  │  TTL Strategy:                                                       │    │
│  │    - Session tokens: 24h                                             │    │
│  │    - API responses: 5 minutes                                        │    │
│  │    - Real-time data: 1 minute                                        │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
                    ↑                           ↑
                    │ Event Stream              │ API Calls
                    │                           │
┌───────────────────┴───────────────────────────┴───────────────────────────────┐
│                       EXTERNAL SYSTEMS                                        │
│                                                                               │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │ Bloodbank  │  │   Flume    │  │    iMi     │  │  Jelmore   │            │
│  │  (Events)  │  │  (Tasks)   │  │  (Repos)   │  │(Sessions)  │            │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘            │
│                                                                               │
│  ┌────────────┐  ┌────────────┐                                              │
│  │  Yi Nodes  │  │   GitHub   │                                              │
│  │  (Agents)  │  │   (Auth)   │                                              │
│  └────────────┘  └────────────┘                                              │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Container Details

### **1. Web Application (SPA)**
- **Technology**: React 18, TypeScript, Vite, shadcn/ui, Tailwind CSS
- **Deployment**: Static files served via Nginx/Caddy
- **Key Libraries**:
  - **Zustand**: Client state management
  - **React Query**: Server state, caching, refetching
  - **React Router**: Client-side routing
  - **Recharts**: Data visualization
  - **Socket.io-client**: Real-time updates
- **Responsibilities**:
  - Render UI components
  - Handle user interactions
  - Manage client-side state
  - WebSocket connections for live updates
- **Scaling**: CDN for static assets (future)

### **2. API Gateway (Optional - Future)**
- **Technology**: Node.js (Express or Fastify)
- **Purpose**: Centralized API layer (currently, frontend talks directly to services)
- **Responsibilities**:
  - Validate requests (Zod schemas)
  - Authenticate/authorize (JWT middleware)
  - Rate limiting (Redis-backed)
  - Response caching (Redis)
  - Request/response logging
- **Scaling**: Horizontal scaling with load balancer

### **3. Application Services** (Embedded in Frontend - Future Extraction)
- **Technology**: TypeScript (currently client-side, future: Node.js)
- **Modules**:
  - **Portfolio Service**: GetPortfolioOverview, CalculateMomentum
  - **Decision Service**: RankDecisions, DetectAutonomyAlerts
  - **Agent Service**: GetConstellation, CalculateRankings
  - **Briefing Service**: GenerateAMBrief, ExportToPDF
  - **Risk Service**: DetectRisks, SurfaceBlockers
- **Communication**: Uses repository pattern to access data
- **Scaling**: Serverless functions (future consideration)

### **4. PostgreSQL Database**
- **Technology**: PostgreSQL 16 (Docker container)
- **Volume**: Docker volume mounted to `/var/lib/postgresql/data`
- **Schemas** (separate namespaces per module):
  - `portfolio`: Portfolio data
  - `decision`: Decision tracking
  - `agent`: Agent metadata and metrics
  - `task`: Task management
  - `briefing`: Briefing and reports
  - `risk`: Risk and blocker data
  - `repo`: Repository metadata
  - `session`: Session history
- **Indexes**:
  - B-tree: Primary keys, foreign keys, frequently filtered columns
  - GiST: Full-text search (decision content, task descriptions)
  - Partial: Filtered indexes for active tasks, recent decisions
- **Performance**:
  - Connection pooling (pg-pool)
  - Query optimization (EXPLAIN ANALYZE)
  - Vacuuming and analyze automation
- **Backup**: Daily automated backups (pg_dump)

### **5. Redis Cache**
- **Technology**: Redis 7 (Docker container)
- **Use Cases**:
  - **Session Store**: JWT tokens, user sessions
  - **API Response Cache**: Portfolio snapshots, decision rankings
  - **Real-time Data**: Live metrics, active sessions
  - **Pub/Sub**: Real-time updates to frontend
  - **Rate Limiting**: API request throttling
- **Data Structures**:
  - **Strings**: Cached JSON responses, session tokens
  - **Hashes**: Structured data (portfolio snapshots)
  - **Sets**: Collections (active agents, online users)
  - **Sorted Sets**: Rankings (decisions, risks)
  - **Streams**: Event logs (future)
- **Eviction Policy**: `allkeys-lru` (least recently used)
- **Persistence**: RDB snapshots every 5 minutes

---

## Communication Patterns

### Frontend ↔ Backend
- **Protocol**: HTTPS (REST), WebSocket (real-time)
- **Authentication**: JWT bearer tokens
- **Data Format**: JSON
- **Error Handling**: HTTP status codes + error payloads

### Backend ↔ PostgreSQL
- **Protocol**: TCP (Postgres wire protocol)
- **ORM**: Drizzle (type-safe query builder)
- **Connection Pooling**: max 20 connections
- **Transactions**: ACID guarantees for multi-step operations

### Backend ↔ Redis
- **Protocol**: RESP (Redis Serialization Protocol)
- **Client**: ioredis (high-performance Node.js client)
- **Pipelining**: Batch commands for efficiency
- **Pub/Sub**: Separate connections for subscribers

### Holocene ↔ Bloodbank
- **Protocol**: HTTP webhooks (n8n)
- **Pattern**: Event-driven (subscribe to topics)
- **Events**: Task lifecycle, decisions, sessions
- **Retry Logic**: Exponential backoff

### Holocene ↔ External APIs (Flume, iMi, Yi, Jelmore)
- **Protocol**: REST (HTTPS)
- **Authentication**: API keys or OAuth tokens
- **Caching**: Redis (5-minute TTL for reads)
- **Circuit Breaker**: Fail gracefully on service outages

---

## Deployment Model (Docker Compose)

```yaml
version: '3.8'
services:
  holocene-frontend:
    image: holocene-web:latest
    ports:
      - "80:80"
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:16-alpine
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: holocene
      POSTGRES_USER: holocene
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes

volumes:
  postgres-data:
  redis-data:
```

---

## API Endpoints (Future API Gateway)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/portfolio` | GET | Get portfolio overview |
| `/api/portfolio/:id` | GET | Get project details |
| `/api/decisions` | GET | Get ranked decisions |
| `/api/decisions/:id` | GET | Get decision details |
| `/api/agents` | GET | Get agent constellation |
| `/api/agents/:id` | GET | Get agent profile |
| `/api/tasks` | GET | Get task list |
| `/api/tasks/:id` | GET | Get task details |
| `/api/briefing/am` | GET | Generate AM brief |
| `/api/briefing/pm` | GET | Generate PM brief |
| `/api/risks` | GET | Get active risks |
| `/api/auth/login` | POST | GitHub OAuth login |
| `/api/auth/refresh` | POST | Refresh JWT token |

---

## Scalability Considerations

### Current (MVP)
- **Single-server deployment**: All containers on one host
- **Vertical scaling**: Increase CPU/RAM as needed

### Future (V1+)
- **Horizontal scaling**: Multiple frontend replicas behind load balancer
- **Database replication**: Read replicas for analytics queries
- **Redis clustering**: Sharding for high-throughput caching
- **CDN**: Cloudflare/Netlify for static assets

---

**Next Level**: Component Diagram (Level 3) for individual services
