# Architectural Patterns for Holocene

**Version**: 1.0.0
**Date**: 2025-12-27
**Purpose**: Document reusable architectural patterns and their application

---

## Table of Contents

1. [Repository Pattern](#1-repository-pattern)
2. [Use Case Pattern](#2-use-case-pattern)
3. [Event-Driven Architecture](#3-event-driven-architecture)
4. [CQRS (Command Query Responsibility Segregation)](#4-cqrs-command-query-responsibility-segregation)
5. [Factory Pattern](#5-factory-pattern)
6. [Strategy Pattern](#6-strategy-pattern)
7. [Adapter Pattern](#7-adapter-pattern)
8. [Dependency Injection](#8-dependency-injection)

---

## 1. Repository Pattern

### Purpose
Decouple domain logic from data access, allowing business logic to remain database-agnostic.

### When to Use
- Persisting domain entities (Portfolio, Decision, Agent, Task)
- Need to swap databases (Postgres → MongoDB, testing mocks)
- Multiple data sources (Postgres + Redis + API)

### Structure
```
Domain Layer: Defines interface
Infrastructure Layer: Implements interface
```

### Example
```typescript
// src/domain/repositories/IPortfolioRepository.ts
export interface IPortfolioRepository {
  findById(id: string): Promise<Portfolio | null>;
  findAll(filters?: PortfolioFilters): Promise<Portfolio[]>;
  save(portfolio: Portfolio): Promise<void>;
  delete(id: string): Promise<void>;
}

// src/infrastructure/database/postgres/PostgresPortfolioRepository.ts
export class PostgresPortfolioRepository implements IPortfolioRepository {
  constructor(private db: DrizzleDB) {}

  async findById(id: string): Promise<Portfolio | null> {
    const row = await this.db
      .select()
      .from(portfolioTable)
      .where(eq(portfolioTable.id, id))
      .limit(1);

    return row[0] ? PortfolioMapper.toDomain(row[0]) : null;
  }

  async save(portfolio: Portfolio): Promise<void> {
    const data = PortfolioMapper.toPersistence(portfolio);
    await this.db.insert(portfolioTable).values(data);
  }
}

// src/application/use-cases/portfolio/GetPortfolioOverview.ts
export class GetPortfolioOverview {
  constructor(private portfolioRepo: IPortfolioRepository) {}

  async execute(userId: string): Promise<PortfolioDTO> {
    const portfolios = await this.portfolioRepo.findAll({ userId });
    return PortfolioMapper.toDTO(portfolios);
  }
}
```

### Benefits
- **Testability**: Mock repository in tests
- **Database Independence**: Swap Postgres for MongoDB
- **Single Responsibility**: Repository handles only persistence

---

## 2. Use Case Pattern

### Purpose
Encapsulate single business operations, orchestrating domain entities and services.

### When to Use
- User-initiated actions (create decision, assign task)
- Background processes (generate brief, detect risks)
- Complex workflows with multiple steps

### Structure
```
Application Layer: Use case implementation
Domain Layer: Business entities and rules
Infrastructure Layer: External services (DB, APIs)
```

### Example
```typescript
// src/application/use-cases/decision/RankDecisions.ts
export class RankDecisions {
  constructor(
    private decisionRepo: IDecisionRepository,
    private rankingService: IRankingService
  ) {}

  async execute(filters: DecisionFilters): Promise<DecisionDTO[]> {
    // Step 1: Fetch decisions
    const decisions = await this.decisionRepo.findRecent(100);

    // Step 2: Calculate impact scores
    const scored = await this.rankingService.calculateScores(decisions);

    // Step 3: Sort by score
    const ranked = scored.sort((a, b) => b.score - a.score);

    // Step 4: Map to DTOs
    return ranked.map(DecisionMapper.toDTO);
  }
}
```

### Benefits
- **Clear Entry Points**: One use case per action
- **Testable Workflows**: Mock dependencies easily
- **Reusability**: Compose use cases

### Naming Convention
- **Commands**: `CreateDecision`, `AssignTask`, `GenerateBrief`
- **Queries**: `GetPortfolioOverview`, `ListAgents`, `SearchDecisions`

---

## 3. Event-Driven Architecture

### Purpose
Decouple modules via asynchronous events, enabling loose coupling and auditability.

### When to Use
- Cross-module communication (Briefing module needs decision data)
- External integrations (Bloodbank event stream)
- Audit trails (all decision changes logged)

### Structure
```
Domain Layer: Domain events, event bus interface
Infrastructure Layer: Event bus implementation (Bloodbank, in-memory)
Application Layer: Event handlers (subscribers)
```

### Example
```typescript
// src/domain/events/DecisionCreatedEvent.ts
export class DecisionCreatedEvent implements IDomainEvent {
  readonly eventId: string;
  readonly eventType = 'DecisionCreated';
  readonly occurredAt: Date;

  constructor(
    readonly aggregateId: string,
    readonly payload: { title: string; impact: number }
  ) {
    this.eventId = crypto.randomUUID();
    this.occurredAt = new Date();
  }
}

// src/domain/entities/decision/Decision.ts
export class Decision {
  create(data: DecisionData): Decision {
    const decision = new Decision(data);
    decision.emit(new DecisionCreatedEvent(decision.id, {
      title: decision.title,
      impact: decision.impact
    }));
    return decision;
  }
}

// src/infrastructure/events/BloodbankEventBus.ts
export class BloodbankEventBus implements IEventBus {
  async publish(event: IDomainEvent): Promise<void> {
    const bloodbankEvent = this.mapToBloodbank(event);
    await this.bloodbankClient.publishEvent(bloodbankEvent);
  }

  subscribe(eventType: string, handler: EventHandler): void {
    this.bloodbankClient.subscribeToEvents([eventType], async (event) => {
      const domainEvent = this.mapToDomain(event);
      await handler(domainEvent);
    });
  }
}

// src/application/event-handlers/DecisionCreatedHandler.ts
export class DecisionCreatedHandler {
  async handle(event: DecisionCreatedEvent): Promise<void> {
    // Regenerate briefing when decision created
    await briefingService.regenerateBrief(event.aggregateId);

    // Notify stakeholders
    await notificationService.notifyDecisionCreated(event);
  }
}
```

### Benefits
- **Loose Coupling**: Modules don't know about each other
- **Auditability**: Full event log for debugging
- **Scalability**: Async processing, horizontal scaling

---

## 4. CQRS (Command Query Responsibility Segregation)

### Purpose
Separate read and write operations, optimizing each independently.

### When to Use
- Read-heavy operations (portfolio overview, decision rankings)
- Complex read models (agent constellation graph)
- Need for different data stores (write to Postgres, read from Redis)

### Structure
```
Commands: Write operations (Create, Update, Delete)
Queries: Read operations (Get, List, Search)
```

### Example
```typescript
// COMMAND SIDE (Write)
// src/application/commands/CreateDecisionCommand.ts
export class CreateDecisionCommand {
  constructor(
    private decisionRepo: IDecisionRepository,
    private eventBus: IEventBus
  ) {}

  async execute(data: DecisionDTO): Promise<void> {
    const decision = Decision.create(data);
    await this.decisionRepo.save(decision);
    await this.eventBus.publish(new DecisionCreatedEvent(decision.id));
  }
}

// QUERY SIDE (Read)
// src/application/queries/GetDecisionHistoryQuery.ts
export class GetDecisionHistoryQuery {
  constructor(private decisionRepo: IDecisionRepository) {}

  async execute(filters: DecisionFilters): Promise<DecisionDTO[]> {
    const decisions = await this.decisionRepo.findAll(filters);
    return decisions.map(DecisionMapper.toDTO);
  }
}
```

### Benefits
- **Performance**: Optimize reads separately from writes
- **Scalability**: Read replicas, caching
- **Clarity**: Clear separation of intent

---

## 5. Factory Pattern

### Purpose
Encapsulate complex object creation, ensuring validation and consistency.

### When to Use
- Creating domain entities with complex validation
- Mapping DTOs to domain entities
- Creating entities from events

### Example
```typescript
// src/domain/entities/agent/AgentFactory.ts
export class AgentFactory {
  static create(data: CreateAgentDTO): Agent {
    // Validation
    if (!data.name || data.name.length < 3) {
      throw new ValidationException('Agent name must be at least 3 characters');
    }

    if (!data.agentType || !VALID_AGENT_TYPES.includes(data.agentType)) {
      throw new ValidationException(`Invalid agent type: ${data.agentType}`);
    }

    // Construction
    return new Agent({
      id: crypto.randomUUID(),
      name: data.name,
      agentType: data.agentType,
      salary: data.salary ?? SalaryLevel.JUNIOR,
      personality: data.personality ?? {},
      createdAt: new Date()
    });
  }

  static fromEvent(event: AgentSpawnedEvent): Agent {
    return new Agent({
      id: event.aggregateId,
      name: event.payload.name,
      agentType: event.payload.agentType,
      // ...
    });
  }
}
```

### Benefits
- **Consistency**: All entities created via factory
- **Validation**: Centralized validation logic
- **Encapsulation**: Hide construction complexity

---

## 6. Strategy Pattern

### Purpose
Define interchangeable algorithms, allowing runtime selection.

### When to Use
- Multiple algorithms for same operation (risk scoring, briefing templates)
- Need to switch algorithms dynamically
- Avoid large if/else chains

### Example
```typescript
// src/domain/services/IRiskScoringStrategy.ts
export interface IRiskScoringStrategy {
  calculate(context: RiskContext): number;
}

// src/application/services/WeightedRiskScoring.ts
export class WeightedRiskScoring implements IRiskScoringStrategy {
  calculate(context: RiskContext): number {
    return (
      context.blockerCount * 10 +
      context.driftPercent * 5 +
      context.autonomyLevel * 3
    );
  }
}

// src/application/services/BayesianRiskScoring.ts
export class BayesianRiskScoring implements IRiskScoringStrategy {
  calculate(context: RiskContext): number {
    // Bayesian probability calculation
    return this.bayesianCalculation(context);
  }
}

// src/application/use-cases/risk/DetectRisks.ts
export class DetectRisks {
  constructor(private scoringStrategy: IRiskScoringStrategy) {}

  async execute(scope: RiskScope): Promise<Risk[]> {
    const risks = await this.gatherRisks(scope);
    return risks.map(risk => ({
      ...risk,
      score: this.scoringStrategy.calculate(risk.context)
    }));
  }
}

// Usage: Switch strategies at runtime
const riskDetection = new DetectRisks(new WeightedRiskScoring());
// Later: Switch to Bayesian
riskDetection = new DetectRisks(new BayesianRiskScoring());
```

### Benefits
- **Flexibility**: Swap algorithms without changing client code
- **Testability**: Test each strategy independently
- **Extensibility**: Add new strategies easily

---

## 7. Adapter Pattern

### Purpose
Integrate external systems with incompatible interfaces.

### When to Use
- Integrating with Bloodbank, Flume, iMi, GitHub APIs
- Need to isolate external dependencies
- Want to swap implementations (e.g., test vs. production)

### Example
```typescript
// src/domain/events/IEventBus.ts (Domain interface)
export interface IEventBus {
  publish(event: IDomainEvent): Promise<void>;
  subscribe(eventType: string, handler: EventHandler): void;
}

// src/infrastructure/events/BloodbankAdapter.ts
export class BloodbankAdapter implements IEventBus {
  constructor(private bloodbankClient: BloodbankClient) {}

  async publish(event: IDomainEvent): Promise<void> {
    // Adapt domain event to Bloodbank format
    const bloodbankEvent = {
      id: event.eventId,
      type: event.eventType,
      timestamp: event.occurredAt.toISOString(),
      payload: event.payload
    };

    await this.bloodbankClient.publishEvent(bloodbankEvent);
  }

  subscribe(eventType: string, handler: EventHandler): void {
    this.bloodbankClient.subscribeToEvents([eventType], async (bloodbankEvent) => {
      // Adapt Bloodbank event to domain event
      const domainEvent = this.mapToDomain(bloodbankEvent);
      await handler(domainEvent);
    });
  }
}

// src/infrastructure/events/InMemoryEventBus.ts (Test adapter)
export class InMemoryEventBus implements IEventBus {
  private handlers = new Map<string, EventHandler[]>();

  async publish(event: IDomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventType) ?? [];
    await Promise.all(handlers.map(h => h(event)));
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const handlers = this.handlers.get(eventType) ?? [];
    this.handlers.set(eventType, [...handlers, handler]);
  }
}
```

### Benefits
- **Isolation**: Domain doesn't know about Bloodbank
- **Testability**: Use in-memory adapter in tests
- **Flexibility**: Swap adapters easily

---

## 8. Dependency Injection

### Purpose
Invert control, allowing dependencies to be provided externally rather than created internally.

### When to Use
- All application and infrastructure layer classes
- Testing (inject mocks)
- Configuration (inject prod vs. test implementations)

### Example
```typescript
// src/application/use-cases/portfolio/GetPortfolioOverview.ts
export class GetPortfolioOverview {
  // Dependencies injected via constructor
  constructor(
    private portfolioRepo: IPortfolioRepository,
    private projectRepo: IProjectRepository,
    private momentumService: IMomentumService
  ) {}

  async execute(userId: string): Promise<PortfolioDTO> {
    const portfolios = await this.portfolioRepo.findAll({ userId });
    const projects = await this.projectRepo.findByPortfolios(portfolios);
    const momentum = await this.momentumService.calculate(projects);

    return { portfolios, momentum };
  }
}

// src/infrastructure/di/container.ts (Dependency Injection Container)
export class DIContainer {
  private static instance: DIContainer;
  private services = new Map<string, any>();

  static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
    }
    return DIContainer.instance;
  }

  register<T>(key: string, factory: () => T): void {
    this.services.set(key, factory);
  }

  resolve<T>(key: string): T {
    const factory = this.services.get(key);
    if (!factory) {
      throw new Error(`Service not registered: ${key}`);
    }
    return factory();
  }
}

// src/main.ts (Application bootstrap)
const container = DIContainer.getInstance();

// Register infrastructure implementations
container.register('IPortfolioRepository', () => new PostgresPortfolioRepository(db));
container.register('IProjectRepository', () => new PostgresProjectRepository(db));
container.register('IMomentumService', () => new MomentumService());

// Register use cases
container.register('GetPortfolioOverview', () => new GetPortfolioOverview(
  container.resolve('IPortfolioRepository'),
  container.resolve('IProjectRepository'),
  container.resolve('IMomentumService')
));

// Usage
const getPortfolioOverview = container.resolve<GetPortfolioOverview>('GetPortfolioOverview');
const portfolio = await getPortfolioOverview.execute(userId);
```

### Benefits
- **Testability**: Inject mocks in tests
- **Flexibility**: Swap implementations easily
- **Decoupling**: Classes don't create their dependencies

---

## Pattern Selection Guide

| Scenario | Recommended Pattern |
|----------|---------------------|
| Persisting entities | Repository Pattern |
| User-initiated action | Use Case Pattern |
| Cross-module communication | Event-Driven Architecture |
| Read-heavy operations | CQRS |
| Complex object creation | Factory Pattern |
| Interchangeable algorithms | Strategy Pattern |
| External system integration | Adapter Pattern |
| Dependency management | Dependency Injection |

---

## Anti-Patterns to Avoid

### 1. God Classes
- **Problem**: Single class with too many responsibilities
- **Solution**: Apply SRP, split into smaller classes

### 2. Anemic Domain Model
- **Problem**: Entities with only getters/setters, no behavior
- **Solution**: Move business logic into domain entities

### 3. Leaky Abstractions
- **Problem**: Implementation details leak through interfaces
- **Solution**: Define interfaces based on client needs, not implementation

### 4. Circular Dependencies
- **Problem**: Module A depends on B, B depends on A
- **Solution**: Use events, dependency inversion

---

**Next Steps**: Review patterns with analyst, apply to implementation
