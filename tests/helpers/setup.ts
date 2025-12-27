/**
 * Jest Test Setup
 * Configures global test environment
 */

import '@testing-library/jest-dom';

// Extend Jest matchers
expect.extend({
  toBeValidUUID(received: string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const pass = uuidRegex.test(received);

    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be a valid UUID`
          : `expected ${received} to be a valid UUID`,
    };
  },

  toBeValidISO8601(received: string) {
    const date = new Date(received);
    const pass = !isNaN(date.getTime()) && received === date.toISOString();

    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be valid ISO8601`
          : `expected ${received} to be valid ISO8601`,
    };
  },

  toSatisfySRP(received: any) {
    // Single Responsibility Principle check
    const methods = Object.getOwnPropertyNames(received.prototype || received)
      .filter(name => typeof received[name] === 'function' && name !== 'constructor');

    const pass = methods.length <= 10; // Max 10 public methods

    return {
      pass,
      message: () =>
        pass
          ? `expected class to violate SRP (has ${methods.length} methods)`
          : `expected class to satisfy SRP, but has ${methods.length} methods (max: 10)`,
    };
  },
});

// Global test configuration
global.console = {
  ...console,
  // Suppress console during tests unless DEBUG is set
  log: process.env.DEBUG ? console.log : jest.fn(),
  debug: process.env.DEBUG ? console.debug : jest.fn(),
  info: process.env.DEBUG ? console.info : jest.fn(),
  warn: console.warn,
  error: console.error,
};

// Set timezone for consistent date testing
process.env.TZ = 'UTC';

// Increase timeout for integration tests
jest.setTimeout(10000);
