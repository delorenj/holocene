# C4 Model: System Context Diagram

**Level**: 1 - System Context
**Purpose**: Show how Holocene fits into the 33GOD ecosystem
**Audience**: Non-technical stakeholders, architects

---

## Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          33GOD ECOSYSTEM                                 │
│                                                                          │
│  ┌────────────┐                                        ┌──────────────┐ │
│  │  Founder   │───────── monitors via ────────────────→│   Holocene   │ │
│  │   (Me)     │←────── briefings from ────────────────│  Dashboard   │ │
│  └────────────┘                                        └──────┬───────┘ │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │ Yi Nodes   │←──── queries agent data ────────────────────┤         │
│  │ (Agents)   │                                              │         │
│  └────────────┘                                              │         │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │   Flume    │←──── queries tasks/projects ────────────────┤         │
│  │  (Tasks)   │                                              │         │
│  └────────────┘                                              │         │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │    iMi     │←──── queries repos/worktrees ───────────────┤         │
│  │  (Repos)   │                                              │         │
│  └────────────┘                                              │         │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │  Jelmore   │←──── queries sessions ──────────────────────┤         │
│  │ (Sessions) │                                              │         │
│  └────────────┘                                              │         │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │ Bloodbank  │←══════ subscribes to events ════════════════╪═════════╣
│  │  (Events)  │════════ publishes events ═══════════════════►         │
│  └────────────┘                                                        │
│                                                                         │
│  ┌────────────┐                                                        │
│  │   GitHub   │←──── OAuth login ───────────────────────────┤         │
│  │   (Auth)   │                                              │         │
│  └────────────┘                                              │         │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │ PostgreSQL │←──── stores data ───────────────────────────┤         │
│  │    (DB)    │                                              │         │
│  └────────────┘                                              │         │
│                                                               │         │
│  ┌────────────┐                                              │         │
│  │   Redis    │←──── caching ───────────────────────────────┘         │
│  │  (Cache)   │                                                        │
│  └────────────┘                                                        │
└──────────────────────────────────────────────────────────────────────────┘

Legend:
────→  Synchronous request/response
═══→  Asynchronous event stream
```

---

## Relationships

| From | To | Interaction | Protocol |
|------|----|-----------|------------|
| Founder | Holocene | Monitors portfolio, reviews decisions | HTTPS (Web UI) |
| Holocene | Bloodbank | Subscribes to events (tasks, decisions, sessions) | Event Stream (n8n webhooks) |
| Holocene | Flume | Queries tasks, projects, roadmaps | REST API / Direct DB |
| Holocene | iMi | Queries repos, worktrees, checkpoints | REST API / Direct DB |
| Holocene | Yi Nodes | Queries agent status, contributions, memories | REST API / Direct DB |
| Holocene | Jelmore | Queries session history, active sessions | REST API / Direct DB |
| Holocene | GitHub | OAuth authentication, activity ingestion | GitHub API |
| Holocene | PostgreSQL | Stores aggregated dashboard data | SQL |
| Holocene | Redis | Caches frequently accessed data, real-time state | Redis Protocol |

---

## External Systems

### **Bloodbank** (Event Streaming Platform)
- **Purpose**: Central nervous system for 33GOD pipeline events
- **Technology**: n8n workflow automation
- **Events Consumed by Holocene**:
  - `flume.task.created`
  - `flume.task.completed`
  - `yi.decision.made`
  - `jelmore.session.started`
  - `jelmore.session.ended`
  - `imi.checkpoint.created`

### **Flume** (Project & Task Management)
- **Purpose**: Orchestrates projects, tasks, and assignments
- **Data Accessed**:
  - Projects, Tasks, Roadmaps
  - Task lifecycle states
  - Plan vs. execution drift

### **iMi** (Repository Management)
- **Purpose**: Manages git repos, worktrees, and checkpoints
- **Data Accessed**:
  - Repos, Branches, Commits
  - Worktrees (agent workspaces)
  - Checkpoints (serialized snapshots)

### **Yi Nodes** (Agent Orchestrators)
- **Purpose**: Anthropomorphized agents with memory and autonomy
- **Data Accessed**:
  - Agent profiles (salary, personality, skills)
  - Contributions (commits, PRs, decisions)
  - Domains of expertise and experience

### **Jelmore** (Agentic Coding Interface)
- **Purpose**: Unified interface for Claude Code, Codex, etc.
- **Data Accessed**:
  - Session history
  - Active sessions (joinable tmux instances)
  - Token usage, model selection

### **GitHub** (Version Control & Auth)
- **Purpose**: Code repository and OAuth provider
- **Integration Points**:
  - OAuth login
  - Activity ingestion (commits, PRs, issues)
  - Repository analytics

---

## Deployment Context

```
┌─────────────────────────────────────────┐
│      Self-Hosted Infrastructure         │
│                                         │
│  ┌────────────────────────────────────┐ │
│  │     Holocene Frontend (Vite)       │ │
│  │     Served via Nginx/Caddy         │ │
│  └────────────────────────────────────┘ │
│                   │                      │
│                   ↓                      │
│  ┌────────────────────────────────────┐ │
│  │   PostgreSQL (Docker Container)    │ │
│  └────────────────────────────────────┘ │
│                   │                      │
│                   ↓                      │
│  ┌────────────────────────────────────┐ │
│  │     Redis (Docker Container)       │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
           │                  │
           │ Event Stream     │ API Calls
           ↓                  ↓
┌─────────────────────────────────────────┐
│       33GOD Pipeline Services           │
│  (Flume, iMi, Yi, Jelmore, Bloodbank)   │
└─────────────────────────────────────────┘
```

---

## Key Design Decisions

1. **Self-Hosted**: All data stays on local infrastructure (data sovereignty)
2. **Event-Driven**: Bloodbank events provide real-time updates without polling
3. **Polyglot Data Access**: Direct DB access for reads, API calls for writes
4. **Stateless Frontend**: All state in PostgreSQL/Redis (no localStorage for critical data)
5. **GitHub as IdP**: Leverages existing GitHub org for authentication

---

**Next Level**: Container Diagram (Level 2)
