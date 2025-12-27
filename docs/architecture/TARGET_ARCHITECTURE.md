# Holocene Target Architecture

**Version:** 1.0.0
**Date:** 2025-12-27
**Architect:** System Architect (High Council of Architects)
**Status:** APPROVED

---

## Executive Summary

This document defines the target architecture for **Holocene**, a mission control dashboard for the 33GOD Agentic Development Pipeline. The architecture prioritizes high modularity, Single Responsibility Principle (SRP), and layered abstraction to enable maintainability, testability, and scalability.

**Key Architectural Principles:**
- **High Modularity**: Components are small, focused, and many
- **Single Responsibility**: Each module does one thing well
- **Layered Abstraction**: Clear separation between data, business logic, and presentation
- **Dependency Inversion**: High-level modules don't depend on low-level details
- **Interface Segregation**: Clients depend only on interfaces they use

---

## Table of Contents

1. [System Context](#system-context)
2. [Architecture Drivers](#architecture-drivers)
3. [Layered Architecture](#layered-architecture)
4. [Module Boundaries](#module-boundaries)
5. [Component Interfaces](#component-interfaces)
6. [Directory Structure](#directory-structure)
7. [Dependency Graph](#dependency-graph)
8. [Architectural Patterns](#architectural-patterns)
9. [Technology Stack Alignment](#technology-stack-alignment)
10. [Non-Functional Requirements](#non-functional-requirements)

---

## 1. System Context

### Purpose
Holocene serves as the central nervous system for monitoring and controlling the 33GOD Agentic Development Pipeline, providing high-signal visibility into:
- Multi-project portfolio health
- Agent collaboration and effectiveness
- Decision tracking and impact analysis
- Risk detection and blocker management

### External Systems Integration
- **33GOD Pipeline Components:**
  - **iMi**: Repo and worktree management
  - **Flume**: Project and task orchestration
  - **Yi Nodes**: Anthropomorphized agent orchestrators
  - **Jelmore**: Unified agentic coding interface
  - **Bloodbank**: Event streaming and coordination
- **Third-Party Systems:**
  - GitHub (OAuth, activity ingestion)
  - Plane (project management)
  - Obsidian (documentation sync)

---

## 2. Architecture Drivers

### Functional Requirements
1. **Portfolio Overview**: Real-time multi-project status
2. **Decision Radar**: Ranked, impactful decision feed
3. **Agent Constellation**: Collaboration graphs and metrics
4. **Plan Drift Detection**: Commitment vs. execution analysis
5. **Risk Management**: Automated blocker surfacing
6. **Briefing Generation**: AM/PM automated summaries

### Quality Attributes (Prioritized)
1. **Maintainability** (CRITICAL): Must support rapid iteration and refactoring
2. **Performance** (HIGH): Sub-second response times, real-time updates
3. **Scalability** (MEDIUM): Handle 10-100 concurrent projects
4. **Testability** (HIGH): 80%+ code coverage with unit and integration tests
5. **Security** (HIGH): Self-hosted, role-based access control
6. **Extensibility** (MEDIUM): Plugin architecture for future enhancements

### Constraints
- **Self-hosted deployment**: No cloud dependencies for core functionality
- **Tech stack**: React + TypeScript + Postgres + Redis
- **Performance budget**: 2s initial load, 200ms interaction response
- **Data sovereignty**: All telemetry stored locally

---

## 3. Layered Architecture

We adopt a **clean architecture** approach with strict dependency rules:

```
┌─────────────────────────────────────────────────────────┐
│              PRESENTATION LAYER (UI)                    │
│  React Components, State Management, UI Logic           │
│  ↓ depends on ↓                                         │
├─────────────────────────────────────────────────────────┤
│           APPLICATION LAYER (Use Cases)                 │
│  Business Workflows, Orchestration, Commands/Queries    │
│  ↓ depends on ↓                                         │
├─────────────────────────────────────────────────────────┤
│              DOMAIN LAYER (Core)                        │
│  Business Entities, Value Objects, Domain Logic         │
│  ↑ implements ↑                                         │
├─────────────────────────────────────────────────────────┤
│         INFRASTRUCTURE LAYER (Adapters)                 │
│  Database, APIs, External Services, Repositories        │
└─────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

#### **Presentation Layer** (`/src/presentation`)
- **Purpose**: User interface and interaction logic
- **Responsibilities**:
  - Render UI components using React
  - Handle user input and events
  - Manage UI state (forms, modals, filters)
  - Format data for display
- **Key Modules**: `components/`, `pages/`, `hooks/`, `context/`, `routing/`
- **Dependencies**: Application Layer interfaces ONLY
- **Testing**: Component tests, snapshot tests, interaction tests

#### **Application Layer** (`/src/application`)
- **Purpose**: Orchestrate business workflows and use cases
- **Responsibilities**:
  - Implement use cases (commands and queries)
  - Coordinate domain entities
  - Handle application-level validation
  - Manage transactions and error handling
- **Key Modules**: `use-cases/`, `commands/`, `queries/`, `services/`
- **Dependencies**: Domain Layer, Infrastructure interfaces
- **Testing**: Integration tests, use case tests

#### **Domain Layer** (`/src/domain`)
- **Purpose**: Core business logic and rules (framework-agnostic)
- **Responsibilities**:
  - Define business entities and value objects
  - Implement domain logic and invariants
  - Define repository interfaces
  - Emit domain events
- **Key Modules**: `entities/`, `value-objects/`, `repositories/`, `events/`, `exceptions/`
- **Dependencies**: NONE (pure TypeScript)
- **Testing**: Unit tests (100% coverage target)

#### **Infrastructure Layer** (`/src/infrastructure`)
- **Purpose**: Technical implementations and adapters
- **Responsibilities**:
  - Implement repository interfaces
  - Integrate with external systems (APIs, databases)
  - Handle persistence and caching
  - Manage configuration and environment
- **Key Modules**: `database/`, `api/`, `cache/`, `events/`, `auth/`
- **Dependencies**: Domain interfaces
- **Testing**: Integration tests, contract tests

---

## 4. Module Boundaries

### Core Modules (Domain-Driven Design)

#### **Portfolio Module**
- **Responsibility**: Manage multi-project portfolio state and metrics
- **Entities**: `Portfolio`, `ProjectSnapshot`, `MomentumScore`
- **Use Cases**: `GetPortfolioOverview`, `CalculateMomentumDelta`
- **Boundaries**: Does NOT directly access repo data (delegates to Repo module)

#### **Decision Module**
- **Responsibility**: Track, rank, and analyze impactful decisions
- **Entities**: `Decision`, `DecisionImpact`, `AutonomyLevel`
- **Use Cases**: `RankDecisions`, `DetectAutonomyAlert`, `GetDecisionHistory`
- **Boundaries**: Independent of agent or task modules

#### **Agent Module**
- **Responsibility**: Model agent behavior, collaboration, and effectiveness
- **Entities**: `Agent`, `AgentCollaboration`, `EffectivenessMetric`
- **Use Cases**: `GetAgentConstellation`, `CalculateAgentRank`, `TrackPairHighlights`
- **Boundaries**: Consumes events, does NOT orchestrate tasks

#### **Task Module**
- **Responsibility**: Task lifecycle, assignment, and execution tracking
- **Entities**: `Task`, `TaskLifecycle`, `AcceptanceCriteria`
- **Use Cases**: `AssignTask`, `DetectPlanDrift`, `ValidateCompletion`
- **Boundaries**: References agents but doesn't manage them

#### **Briefing Module**
- **Responsibility**: Generate automated summaries and reports
- **Entities**: `Brief`, `BriefTemplate`, `DiffSummary`
- **Use Cases**: `GenerateAMBrief`, `GeneratePMBrief`, `ExportToPDF`
- **Boundaries**: Read-only consumer of all other modules

#### **Risk Module**
- **Responsibility**: Detect blockers, risks, and anomalies
- **Entities**: `Risk`, `Blocker`, `RiskScore`
- **Use Cases**: `DetectRisks`, `SurfaceBlockers`, `PrioritizeRisks`
- **Boundaries**: Aggregates data from portfolio, task, and agent modules

#### **Repository Module**
- **Responsibility**: Manage repo metadata, checkpoints, and worktrees
- **Entities**: `Repo`, `Checkpoint`, `Worktree`, `Commit`
- **Use Cases**: `GetRepoActivity`, `CreateCheckpoint`, `RestoreCheckpoint`
- **Boundaries**: Integrates with iMi, Git, and Bloodbank events

#### **Session Module**
- **Responsibility**: Track long-running agentic sessions (Jelmore)
- **Entities**: `Session`, `SessionEvent`, `SessionMetrics`
- **Use Cases**: `StartSession`, `JoinSession`, `GetSessionHistory`
- **Boundaries**: Produces events consumed by other modules

---

## 5. Component Interfaces

### Interface Design Principles
1. **Dependency Inversion**: Define interfaces in the domain/application layers
2. **Interface Segregation**: Small, focused interfaces (not God interfaces)
3. **Explicit Contracts**: Use TypeScript strict types and JSDoc
4. **Versioning**: Include version numbers in critical interfaces

### Key Interfaces

#### Repository Interfaces (Domain Layer)
```typescript
// src/domain/repositories/IPortfolioRepository.ts
export interface IPortfolioRepository {
  findById(id: string): Promise<Portfolio | null>;
  findAll(filters?: PortfolioFilters): Promise<Portfolio[]>;
  save(portfolio: Portfolio): Promise<void>;
  delete(id: string): Promise<void>;
}

// src/domain/repositories/IDecisionRepository.ts
export interface IDecisionRepository {
  findByImpact(threshold: number): Promise<Decision[]>;
  findRecent(limit: number): Promise<Decision[]>;
  save(decision: Decision): Promise<void>;
}
```

#### Service Interfaces (Application Layer)
```typescript
// src/application/services/IBriefingService.ts
export interface IBriefingService {
  generateBrief(request: BriefRequest): Promise<Brief>;
  exportToPDF(briefId: string): Promise<Buffer>;
  scheduleRecurring(schedule: BriefSchedule): Promise<void>;
}

// src/application/services/IRiskDetectionService.ts
export interface IRiskDetectionService {
  detectRisks(scope: RiskScope): Promise<Risk[]>;
  calculateRiskScore(context: RiskContext): Promise<number>;
  prioritize(risks: Risk[]): Promise<Risk[]>;
}
```

#### Event Interfaces (Domain Layer)
```typescript
// src/domain/events/IDomainEvent.ts
export interface IDomainEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

// src/domain/events/IEventBus.ts
export interface IEventBus {
  publish(event: IDomainEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): void;
  unsubscribe(eventType: string, handler: EventHandler): void;
}
```

#### External Integration Interfaces (Infrastructure)
```typescript
// src/infrastructure/integrations/IBloodbankClient.ts
export interface IBloodbankClient {
  publishEvent(event: BloodbankEvent): Promise<void>;
  subscribeToEvents(topics: string[], callback: EventCallback): void;
  getEventHistory(query: EventQuery): Promise<BloodbankEvent[]>;
}

// src/infrastructure/integrations/IFlumeClient.ts
export interface IFlumeClient {
  getProjects(): Promise<Project[]>;
  getTasks(projectId: string): Promise<Task[]>;
  updateTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
}
```

---

## 6. Directory Structure

This structure reflects architectural layers and module boundaries:

```
holocene/
├── src/
│   ├── domain/                      # Pure business logic (no framework deps)
│   │   ├── entities/
│   │   │   ├── portfolio/
│   │   │   │   ├── Portfolio.ts
│   │   │   │   ├── ProjectSnapshot.ts
│   │   │   │   └── MomentumScore.ts
│   │   │   ├── decision/
│   │   │   │   ├── Decision.ts
│   │   │   │   ├── DecisionImpact.ts
│   │   │   │   └── AutonomyLevel.ts
│   │   │   ├── agent/
│   │   │   │   ├── Agent.ts
│   │   │   │   ├── AgentCollaboration.ts
│   │   │   │   └── EffectivenessMetric.ts
│   │   │   ├── task/
│   │   │   │   ├── Task.ts
│   │   │   │   ├── TaskLifecycle.ts
│   │   │   │   └── AcceptanceCriteria.ts
│   │   │   ├── briefing/
│   │   │   ├── risk/
│   │   │   ├── repo/
│   │   │   └── session/
│   │   ├── value-objects/           # Immutable value types
│   │   │   ├── TaskId.ts
│   │   │   ├── AgentId.ts
│   │   │   ├── TimeWindow.ts
│   │   │   └── SalaryLevel.ts
│   │   ├── repositories/            # Interface definitions
│   │   │   ├── IPortfolioRepository.ts
│   │   │   ├── IDecisionRepository.ts
│   │   │   ├── IAgentRepository.ts
│   │   │   └── ITaskRepository.ts
│   │   ├── events/                  # Domain events
│   │   │   ├── IDomainEvent.ts
│   │   │   ├── IEventBus.ts
│   │   │   ├── DecisionCreatedEvent.ts
│   │   │   └── TaskCompletedEvent.ts
│   │   └── exceptions/              # Domain-specific errors
│   │       ├── DomainException.ts
│   │       ├── ValidationException.ts
│   │       └── NotFoundException.ts
│   │
│   ├── application/                 # Use cases and orchestration
│   │   ├── use-cases/
│   │   │   ├── portfolio/
│   │   │   │   ├── GetPortfolioOverview.ts
│   │   │   │   ├── CalculateMomentumDelta.ts
│   │   │   │   └── GetTopMovingProjects.ts
│   │   │   ├── decision/
│   │   │   │   ├── RankDecisions.ts
│   │   │   │   ├── DetectAutonomyAlert.ts
│   │   │   │   └── GetDecisionHistory.ts
│   │   │   ├── agent/
│   │   │   │   ├── GetAgentConstellation.ts
│   │   │   │   ├── CalculateAgentRank.ts
│   │   │   │   └── TrackPairHighlights.ts
│   │   │   ├── task/
│   │   │   ├── briefing/
│   │   │   └── risk/
│   │   ├── services/                # Application services
│   │   │   ├── IBriefingService.ts
│   │   │   ├── IRiskDetectionService.ts
│   │   │   ├── INotificationService.ts
│   │   │   └── IAuditService.ts
│   │   ├── dto/                     # Data Transfer Objects
│   │   │   ├── PortfolioDTO.ts
│   │   │   ├── DecisionDTO.ts
│   │   │   └── BriefDTO.ts
│   │   └── validators/              # Input validation
│   │       ├── PortfolioValidator.ts
│   │       └── DecisionValidator.ts
│   │
│   ├── infrastructure/              # External integrations
│   │   ├── database/
│   │   │   ├── postgres/
│   │   │   │   ├── PostgresPortfolioRepository.ts
│   │   │   │   ├── PostgresDecisionRepository.ts
│   │   │   │   ├── migrations/
│   │   │   │   └── seeders/
│   │   │   └── schema/
│   │   │       ├── portfolio.schema.ts
│   │   │       ├── decision.schema.ts
│   │   │       └── indexes.sql
│   │   ├── cache/
│   │   │   ├── RedisCache.ts
│   │   │   └── ICacheProvider.ts
│   │   ├── events/
│   │   │   ├── BloodbankEventBus.ts
│   │   │   └── InMemoryEventBus.ts
│   │   ├── integrations/
│   │   │   ├── bloodbank/
│   │   │   │   ├── BloodbankClient.ts
│   │   │   │   └── BloodbankEventMapper.ts
│   │   │   ├── flume/
│   │   │   │   └── FlumeClient.ts
│   │   │   ├── imi/
│   │   │   │   └── ImiClient.ts
│   │   │   ├── github/
│   │   │   │   ├── GitHubClient.ts
│   │   │   │   └── GitHubOAuthProvider.ts
│   │   │   └── jelmore/
│   │   │       └── JelmoreClient.ts
│   │   ├── auth/
│   │   │   ├── AuthService.ts
│   │   │   ├── JWTProvider.ts
│   │   │   └── RBACProvider.ts
│   │   └── config/
│   │       ├── database.config.ts
│   │       ├── redis.config.ts
│   │       └── integrations.config.ts
│   │
│   ├── presentation/                # UI layer
│   │   ├── components/
│   │   │   ├── common/              # Reusable UI primitives
│   │   │   │   ├── Button/
│   │   │   │   ├── Card/
│   │   │   │   ├── Modal/
│   │   │   │   └── DataGrid/
│   │   │   ├── portfolio/           # Feature-specific components
│   │   │   │   ├── PortfolioOverview/
│   │   │   │   ├── ProjectCard/
│   │   │   │   └── MomentumChart/
│   │   │   ├── decision/
│   │   │   │   ├── DecisionRadar/
│   │   │   │   ├── DecisionCard/
│   │   │   │   └── ImpactMeter/
│   │   │   ├── agent/
│   │   │   │   ├── AgentConstellation/
│   │   │   │   ├── CollaborationGraph/
│   │   │   │   └── AgentRankList/
│   │   │   ├── task/
│   │   │   ├── briefing/
│   │   │   └── risk/
│   │   ├── pages/                   # Route-level pages
│   │   │   ├── DashboardPage.tsx
│   │   │   ├── ProjectDetailPage.tsx
│   │   │   ├── DecisionRadarPage.tsx
│   │   │   ├── AgentConstellationPage.tsx
│   │   │   └── BriefingPage.tsx
│   │   ├── hooks/                   # Custom React hooks
│   │   │   ├── usePortfolio.ts
│   │   │   ├── useDecisions.ts
│   │   │   ├── useAgents.ts
│   │   │   └── useRealTimeUpdates.ts
│   │   ├── context/                 # React context providers
│   │   │   ├── AuthContext.tsx
│   │   │   ├── ThemeContext.tsx
│   │   │   └── NotificationContext.tsx
│   │   ├── routing/
│   │   │   ├── AppRouter.tsx
│   │   │   └── ProtectedRoute.tsx
│   │   └── state/                   # State management (Zustand/Redux)
│   │       ├── portfolioStore.ts
│   │       ├── decisionStore.ts
│   │       └── agentStore.ts
│   │
│   ├── shared/                      # Cross-cutting concerns
│   │   ├── types/                   # Shared TypeScript types
│   │   ├── utils/                   # Helper functions
│   │   ├── constants/               # Application constants
│   │   └── errors/                  # Error handling utilities
│   │
│   └── main.tsx                     # Application entry point
│
├── tests/                           # Test suites
│   ├── unit/                        # Unit tests (domain, application)
│   │   ├── domain/
│   │   └── application/
│   ├── integration/                 # Integration tests
│   │   ├── infrastructure/
│   │   └── api/
│   ├── e2e/                         # End-to-end tests
│   └── fixtures/                    # Test data and mocks
│
├── docs/                            # Documentation
│   ├── architecture/
│   │   ├── adrs/                    # Architecture Decision Records
│   │   ├── diagrams/                # C4 diagrams, ERDs
│   │   └── patterns/                # Pattern documentation
│   ├── api/                         # API documentation
│   └── guides/                      # Developer guides
│
├── config/                          # Configuration files
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── tailwind.config.js
│   └── tsconfig.json
│
├── scripts/                         # Build and deployment scripts
├── public/                          # Static assets
└── package.json
```

### Directory Naming Conventions
- **Lowercase with hyphens**: `use-cases/`, `value-objects/`
- **PascalCase for files**: `Portfolio.ts`, `GetPortfolioOverview.ts`
- **Feature folders**: Group by domain concept (portfolio, decision, agent)
- **Index files**: Use `index.ts` for public module exports only

---

## 7. Dependency Graph

### High-Level Module Dependencies

```
┌─────────────────────────────────────────────────────────────────┐
│                      PRESENTATION LAYER                         │
│  [Portfolio UI] [Decision UI] [Agent UI] [Briefing UI]          │
└────────────────────────┬────────────────────────────────────────┘
                         │ uses
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                            │
│  [Portfolio UC] [Decision UC] [Agent UC] [Briefing UC]          │
└────────────────────────┬────────────────────────────────────────┘
                         │ orchestrates
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│                      DOMAIN LAYER                               │
│  [Portfolio] [Decision] [Agent] [Task] [Risk] [Session]         │
└────────────────────────┬────────────────────────────────────────┘
                         ↑ implements
                         │
┌─────────────────────────────────────────────────────────────────┐
│                  INFRASTRUCTURE LAYER                           │
│  [Postgres] [Redis] [Bloodbank] [Flume] [GitHub] [Auth]         │
└─────────────────────────────────────────────────────────────────┘
```

### Dependency Rules (Enforced via ESLint)
1. **Presentation** → Application interfaces only (no direct infrastructure)
2. **Application** → Domain entities + Infrastructure interfaces
3. **Domain** → NO external dependencies (pure TypeScript)
4. **Infrastructure** → Domain interfaces only

### Circular Dependency Prevention
- Use **dependency injection** at module boundaries
- Define interfaces in the layer that **uses** them (not implements)
- Use **event-driven communication** for cross-module interactions

---

## 8. Architectural Patterns

### 8.1 Repository Pattern
**Purpose**: Decouple domain logic from data access
**Application**: All entity persistence (Portfolio, Decision, Agent, etc.)
**Benefits**: Testability (mock repositories), database-agnostic domain

```typescript
// Domain defines interface
interface IPortfolioRepository {
  findById(id: string): Promise<Portfolio>;
}

// Infrastructure implements
class PostgresPortfolioRepository implements IPortfolioRepository {
  async findById(id: string): Promise<Portfolio> {
    // SQL query implementation
  }
}
```

### 8.2 Use Case Pattern
**Purpose**: Encapsulate single business operations
**Application**: All user actions (GetPortfolioOverview, RankDecisions)
**Benefits**: Testable workflows, clear separation of concerns

```typescript
class GetPortfolioOverview {
  constructor(
    private portfolioRepo: IPortfolioRepository,
    private projectRepo: IProjectRepository
  ) {}

  async execute(userId: string): Promise<PortfolioDTO> {
    // Orchestrate domain logic
  }
}
```

### 8.3 Event-Driven Architecture
**Purpose**: Decouple modules via asynchronous events
**Application**: Bloodbank integration, cross-module notifications
**Benefits**: Loose coupling, auditability, integration with 33GOD pipeline

```typescript
// Publish domain event
class Task {
  complete() {
    this.status = TaskStatus.DONE;
    this.emit(new TaskCompletedEvent(this.id));
  }
}

// Subscribe to event
eventBus.subscribe('TaskCompleted', async (event) => {
  await briefingService.regenerateBrief(event.taskId);
});
```

### 8.4 CQRS (Command Query Responsibility Segregation)
**Purpose**: Separate read and write operations
**Application**: High-read scenarios (portfolio overview) vs. writes (decision creation)
**Benefits**: Optimized read models, scalability

```typescript
// Command (write)
class CreateDecisionCommand {
  execute(data: DecisionDTO): Promise<void>;
}

// Query (read)
class GetDecisionHistoryQuery {
  execute(filters: DecisionFilters): Promise<DecisionDTO[]>;
}
```

### 8.5 Factory Pattern
**Purpose**: Encapsulate complex object creation
**Application**: Entity creation with validation, DTO mapping
**Benefits**: Consistent instantiation, validation at creation

```typescript
class AgentFactory {
  static create(data: AgentDTO): Agent {
    // Validation and construction logic
    return new Agent(/* ... */);
  }
}
```

### 8.6 Strategy Pattern
**Purpose**: Interchangeable algorithms
**Application**: Risk scoring algorithms, briefing templates
**Benefits**: Extensibility, testability

```typescript
interface RiskScoringStrategy {
  calculate(context: RiskContext): number;
}

class WeightedRiskScoring implements RiskScoringStrategy {
  calculate(context: RiskContext): number {
    // Implementation
  }
}
```

### 8.7 Adapter Pattern
**Purpose**: Integrate external systems with incompatible interfaces
**Application**: Bloodbank, Flume, GitHub API clients
**Benefits**: Isolation of external dependencies

```typescript
class BloodbankAdapter implements IEventBus {
  constructor(private bloodbankClient: BloodbankClient) {}

  async publish(event: DomainEvent): Promise<void> {
    const bloodbankEvent = this.mapToBloodbank(event);
    await this.bloodbankClient.publishEvent(bloodbankEvent);
  }
}
```

---

## 9. Technology Stack Alignment

### Frontend
- **React 18+**: Component-based UI (aligns with presentation layer)
- **TypeScript 5+**: Type safety across all layers
- **Vite**: Fast build tool (development velocity)
- **shadcn/ui + Tailwind**: Consistent, accessible components
- **Zustand**: Lightweight state management (presentation layer)
- **React Query**: Server state management (caching, refetching)

### Backend
- **Node.js (Future)**: Optional API layer for complex operations
- **Express/Fastify**: RESTful API (if needed)

### Data Layer
- **PostgreSQL 16+**: Relational data (projects, decisions, agents)
- **Redis 7+**: Caching and real-time data (session state, live metrics)
- **Drizzle ORM**: Type-safe query builder (infrastructure layer)

### Authentication
- **JWT**: Token-based auth
- **Passport.js**: GitHub OAuth integration

### Testing
- **Vitest**: Unit and integration testing (fast, Vite-native)
- **React Testing Library**: Component testing
- **Playwright**: E2E testing

### DevOps
- **Docker**: Containerization (Postgres, Redis)
- **Docker Compose**: Local development orchestration
- **GitHub Actions**: CI/CD (if needed)

---

## 10. Non-Functional Requirements

### Performance
- **Initial Load**: < 2 seconds (cached assets)
- **Interaction Response**: < 200ms (optimistic UI updates)
- **Database Queries**: < 100ms (p95), use indexes and caching
- **Real-time Updates**: < 500ms latency (WebSocket/Redis Pub/Sub)

### Scalability
- **Projects**: Support 10-100 concurrent projects
- **Decisions**: 10K+ decisions with sub-second search
- **Agents**: 50-200 active agents
- **Sessions**: 500+ historical sessions

### Security
- **Authentication**: JWT with refresh tokens, session expiry
- **Authorization**: RBAC (Founder, PM, Engineer roles)
- **Data Encryption**: TLS for transit, encrypted secrets at rest
- **Audit Logging**: All decision changes, access logs

### Maintainability
- **Code Coverage**: 80%+ (100% for domain layer)
- **Linting**: ESLint + Prettier (enforced pre-commit)
- **Documentation**: JSDoc for all public APIs
- **Dependency Management**: Quarterly security audits

### Testability
- **Unit Tests**: All domain entities, use cases
- **Integration Tests**: Repository implementations, API clients
- **E2E Tests**: Critical user journeys (portfolio overview, decision creation)

### Accessibility
- **WCAG 2.1 AA**: Keyboard navigation, screen reader support
- **Color Contrast**: 4.5:1 minimum
- **Semantic HTML**: Proper landmarks and ARIA labels

---

## Appendix A: Module Interface Summary

| Module | Key Entities | Primary Interfaces | Dependencies |
|--------|--------------|-------------------|--------------|
| Portfolio | Portfolio, ProjectSnapshot | IPortfolioRepository, IProjectRepository | None |
| Decision | Decision, DecisionImpact | IDecisionRepository, IRankingService | None |
| Agent | Agent, AgentCollaboration | IAgentRepository, ICollaborationService | None |
| Task | Task, TaskLifecycle | ITaskRepository, ITaskLifecycleService | Agent (weak) |
| Briefing | Brief, BriefTemplate | IBriefingService, IExportService | All (read-only) |
| Risk | Risk, Blocker | IRiskDetectionService | Portfolio, Task, Agent |
| Repo | Repo, Checkpoint, Worktree | IRepoRepository, ICheckpointService | iMi, Git |
| Session | Session, SessionEvent | ISessionRepository, IEventStreamService | Jelmore, Bloodbank |

---

## Appendix B: Technology Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture Style | Clean Architecture (Layered) | High maintainability, testability, SRP |
| Frontend Framework | React + TypeScript | Ecosystem maturity, type safety |
| State Management | Zustand + React Query | Simplicity, performance |
| Database | PostgreSQL | Relational data, ACID guarantees |
| Caching | Redis | High-performance key-value store |
| ORM | Drizzle | Type-safe, lightweight, migrations |
| Testing | Vitest + RTL + Playwright | Fast, modern, comprehensive |
| Build Tool | Vite | Speed, ESM-native, DX |

---

## Appendix C: Future Considerations

### V1 Enhancements
- **WebSocket Integration**: Real-time dashboard updates
- **Advanced Caching**: Multi-layer caching strategy (Redis + in-memory)
- **GraphQL API**: Efficient data fetching for complex queries

### V2 Enhancements
- **Microservices**: Split into independent services (if scale demands)
- **Event Sourcing**: Full event log for time-travel debugging
- **CQRS Read Models**: Dedicated read databases (e.g., Elasticsearch for search)

### Plugin Architecture
- **Extension Points**: Define plugin interfaces for custom integrations
- **Plugin Registry**: Centralized plugin discovery and loading
- **Sandboxing**: Isolate plugin execution for security

---

**Document Status**: APPROVED
**Next Steps**: Analyst validation, ADR creation, implementation planning
