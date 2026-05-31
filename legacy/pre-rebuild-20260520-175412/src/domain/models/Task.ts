/**
 * Task Domain Model
 * Represents a work item created/managed by Flume
 */

import { BaseModel } from './BaseModel';

export enum TaskState {
  OPEN = 'open',
  READY = 'ready',
  IN_PROGRESS = 'in_progress',
  DONE = 'done',
  CLOSED = 'closed',
}

export interface TaskData {
  id?: string;
  rawTask: string;
  title?: string;
  description?: string;
  requirements?: string[];
  plan?: string;
  acceptanceCriteria?: string[];
  state: TaskState;
  idealCandidate?: string;
  assigneeId?: string;
  activeEmployeeId?: string;
  parentTaskId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Task extends BaseModel {
  public readonly rawTask: string;
  private title?: string;
  private description?: string;
  private requirements: string[];
  private plan?: string;
  private acceptanceCriteria: string[];
  private state: TaskState;
  private idealCandidate?: string;
  private assigneeId?: string;
  private activeEmployeeId?: string;
  private parentTaskId?: string;

  constructor(data: TaskData) {
    super(data);
    this.rawTask = data.rawTask;
    this.title = data.title;
    this.description = data.description;
    this.requirements = data.requirements || [];
    this.plan = data.plan;
    this.acceptanceCriteria = data.acceptanceCriteria || [];
    this.state = data.state;
    this.idealCandidate = data.idealCandidate;
    this.assigneeId = data.assigneeId;
    this.activeEmployeeId = data.activeEmployeeId;
    this.parentTaskId = data.parentTaskId;

    this.validate();
  }

  validate(): void {
    if (!this.rawTask || this.rawTask.trim().length === 0) {
      throw new Error('Raw task is required');
    }
    if (!Object.values(TaskState).includes(this.state)) {
      throw new Error(`Invalid task state: ${this.state}`);
    }
  }

  // Getters
  get currentState(): TaskState {
    return this.state;
  }

  get isReady(): boolean {
    return this.state === TaskState.READY;
  }

  get isComplete(): boolean {
    return this.state === TaskState.DONE || this.state === TaskState.CLOSED;
  }

  get canBeAccepted(): boolean {
    return this.state === TaskState.READY && !this.assigneeId;
  }

  // State transitions
  markReady(): void {
    if (this.state !== TaskState.OPEN) {
      throw new Error('Only open tasks can be marked ready');
    }
    if (!this.title || !this.description || this.requirements.length === 0) {
      throw new Error('Task must have title, description, and requirements before being marked ready');
    }
    this.state = TaskState.READY;
    this.touch();
  }

  accept(employeeId: string): void {
    if (!this.canBeAccepted) {
      throw new Error('Task cannot be accepted in current state');
    }
    this.activeEmployeeId = employeeId;
    this.state = TaskState.IN_PROGRESS;
    this.touch();
  }

  markDone(): void {
    if (this.state !== TaskState.IN_PROGRESS) {
      throw new Error('Only in-progress tasks can be marked done');
    }
    this.state = TaskState.DONE;
    this.activeEmployeeId = undefined;
    this.touch();
  }

  close(): void {
    if (this.state === TaskState.CLOSED) {
      throw new Error('Task is already closed');
    }
    this.state = TaskState.CLOSED;
    this.activeEmployeeId = undefined;
    this.touch();
  }

  // Setters
  setTitle(title: string): void {
    if (!title || title.trim().length === 0) {
      throw new Error('Title cannot be empty');
    }
    this.title = title;
    this.touch();
  }

  setDescription(description: string): void {
    if (!description || description.trim().length === 0) {
      throw new Error('Description cannot be empty');
    }
    this.description = description;
    this.touch();
  }

  setRequirements(requirements: string[]): void {
    if (!requirements || requirements.length === 0) {
      throw new Error('Requirements cannot be empty');
    }
    this.requirements = requirements;
    this.touch();
  }

  setPlan(plan: string): void {
    this.plan = plan;
    this.touch();
  }

  setAcceptanceCriteria(criteria: string[]): void {
    this.acceptanceCriteria = criteria;
    this.touch();
  }

  setIdealCandidate(candidate: string): void {
    this.idealCandidate = candidate;
    this.touch();
  }

  assignTo(employeeId: string): void {
    this.assigneeId = employeeId;
    this.touch();
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      rawTask: this.rawTask,
      title: this.title,
      description: this.description,
      requirements: this.requirements,
      plan: this.plan,
      acceptanceCriteria: this.acceptanceCriteria,
      state: this.state,
      idealCandidate: this.idealCandidate,
      assigneeId: this.assigneeId,
      activeEmployeeId: this.activeEmployeeId,
      parentTaskId: this.parentTaskId,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
