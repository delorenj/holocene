/**
 * Project Domain Model
 * Created and managed by Flume
 */

import { BaseModel } from './BaseModel';

export interface ProjectData {
  id?: string;
  name: string;
  description?: string;
  prdUrl?: string;
  projectDirectorId?: string;
  engineeringDirectorId?: string;
  qaDirectorId?: string;
  status: ProjectStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

export enum ProjectStatus {
  PLANNING = 'planning',
  ACTIVE = 'active',
  ON_HOLD = 'on_hold',
  COMPLETED = 'completed',
  ARCHIVED = 'archived',
}

export class Project extends BaseModel {
  public readonly name: string;
  private description?: string;
  private prdUrl?: string;
  private projectDirectorId?: string;
  private engineeringDirectorId?: string;
  private qaDirectorId?: string;
  private status: ProjectStatus;

  // Lazy-loaded relationships
  private _repoIds: Set<string> = new Set();

  constructor(data: ProjectData) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.prdUrl = data.prdUrl;
    this.projectDirectorId = data.projectDirectorId;
    this.engineeringDirectorId = data.engineeringDirectorId;
    this.qaDirectorId = data.qaDirectorId;
    this.status = data.status;

    this.validate();
  }

  validate(): void {
    if (!this.name || this.name.trim().length === 0) {
      throw new Error('Project name is required');
    }
    if (!Object.values(ProjectStatus).includes(this.status)) {
      throw new Error(`Invalid project status: ${this.status}`);
    }
  }

  // Getters
  get currentStatus(): ProjectStatus {
    return this.status;
  }

  get isActive(): boolean {
    return this.status === ProjectStatus.ACTIVE;
  }

  get repoIds(): string[] {
    return Array.from(this._repoIds);
  }

  // Methods
  setStatus(status: ProjectStatus): void {
    if (!Object.values(ProjectStatus).includes(status)) {
      throw new Error(`Invalid project status: ${status}`);
    }
    this.status = status;
    this.touch();
  }

  setDescription(description: string): void {
    this.description = description;
    this.touch();
  }

  setPRD(prdUrl: string): void {
    this.prdUrl = prdUrl;
    this.touch();
  }

  setProjectDirector(directorId: string): void {
    this.projectDirectorId = directorId;
    this.touch();
  }

  setEngineeringDirector(directorId: string): void {
    this.engineeringDirectorId = directorId;
    this.touch();
  }

  setQADirector(directorId: string): void {
    this.qaDirectorId = directorId;
    this.touch();
  }

  addRepo(repoId: string): void {
    this._repoIds.add(repoId);
    this.touch();
  }

  removeRepo(repoId: string): void {
    this._repoIds.delete(repoId);
    this.touch();
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      prdUrl: this.prdUrl,
      projectDirectorId: this.projectDirectorId,
      engineeringDirectorId: this.engineeringDirectorId,
      qaDirectorId: this.qaDirectorId,
      status: this.status,
      repoIds: this.repoIds,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
