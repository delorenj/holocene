/**
 * Decision Domain Model
 * Represents an artifact created during a Session
 */

import { BaseModel } from './BaseModel';

export enum DecisionImpact {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum DecisionCategory {
  ARCHITECTURAL = 'architectural',
  TECHNICAL = 'technical',
  PROCESS = 'process',
  PRODUCT = 'product',
  OPERATIONAL = 'operational',
}

export interface DecisionData {
  id?: string;
  title: string;
  context: string;
  decision: string;
  rationale: string;
  consequences?: string;
  alternatives?: string[];
  impact: DecisionImpact;
  category: DecisionCategory;
  sessionId?: string;
  repoId?: string;
  projectId?: string;
  madeById: string; // Employee ID
  reversible: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Decision extends BaseModel {
  public readonly title: string;
  private context: string;
  private decision: string;
  private rationale: string;
  private consequences?: string;
  private alternatives: string[];
  private impact: DecisionImpact;
  private category: DecisionCategory;
  private sessionId?: string;
  private repoId?: string;
  private projectId?: string;
  private madeById: string;
  private reversible: boolean;
  private reversedAt?: Date;
  private reversedBy?: string;

  constructor(data: DecisionData) {
    super(data);
    this.title = data.title;
    this.context = data.context;
    this.decision = data.decision;
    this.rationale = data.rationale;
    this.consequences = data.consequences;
    this.alternatives = data.alternatives || [];
    this.impact = data.impact;
    this.category = data.category;
    this.sessionId = data.sessionId;
    this.repoId = data.repoId;
    this.projectId = data.projectId;
    this.madeById = data.madeById;
    this.reversible = data.reversible;

    this.validate();
  }

  validate(): void {
    if (!this.title || this.title.trim().length === 0) {
      throw new Error('Decision title is required');
    }
    if (!this.context || this.context.trim().length === 0) {
      throw new Error('Decision context is required');
    }
    if (!this.decision || this.decision.trim().length === 0) {
      throw new Error('Decision content is required');
    }
    if (!this.rationale || this.rationale.trim().length === 0) {
      throw new Error('Decision rationale is required');
    }
    if (!Object.values(DecisionImpact).includes(this.impact)) {
      throw new Error(`Invalid decision impact: ${this.impact}`);
    }
    if (!Object.values(DecisionCategory).includes(this.category)) {
      throw new Error(`Invalid decision category: ${this.category}`);
    }
    if (!this.madeById) {
      throw new Error('Decision maker ID is required');
    }
  }

  // Getters
  get isReversed(): boolean {
    return !!this.reversedAt;
  }

  get canBeReversed(): boolean {
    return this.reversible && !this.isReversed;
  }

  get impactLevel(): DecisionImpact {
    return this.impact;
  }

  // Methods
  reverse(employeeId: string): void {
    if (!this.canBeReversed) {
      throw new Error('Decision cannot be reversed');
    }
    this.reversedAt = new Date();
    this.reversedBy = employeeId;
    this.touch();
  }

  updateRationale(rationale: string): void {
    if (!rationale || rationale.trim().length === 0) {
      throw new Error('Rationale cannot be empty');
    }
    this.rationale = rationale;
    this.touch();
  }

  addConsequences(consequences: string): void {
    this.consequences = consequences;
    this.touch();
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      title: this.title,
      context: this.context,
      decision: this.decision,
      rationale: this.rationale,
      consequences: this.consequences,
      alternatives: this.alternatives,
      impact: this.impact,
      category: this.category,
      sessionId: this.sessionId,
      repoId: this.repoId,
      projectId: this.projectId,
      madeById: this.madeById,
      reversible: this.reversible,
      reversedAt: this.reversedAt?.toISOString(),
      reversedBy: this.reversedBy,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
