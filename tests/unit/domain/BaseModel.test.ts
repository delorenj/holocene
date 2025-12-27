/**
 * BaseModel Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { BaseModel } from '../../../src/domain/models/BaseModel';

// Concrete implementation for testing
class TestModel extends BaseModel {
  public value: string;

  constructor(data: { id?: string; value: string; createdAt?: Date; updatedAt?: Date }) {
    super(data);
    this.value = data.value;
    this.validate();
  }

  validate(): void {
    if (!this.value) {
      throw new Error('Value is required');
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      value: this.value,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}

describe('BaseModel', () => {
  it('should generate ID if not provided', () => {
    const model = new TestModel({ value: 'test' });
    expect(model.id).toBeDefined();
    expect(typeof model.id).toBe('string');
  });

  it('should use provided ID', () => {
    const id = 'custom-id';
    const model = new TestModel({ id, value: 'test' });
    expect(model.id).toBe(id);
  });

  it('should initialize timestamps', () => {
    const model = new TestModel({ value: 'test' });
    expect(model.createdAt).toBeInstanceOf(Date);
    expect(model.updatedAt).toBeInstanceOf(Date);
  });

  it('should use provided timestamps', () => {
    const createdAt = new Date('2024-01-01');
    const updatedAt = new Date('2024-01-02');
    const model = new TestModel({ value: 'test', createdAt, updatedAt });
    expect(model.createdAt).toEqual(createdAt);
    expect(model.updatedAt).toEqual(updatedAt);
  });

  it('should serialize to JSON', () => {
    const model = new TestModel({ value: 'test' });
    const json = model.toJSON();

    expect(json).toHaveProperty('id');
    expect(json).toHaveProperty('value', 'test');
    expect(json).toHaveProperty('createdAt');
    expect(json).toHaveProperty('updatedAt');
  });

  it('should validate on construction', () => {
    expect(() => new TestModel({ value: '' })).toThrow('Value is required');
  });
});
