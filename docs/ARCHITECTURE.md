# Holocene Architecture Documentation

## Overview

Holocene is a mission control dashboard for the 33GOD Agentic Development Pipeline, built with a clean, modular architecture following SOLID principles and domain-driven design patterns.

## Architecture Principles

### 1. **Layered Architecture**
- **Domain Layer**: Core business logic and entities
- **Service Layer**: Application-specific business rules
- **Repository Layer**: Data access abstraction
- **Presentation Layer**: React-based UI components

### 2. **Single Responsibility Principle (SRP)**
Each module has one reason to change:
- `BaseModel`: Entity lifecycle management
- `PortfolioService`: Portfolio-level aggregations
- `DecisionService`: Decision tracking and analysis
- `RepoRepository`: Repository data access

### 3. **Dependency Injection**
All dependencies managed through IoC container (`Container.ts`):
```typescript
container.registerSingleton('RepoRepository', RepoRepository);
container.registerSingleton('PortfolioService', () =>
  new PortfolioService(
    container.resolve('ProjectRepository'),
    container.resolve('RepoRepository')
  )
);
```

### 4. **Interface Segregation**
Clear contracts for extensibility:
- `IRepository<T>`: Generic data access
- `IService`: Service lifecycle management
- `IRepositoryWithPagination<T>`: Extended repository capabilities

## Project Structure

```
holocene/
├── src/
│   ├── domain/           # Domain models and business logic
│   │   ├── models/       # Entity classes
│   │   │   ├── BaseModel.ts
│   │   │   ├── Repo.ts
│   │   │   ├── Project.ts
│   │   │   ├── Employee.ts
│   │   │   ├── Task.ts
│   │   │   └── Decision.ts
│   │   ├── value-objects/
│   │   └── events/
│   │
│   ├── services/         # Application services
│   │   ├── portfolio/
│   │   │   └── PortfolioService.ts
│   │   ├── decision/
│   │   │   └── DecisionService.ts
│   │   ├── agent/
│   │   ├── project/
│   │   ├── task/
│   │   └── session/
│   │
│   ├── repositories/     # Data access layer
│   │   ├── postgres/
│   │   │   ├── BasePostgresRepository.ts
│   │   │   └── RepoRepository.ts
│   │   └── redis/
│   │
│   ├── interfaces/       # Contracts and abstractions
│   │   ├── IRepository.ts
│   │   └── IService.ts
│   │
│   ├── config/           # Configuration and DI
│   │   └── Container.ts
│   │
│   ├── web/              # Frontend application
│   │   ├── components/
│   │   │   ├── atoms/    # Basic UI elements
│   │   │   │   ├── Button.tsx
│   │   │   │   └── Card.tsx
│   │   │   ├── molecules/# Composite components
│   │   │   │   └── ProjectCard.tsx
│   │   │   ├── organisms/# Complex sections
│   │   │   └── templates/# Page layouts
│   │   ├── pages/
│   │   ├── hooks/
│   │   ├── context/
│   │   └── services/
│   │
│   └── utils/            # Shared utilities
│
├── tests/
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   └── e2e/              # End-to-end tests
│
├── docs/                 # Documentation
├── config/               # Configuration files
└── scripts/              # Build and utility scripts
```

## Domain Models

### BaseModel
Abstract base class providing common functionality:
- Unique ID generation
- Timestamp management (createdAt, updatedAt)
- Validation contract
- JSON serialization

### Core Entities

#### **Repo**
Represents a repository cloned locally by iMi.

**Key Properties:**
- `name`, `remote`, `localPath`, `defaultBranch`
- `leadArchitect`, `projectManager`, `qaLead`

**Relationships:**
- Belongs to many Projects
- Has many Decisions, Tasks, Sessions

#### **Project**
Created and managed by Flume.

**Key Properties:**
- `name`, `description`, `prdUrl`, `status`
- `projectDirector`, `engineeringDirector`, `qaDirector`

**Status States:**
- `PLANNING`, `ACTIVE`, `ON_HOLD`, `COMPLETED`, `ARCHIVED`

#### **Employee**
Yi Node - an anthropomorphized agent orchestrator.

**Key Properties:**
- `name`, `agentType`, `salary`, `personality`, `background`
- `domainsOfExperience`, `domainsOfExpertise`

**Agent Types:**
- `LETTA`, `AGNO`, `CLAUDE`, `CUSTOM`

**Salary Levels:**
- `JUNIOR`, `MID`, `SENIOR`, `PRINCIPAL`, `FELLOW`

**Capabilities:**
- Task assignment/completion
- Promotion system
- Experience/expertise tracking

#### **Task**
Work item created/managed by Flume.

**Key Properties:**
- `rawTask`, `title`, `description`, `requirements`
- `plan`, `acceptanceCriteria`, `idealCandidate`

**State Machine:**
```
OPEN → READY → IN_PROGRESS → DONE
                    ↓
                 CLOSED
```

#### **Decision**
Artifact created during a Session.

