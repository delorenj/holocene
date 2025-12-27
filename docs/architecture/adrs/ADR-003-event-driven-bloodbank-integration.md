# ADR-003: Event-Driven Bloodbank Integration

**Status**: ACCEPTED
**Date**: 2025-12-27
**Deciders**: System Architect (High Council of Architects)
**Context**: Integration strategy with 33GOD pipeline components

---

## Context and Problem Statement

Holocene needs to ingest data from multiple 33GOD pipeline services (Flume, iMi, Yi, Jelmore) to provide real-time visibility into portfolio health, agent activity, and decision-making. The integration must:
- Handle high event throughput (100s of events per minute)
- Support real-time updates to the dashboard
- Maintain loose coupling with external systems
- Be resilient to service outages
- Provide audit trails for debugging

**Problem**: How should Holocene integrate with external 33GOD services?

---

## Decision Drivers

1. **Real-Time Updates** (HIGH): Dashboard must reflect changes within seconds
2. **Loose Coupling** (CRITICAL): Holocene should not break when external services change
3. **Auditability** (HIGH): Full event history for debugging and analysis
4. **Resilience** (MEDIUM): Graceful degradation when services unavailable
5. **Simplicity** (MEDIUM): Avoid complex integration logic

---

## Considered Options

### Option 1: **Event-Driven Architecture (Bloodbank)**
- **Description**: Subscribe to Bloodbank event streams via n8n webhooks
- **Pattern**: Pub/Sub with topic-based subscriptions
- **Events**:
  - `flume.task.created`, `flume.task.completed`
  - `yi.decision.made`, `yi.agent.spawned`
  - `jelmore.session.started`, `jelmore.session.ended`
  - `imi.checkpoint.created`, `imi.worktree.assigned`
- **Pros**:
  - **Loose Coupling**: Holocene doesn't call external APIs directly
  - **Real-Time**: Events pushed as they occur
  - **Audit Trail**: Full event log in Bloodbank
  - **Resilience**: Event replay on reconnection
  - **Scalability**: Pub/Sub scales horizontally
- **Cons**:
  - **Complexity**: Event handling logic required
  - **Eventual Consistency**: Slight delay in updates
  - **Bloodbank Dependency**: Single point of failure (mitigated by event replay)

### Option 2: **Polling External APIs**
- **Description**: Periodically query Flume, iMi, Yi, Jelmore APIs
- **Interval**: Every 30 seconds
- **Pros**:
  - **Simple**: Straightforward HTTP requests
  - **No External Dependency**: Direct API calls
- **Cons**:
  - **Latency**: 30s delay for updates
  - **Load**: Constant polling adds server load
  - **Tight Coupling**: API changes break Holocene
  - **No Audit Trail**: Can't replay historical events

### Option 3: **Hybrid Approach**
- **Description**: Events for real-time updates, APIs for initial load
- **Example**: Subscribe to events, but query APIs on dashboard load
- **Pros**:
  - **Best of Both**: Real-time + full data access
  - **Resilience**: Fallback to APIs if events fail
- **Cons**:
  - **Complexity**: Two integration paths to maintain
  - **Consistency Issues**: Events and APIs may diverge

---

## Decision Outcome

**Chosen Option**: **Event-Driven Architecture (Bloodbank)** with API fallback for initial load.

### Rationale
1. **Aligns with 33GOD Architecture**: Bloodbank is the central nervous system
2. **Real-Time**: Events pushed within milliseconds (critical for live dashboard)
3. **Loose Coupling**: Holocene doesn't need to know internal APIs
4. **Audit Trail**: Full event history for debugging, postmortems
5. **Scalability**: Pub/Sub scales better than polling

### Event Flow

```
┌─────────────┐
│   Flume     │──┐
│   (Tasks)   │  │
└─────────────┘  │
                 │  Publish Events
┌─────────────┐  │  (n8n Webhooks)
│     iMi     │──┤
│   (Repos)   │  │
└─────────────┘  │
                 ↓
┌─────────────┐  │
│ Yi Nodes    │──┤  ┌───────────────┐
│  (Agents)   │  ├─→│  Bloodbank    │
└─────────────┘  │  │ (Event Stream)│
                 │  └───────┬───────┘
┌─────────────┐  │          │
│  Jelmore    │──┘          │ Subscribe
│ (Sessions)  │             │ (WebHooks)
└─────────────┘             ↓
                    ┌───────────────┐
                    │   Holocene    │
                    │  (Dashboard)  │
                    └───────────────┘
```

