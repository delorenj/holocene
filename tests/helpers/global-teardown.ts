/**
 * Global Test Teardown
 * Runs once after all tests complete
 */

export default async function globalTeardown() {
  console.log('🧹 Cleaning up test environment...');

  // Cleanup test databases, containers, etc.

  console.log('✅ Global teardown complete');
}