**Key Properties:**
- `title`, `context`, `decision`, `rationale`
- `impact`, `category`, `reversible`

**Impact Levels:**
- `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`

**Categories:**
- `ARCHITECTURAL`, `TECHNICAL`, `PROCESS`, `PRODUCT`, `OPERATIONAL`

## Service Layer

### PortfolioService
**Responsibility:** Portfolio-wide data aggregation and insights.

**Key Operations:**
- `getOverview()`: Top 3 moving projects, momentum deltas
- `getTopMovingProjects()`: Ranked by activity
- `getMomentumDeltas()`: Period-over-period comparison

### DecisionService
**Responsibility:** Decision lifecycle and impact analysis.

**Key Operations:**
- `createDecision()`: Record new decisions
- `getDecisionRadar()`: Ranked feed of impactful decisions
- `reverseDecision()`: Rollback reversible decisions
- `getAutonomyAlerts()`: Identify decisions needing human review

## Repository Pattern

### Generic Repository Interface
```typescript
interface IRepository<T> {
  findById(id: string): Promise<T | null>;
  findAll(criteria?: Record<string, unknown>): Promise<T[]>;
  findOne(criteria: Record<string, unknown>): Promise<T | null>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<boolean>;
  count(criteria?: Record<string, unknown>): Promise<number>;
  exists(id: string): Promise<boolean>;
}
```

### Pagination Support
```typescript
interface IRepositoryWithPagination<T> extends IRepository<T> {
  findWithPagination(
    criteria?: Record<string, unknown>,
    options?: PaginationOptions
  ): Promise<PaginatedResult<T>>;
}
```

## Frontend Architecture

### Atomic Design Pattern

#### **Atoms** (Basic Building Blocks)
- `Button`: Reusable button with variants and states
- `Card`: Container component with variants

#### **Molecules** (Simple Composites)
- `ProjectCard`: Project summary display

#### **Organisms** (Complex Sections)
- Dashboard widgets
- Navigation components

#### **Templates** (Page Layouts)
- Portfolio overview layout
- Project detail layout

### State Management
- **React Query**: Server state and caching
- **Zustand**: Client-side global state
- **Context API**: Theme and auth state

## Design Patterns Applied

### 1. **Repository Pattern**
Abstracts data access layer from business logic.

### 2. **Service Pattern**
Encapsulates business logic separate from domain entities.

### 3. **Dependency Injection**
Promotes loose coupling and testability.

### 4. **Factory Pattern** (BaseModel)
Standardized entity creation and validation.

### 5. **Strategy Pattern** (ServiceResult)
Unified error handling approach.

## Error Handling

### ServiceResult Pattern
```typescript
type ServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: Error; code?: string };
```

**Benefits:**
- Type-safe error handling
- Explicit error states
- Error codes for categorization

## Testing Strategy

### Unit Tests
- Domain model validation
- Service logic
- Repository implementations

### Integration Tests
- Service + Repository interactions
- API endpoints
- Database operations

### E2E Tests
- User workflows
- Dashboard interactions
- Decision tracking flows

## Technology Stack

### Backend
- **TypeScript**: Type safety
- **PostgreSQL**: Relational data
- **Redis**: Caching and sessions

### Frontend
- **React 18**: UI framework
- **Vite**: Build tool
- **TailwindCSS**: Styling
- **React Query**: Data fetching
- **Zustand**: State management

### Testing
- **Vitest**: Unit and integration tests
- **Happy DOM**: Test environment

## Best Practices

### 1. **Immutability**
Domain models use readonly properties where appropriate.

### 2. **Type Safety**
Strong typing throughout with TypeScript strict mode.

### 3. **Validation**
All entities validate on construction.

### 4. **Separation of Concerns**
Clear boundaries between layers.

### 5. **Testability**
Dependency injection enables easy mocking.

## Future Enhancements

### Phase 1 (MVP)
- [ ] Complete repository implementations
- [ ] PostgreSQL integration
- [ ] Redis caching layer
- [ ] Basic UI components

### Phase 2
- [ ] Agent Constellation visualization
- [ ] Plan vs. Commitment drift detection
- [ ] Briefing Mode (AM/PM summaries)

### Phase 3
- [ ] Natural language queries
- [ ] AI-generated decision rationale
- [ ] Multi-portfolio support

## Contributing

When adding new features:

1. **Domain First**: Start with domain models
2. **Test Coverage**: Write tests before implementation
3. **Single Responsibility**: One reason to change
4. **Interface Segregation**: Small, focused interfaces
5. **Dependency Injection**: Register in container

## Performance Considerations

### Database
- Use indexes on foreign keys
- Implement query result caching
- Paginate large result sets

### Frontend
- Code splitting by route
- Lazy loading for heavy components
- Memoization for expensive computations

### API
- Response compression
- ETags for caching
- Rate limiting

---

**Architecture Version:** 1.0.0
**Last Updated:** 2025-12-27
**Architect:** Implementation Specialist (High Council of Architects)
