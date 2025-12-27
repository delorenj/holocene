/**
 * Global Test Setup
 * Runs once before all tests
 */

export default async function globalSetup() {
  console.log('🧪 Starting test suite...');

  // Set environment variables
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error';

  // Initialize test database (if needed)
  // Could setup test containers, mock services, etc.

  console.log('✅ Global setup complete');
}
