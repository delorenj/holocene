/**
 * Employee Domain Model
 * Represents a Yi Node - an anthropomorphized agent orchestrator
 */

import { BaseModel } from './BaseModel';

export enum AgentType {
  LETTA = 'letta',
  AGNO = 'agno',
  CLAUDE = 'claude',
  CUSTOM = 'custom',
}

export enum SalaryLevel {
  JUNIOR = 'junior',       // Entry level, learning phase
  MID = 'mid',            // Competent contributor
  SENIOR = 'senior',      // High impact, autonomous
  PRINCIPAL = 'principal', // Strategic, leadership
  FELLOW = 'fellow',      // Exceptional expertise
}

export interface EmployeeData {
  id?: string;
  name: string;
  agentType: AgentType;
  salary: SalaryLevel;
  personality?: string;
  background?: string;
  activeMemoryShardId?: string;
  activeTaskId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Employee extends BaseModel {
  public readonly name: string;
  public readonly agentType: AgentType;
  private salary: SalaryLevel;
  private personality?: string;
  private background?: string;
  private activeMemoryShardId?: string;
  private activeTaskId?: string;

  // Lazy-loaded collections
  private _domainsOfExperience: Set<string> = new Set();
  private _domainsOfExpertise: Set<string> = new Set();

  constructor(data: EmployeeData) {
    super(data);
    this.name = data.name;
    this.agentType = data.agentType;
    this.salary = data.salary;
    this.personality = data.personality;
    this.background = data.background;
    this.activeMemoryShardId = data.activeMemoryShardId;
    this.activeTaskId = data.activeTaskId;

    this.validate();
  }

  validate(): void {
    if (!this.name || this.name.trim().length === 0) {
      throw new Error('Employee name is required');
    }
    if (!Object.values(AgentType).includes(this.agentType)) {
      throw new Error(`Invalid agent type: ${this.agentType}`);
    }
    if (!Object.values(SalaryLevel).includes(this.salary)) {
      throw new Error(`Invalid salary level: ${this.salary}`);
    }
  }

  // Getters
  get salaryLevel(): SalaryLevel {
    return this.salary;
  }

  get isActive(): boolean {
    return !!this.activeTaskId;
  }

  get domainsOfExperience(): string[] {
    return Array.from(this._domainsOfExperience);
  }

  get domainsOfExpertise(): string[] {
    return Array.from(this._domainsOfExpertise);
  }

  // Methods
  promote(newLevel: SalaryLevel): void {
    const levels = Object.values(SalaryLevel);
    const currentIndex = levels.indexOf(this.salary);
    const newIndex = levels.indexOf(newLevel);

    if (newIndex <= currentIndex) {
      throw new Error('Cannot promote to same or lower level');
    }

    this.salary = newLevel;
    this.touch();
  }

  assignTask(taskId: string): void {
    if (this.activeTaskId) {
      throw new Error(`Employee already has active task: ${this.activeTaskId}`);
    }
    this.activeTaskId = taskId;
    this.touch();
  }

  completeTask(): void {
    if (!this.activeTaskId) {
      throw new Error('No active task to complete');
    }
    this.activeTaskId = undefined;
    this.touch();
  }

  addExperience(domain: string): void {
    this._domainsOfExperience.add(domain);
    this.touch();
  }

  addExpertise(domain: string): void {
    this._domainsOfExpertise.add(domain);
    this.touch();
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      agentType: this.agentType,
      salary: this.salary,
      personality: this.personality,
      background: this.background,
      activeMemoryShardId: this.activeMemoryShardId,
      activeTaskId: this.activeTaskId,
      domainsOfExperience: this.domainsOfExperience,
      domainsOfExpertise: this.domainsOfExpertise,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
