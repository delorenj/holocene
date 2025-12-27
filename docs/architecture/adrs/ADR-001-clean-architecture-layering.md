# ADR-001: Clean Architecture Layering

**Status**: ACCEPTED
**Date**: 2025-12-27
**Deciders**: System Architect (High Council of Architects)
**Context**: Architecture design for Holocene dashboard

---

## Context and Problem Statement

Holocene is a mission control dashboard for the 33GOD Agentic Development Pipeline, requiring high maintainability, testability, and scalability. The architecture must support rapid iteration while maintaining code quality and allowing for future enhancements.

**Key Requirements:**
- High modularity with small, focused components
- Single Responsibility Principle (SRP) adherence
- Layered abstraction for clear separation of concerns
- Testability (80%+ code coverage target)
- Framework-agnostic business logic

**Problem**: What architectural style should we adopt to meet these requirements?

---

## Decision Drivers

1. **Maintainability** (CRITICAL): Code must be easy to understand, modify, and extend
2. **Testability** (HIGH): Business logic must be testable in isolation
3. **Scalability** (MEDIUM): Architecture should support growth from 10 to 100 projects
4. **Developer Experience** (HIGH): Clear structure, predictable patterns
5. **Performance** (MEDIUM): Sub-second response times for critical operations

---

## Considered Options

### Option 1: **Clean Architecture (Layered)**
- **Description**: Adopt Uncle Bob's Clean Architecture with strict dependency rules
- **Layers**: Presentation → Application → Domain ← Infrastructure
- **Dependencies**: Always point inward (toward domain)
- **Pros**:
  - Business logic completely isolated from frameworks
  - Highly testable (pure domain entities)
  - Clear separation of concerns
  - Framework-agnostic domain layer
  - Enforces dependency inversion
- **Cons**:
  - Steeper learning curve for new developers
  - More boilerplate (interfaces, DTOs)
  - Potential over-engineering for simple features

### Option 2: **Feature-Based Modules**
- **Description**: Group code by features (e.g., `/features/portfolio`, `/features/decision`)
- **Structure**: Each feature contains UI, logic, and data access
- **Pros**:
  - Easy to locate feature-specific code
  - Lower coupling between features
  - Simpler mental model
- **Cons**:
  - Cross-feature dependencies become messy
  - Harder to enforce layering
  - Business logic mixed with UI concerns
  - Difficult to test in isolation

### Option 3: **MVC (Model-View-Controller)**
- **Description**: Traditional MVC pattern with React as View
- **Structure**: Models (data), Views (React), Controllers (API handlers)
- **Pros**:
  - Well-known pattern
  - Simple for small applications
- **Cons**:
  - Business logic often leaks into controllers
  - Poor testability (tight coupling)
  - Doesn't scale well with complexity
  - Framework-dependent

---

## Decision Outcome

**Chosen Option**: **Clean Architecture (Layered)** with strict dependency rules.

### Rationale
1. **Aligns with North Star**: "High modularity, SRP, layered abstraction"
2. **Testability**: 100% domain coverage achievable (pure functions)
3. **Maintainability**: Clear boundaries reduce cognitive load
4. **Future-Proof**: Easy to swap frameworks (React → Vue, Postgres → MongoDB)
5. **Enforces Best Practices**: Dependency inversion, interface segregation

### Architecture Layers

```
┌─────────────────────────────────────┐
│     PRESENTATION (UI Components)    │  ← React, Zustand, Tailwind
├─────────────────────────────────────┤
│     APPLICATION (Use Cases)         │  ← Business workflows, orchestration
├─────────────────────────────────────┤
│     DOMAIN (Business Logic)         │  ← Pure TypeScript, framework-agnostic
├─────────────────────────────────────┤
│     INFRASTRUCTURE (Adapters)       │  ← Postgres, Redis, APIs
└─────────────────────────────────────┘
```

### Dependency Rules
1. **Presentation** depends on **Application** interfaces only
2. **Application** depends on **Domain** entities and **Infrastructure** interfaces
3. **Domain** has NO external dependencies (pure TypeScript)
4. **Infrastructure** implements **Domain** and **Application** interfaces

---

## Consequences

### Positive
- **High Testability**: Domain entities tested without databases or frameworks
- **Framework Independence**: Can replace React with minimal refactoring
- **Clear Responsibilities**: Each layer has a single, well-defined purpose
- **Scalability**: Modules can be extracted into microservices if needed
- **Onboarding**: New developers understand structure quickly

### Negative
- **Initial Complexity**: More files and interfaces than flat structure
- **Boilerplate**: DTOs, mappers, and interfaces add code volume
- **Over-Engineering Risk**: Simple features may feel unnecessarily complex

### Mitigation Strategies
- **Documentation**: Comprehensive architecture docs (this ADR)
- **Code Generators**: Scripts to scaffold layers for new features
- **Linting Rules**: ESLint to enforce layer dependencies
- **Developer Training**: Onboarding guides and examples

---

## Implementation Plan

1. **Directory Structure**: Define folder hierarchy reflecting layers
2. **Dependency Enforcement**: Configure ESLint `no-restricted-imports`
3. **Interface Contracts**: Define repository and service interfaces
4. **Domain Modeling**: Create entities and value objects (pure TypeScript)
5. **Infrastructure Adapters**: Implement Postgres/Redis repositories
6. **Application Use Cases**: Build orchestration logic
7. **Presentation Components**: React UI consuming use cases

---

## Validation Criteria

- [ ] All domain entities have zero framework dependencies
- [ ] Business logic testable without databases
- [ ] Presentation layer only imports from Application layer
- [ ] ESLint enforces layer boundaries
- [ ] 80%+ code coverage achieved

---

## References

- [The Clean Architecture (Uncle Bob)](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)
- [Domain-Driven Design (Eric Evans)](https://domainlanguage.com/ddd/)
- [Hexagonal Architecture (Alistair Cockburn)](https://alistair.cockburn.us/hexagonal-architecture/)

---

## Related Decisions

- **ADR-002**: Repository Pattern for Data Access
- **ADR-003**: Use Case Pattern for Business Workflows
- **ADR-004**: Event-Driven Architecture for Cross-Module Communication
