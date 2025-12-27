/**
 * Test Data Fixtures
 * Reusable test data builders and factories
 */

export class TestDataBuilder {
  static createProject(overrides = {}) {
    return {
      id: 'proj-123',
      name: 'Test Project',
      roadmap: {},
      mvpac: [],
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  static createRepo(overrides = {}) {
    return {
      id: 'repo-456',
      name: 'test-repo',
      url: 'https://github.com/test/repo',
      projectId: 'proj-123',
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  static createEmployee(overrides = {}) {
    return {
      id: 'emp-789',
      name: 'Test Agent',
      agentType: 'Claude',
      salary: 100000,
      personality: 'Analytical',
      background: 'Software Engineering',
      activeMemoryShard: 'shard-001',
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  static createTask(overrides = {}) {
    return {
      id: 'task-101',
      rawTask: '# Implement feature X',
      title: 'Implement feature X',
      description: 'Add new feature to system',
      requirements: ['Req 1', 'Req 2'],
      state: 'open',
      lifecycle: 'standard',
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  static createSession(overrides = {}) {
    return {
      id: 'session-202',
      employeeId: 'emp-789',
      taskId: 'task-101',
      startedAt: new Date('2025-01-01T10:00:00Z'),
      endedAt: null,
      ...overrides,
    };
  }

  static createDecision(overrides = {}) {
    return {
      id: 'decision-303',
      sessionId: 'session-202',
      description: 'Chose architecture pattern X',
      rationale: 'Better scalability',
      impact: 'high',
      autonomyLevel: 'moderate',
      createdAt: new Date('2025-01-01T11:00:00Z'),
      ...overrides,
    };
  }

  static createCheckpoint(overrides = {}) {
    return {
      id: 'checkpoint-404',
      sessionId: 'session-202',
      commitSha: 'abc123def456',
      serializedState: {},
      createdAt: new Date('2025-01-01T12:00:00Z'),
      ...overrides,
    };
  }
}

export const mockDatabase = {
  projects: new Map(),
  repos: new Map(),
  employees: new Map(),
  tasks: new Map(),
  sessions: new Map(),
  decisions: new Map(),

  reset() {
    this.projects.clear();
    this.repos.clear();
    this.employees.clear();
    this.tasks.clear();
    this.sessions.clear();
    this.decisions.clear();
  },
};
