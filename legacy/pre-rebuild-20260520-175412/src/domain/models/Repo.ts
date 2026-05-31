/**
 * Repo Domain Model
 * Represents a repository cloned locally by iMi
 */

import { BaseModel } from './BaseModel';
import { Employee } from './Employee';

export interface RepoData {
  id?: string;
  name: string;
  remote: string;
  localPath: string;
  defaultBranch: string;
  leadArchitectId?: string;
  projectManagerId?: string;
  qaLeadId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Repo extends BaseModel {
  public readonly name: string;
  public readonly remote: string;
  public readonly localPath: string;
  public readonly defaultBranch: string;
  private leadArchitectId?: string;
  private projectManagerId?: string;
  private qaLeadId?: string;

  // Lazy-loaded relationships
  private _leadArchitect?: Employee;
  private _projectManager?: Employee;
  private _qaLead?: Employee;

  constructor(data: RepoData) {
    super(data);
    this.name = data.name;
    this.remote = data.remote;
    this.localPath = data.localPath;
    this.defaultBranch = data.defaultBranch;
    this.leadArchitectId = data.leadArchitectId;
    this.projectManagerId = data.projectManagerId;
    this.qaLeadId = data.qaLeadId;

    this.validate();
  }

  validate(): void {
    if (!this.name || this.name.trim().length === 0) {
      throw new Error('Repo name is required');
    }
    if (!this.remote || !this.remote.startsWith('http')) {
      throw new Error('Invalid repo remote URL');
    }
    if (!this.localPath || this.localPath.trim().length === 0) {
      throw new Error('Repo local path is required');
    }
    if (!this.defaultBranch || this.defaultBranch.trim().length === 0) {
      throw new Error('Repo default branch is required');
    }
  }

  // Getters
  get leadArchitect(): Employee | undefined {
    return this._leadArchitect;
  }

  get projectManager(): Employee | undefined {
    return this._projectManager;
  }

  get qaLead(): Employee | undefined {
    return this._qaLead;
  }

  // Setters with validation
  setLeadArchitect(architect: Employee): void {
    this._leadArchitect = architect;
    this.leadArchitectId = architect.id;
    this.touch();
  }

  setProjectManager(manager: Employee): void {
    this._projectManager = manager;
    this.projectManagerId = manager.id;
    this.touch();
  }

  setQALead(qaLead: Employee): void {
    this._qaLead = qaLead;
    this.qaLeadId = qaLead.id;
    this.touch();
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      remote: this.remote,
      localPath: this.localPath,
      defaultBranch: this.defaultBranch,
      leadArchitectId: this.leadArchitectId,
      projectManagerId: this.projectManagerId,
      qaLeadId: this.qaLeadId,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
