/**
 * Base Model - Foundation for all domain entities
 * Implements common functionality for domain models
 */

export interface IBaseModel {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export abstract class BaseModel implements IBaseModel {
  public readonly id: string;
  public readonly createdAt: Date;
  public updatedAt: Date;

  constructor(data: {
    id?: string;
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    this.id = data.id || this.generateId();
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
  }

  /**
   * Generate unique identifier
   * Override this method to implement custom ID generation
   */
  protected generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Update the updatedAt timestamp
   */
  protected touch(): void {
    this.updatedAt = new Date();
  }

  /**
   * Validate the model state
   * Override this method to implement custom validation
   */
  abstract validate(): void;

  /**
   * Convert model to plain object for persistence
   */
  abstract toJSON(): Record<string, unknown>;
}