### Event Schema
```typescript
interface BloodbankEvent {
  id: string;              // Unique event ID
  type: string;            // Event type (e.g., 'flume.task.created')
  timestamp: Date;         // ISO 8601 timestamp
  source: string;          // Service that emitted (e.g., 'flume')
  aggregateId: string;     // Entity ID (e.g., task ID)
  payload: Record<string, unknown>;  // Event-specific data
  metadata: {
    correlationId?: string;  // For tracing workflows
    causationId?: string;    // Event that caused this event
  };
}
```

---

## Implementation Details

### Event Subscriptions
```typescript
// Subscribe to task lifecycle events
eventBus.subscribe('flume.task.created', async (event) => {
  const task = TaskFactory.fromEvent(event);
  await taskRepository.save(task);
  await notificationService.notifyDashboard('task-created', task.id);
});

eventBus.subscribe('flume.task.completed', async (event) => {
  await taskRepository.updateStatus(event.aggregateId, TaskStatus.DONE);
  await briefingService.regenerateBrief(event.aggregateId);
});

// Subscribe to decision events
eventBus.subscribe('yi.decision.made', async (event) => {
  const decision = DecisionFactory.fromEvent(event);
  await decisionRepository.save(decision);
  await riskDetectionService.analyzeDecisionImpact(decision);
});

// Subscribe to session events
eventBus.subscribe('jelmore.session.started', async (event) => {
  await sessionRepository.createSession(event.payload);
});
```

### Error Handling
- **Retry Logic**: Exponential backoff (1s, 2s, 4s, 8s)
- **Dead Letter Queue**: Failed events logged for manual review
- **Circuit Breaker**: Pause subscriptions if error rate > 50%

### Event Replay
- **Use Case**: Recover from downtime, rebuild state
- **Mechanism**: Query Bloodbank API for historical events
- **Filter**: By timestamp range, event type, aggregate ID

---

## Consequences

### Positive
- **Real-Time**: Dashboard updates within 1 second of events
- **Decoupling**: Holocene doesn't know about external APIs
- **Audit Trail**: Full event log for debugging
- **Resilience**: Event replay on reconnection
- **Consistency**: Single source of truth (Bloodbank)

### Negative
- **Eventual Consistency**: Slight delay vs. synchronous APIs
- **Event Handling Complexity**: Need to handle duplicates, ordering
- **Bloodbank Dependency**: If Bloodbank down, no updates (mitigated by local cache)

### Mitigation Strategies
- **Local Cache (Redis)**: Store recent events locally (1-hour TTL)
- **API Fallback**: Query APIs on initial dashboard load
- **Idempotency**: Handle duplicate events gracefully (dedupe by event ID)
- **Event Ordering**: Use timestamps + sequence numbers

---

## Event Types to Subscribe

### Flume (Task Management)
- `flume.task.created`
- `flume.task.updated`
- `flume.task.completed`
- `flume.task.accepted`
- `flume.project.created`

### Yi Nodes (Agent Orchestration)
- `yi.decision.made`
- `yi.agent.spawned`
- `yi.agent.terminated`
- `yi.standup.submitted`

### Jelmore (Agentic Sessions)
- `jelmore.session.started`
- `jelmore.session.ended`
- `jelmore.session.joined`

### iMi (Repository Management)
- `imi.checkpoint.created`
- `imi.worktree.assigned`
- `imi.commit.pushed`

---

## Performance Targets

| Metric | Target | Mitigation |
|--------|--------|-----------|
| Event latency | < 1s | WebSocket for real-time push |
| Processing time | < 100ms per event | Async handlers, batch writes |
| Throughput | 1000 events/min | Horizontal scaling (future) |
| Replay speed | 10K events/min | Bulk insert, indexing |

---

## Validation Criteria

- [ ] Events received within 1 second of emission
- [ ] Dashboard updates in real-time (WebSocket push)
- [ ] Event replay rebuilds state accurately
- [ ] Error handling prevents data loss
- [ ] Duplicate events handled gracefully

---

## References

- [Event-Driven Architecture (Martin Fowler)](https://martinfowler.com/articles/201701-event-driven.html)
- [Bloodbank n8n Integration Guide](https://bloodbank.33god.dev/integration)
- [Domain Events Pattern](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation)

---

## Related Decisions

- **ADR-004**: WebSocket for Real-Time Dashboard Updates
- **ADR-005**: Redis for Event Caching
