/**
 * Employee Model Unit Tests
 */

import { describe, it, expect } from 'vitest';
import { Employee, AgentType, SalaryLevel } from '../../../src/domain/models/Employee';

describe('Employee', () => {
  const validEmployeeData = {
    name: 'Test Employee',
    agentType: AgentType.CLAUDE,
    salary: SalaryLevel.MID,
  };

  describe('Construction', () => {
    it('should create employee with valid data', () => {
      const employee = new Employee(validEmployeeData);
      expect(employee.name).toBe(validEmployeeData.name);
      expect(employee.agentType).toBe(validEmployeeData.agentType);
      expect(employee.salaryLevel).toBe(validEmployeeData.salary);
    });

    it('should throw error for empty name', () => {
      expect(() => new Employee({ ...validEmployeeData, name: '' }))
        .toThrow('Employee name is required');
    });

    it('should throw error for invalid agent type', () => {
      expect(() => new Employee({ ...validEmployeeData, agentType: 'invalid' as AgentType }))
        .toThrow('Invalid agent type');
    });

    it('should throw error for invalid salary level', () => {
      expect(() => new Employee({ ...validEmployeeData, salary: 'invalid' as SalaryLevel }))
        .toThrow('Invalid salary level');
    });
  });

  describe('Task Assignment', () => {
    it('should assign task to employee', () => {
      const employee = new Employee(validEmployeeData);
      expect(employee.isActive).toBe(false);

      employee.assignTask('task-123');
      expect(employee.isActive).toBe(true);
    });

    it('should throw error when assigning task to busy employee', () => {
      const employee = new Employee(validEmployeeData);
      employee.assignTask('task-123');

      expect(() => employee.assignTask('task-456'))
        .toThrow('Employee already has active task');
    });

    it('should complete task', () => {
      const employee = new Employee(validEmployeeData);
      employee.assignTask('task-123');

      employee.completeTask();
      expect(employee.isActive).toBe(false);
    });

    it('should throw error when completing with no active task', () => {
      const employee = new Employee(validEmployeeData);
      expect(() => employee.completeTask())
        .toThrow('No active task to complete');
    });
  });

  describe('Promotion', () => {
    it('should promote employee to higher level', () => {
      const employee = new Employee(validEmployeeData);
      employee.promote(SalaryLevel.SENIOR);
      expect(employee.salaryLevel).toBe(SalaryLevel.SENIOR);
    });

    it('should throw error when promoting to same level', () => {
      const employee = new Employee(validEmployeeData);
      expect(() => employee.promote(SalaryLevel.MID))
        .toThrow('Cannot promote to same or lower level');
    });

    it('should throw error when demoting', () => {
      const employee = new Employee(validEmployeeData);
      expect(() => employee.promote(SalaryLevel.JUNIOR))
        .toThrow('Cannot promote to same or lower level');
    });
  });

  describe('Experience and Expertise', () => {
    it('should add domain of experience', () => {
      const employee = new Employee(validEmployeeData);
      employee.addExperience('React');
      employee.addExperience('TypeScript');

      expect(employee.domainsOfExperience).toContain('React');
      expect(employee.domainsOfExperience).toContain('TypeScript');
      expect(employee.domainsOfExperience).toHaveLength(2);
    });

    it('should add domain of expertise', () => {
      const employee = new Employee(validEmployeeData);
      employee.addExpertise('System Architecture');

      expect(employee.domainsOfExpertise).toContain('System Architecture');
    });

    it('should not duplicate domains', () => {
      const employee = new Employee(validEmployeeData);
      employee.addExperience('React');
      employee.addExperience('React');

      expect(employee.domainsOfExperience).toHaveLength(1);
    });
  });
});
