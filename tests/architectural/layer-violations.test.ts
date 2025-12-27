/**
 * Architectural Fitness Test: Layer Violation Detection
 * Ensures proper dependency flow between architectural layers
 */

import { describe, it, expect } from '@jest/globals';
import * as glob from 'glob';
import * as fs from 'fs';
import * as path from 'path';

describe('Architectural Fitness: Layer Violations', () => {
  const srcDir = path.join(__dirname, '../../src');

  /**
   * Dependency Rules:
   * - Controllers can import: services, models, utils
   * - Services can import: repositories, models, utils
   * - Repositories can import: models, utils
   * - Models can import: utils only
   * - Utils can import: nothing (leaf layer)
   */
  const layerRules: Record<string, string[]> = {
    controllers: ['services', 'models', 'utils', 'config'],
    services: ['repositories', 'models', 'utils', 'config'],
    repositories: ['models', 'utils', 'config'],
    models: ['utils'],
    utils: [],
    config: ['utils'],
  };

  it('should not violate layer dependencies', () => {
    const violations: Array<{ file: string; violation: string }> = [];

    Object.keys(layerRules).forEach(layer => {
      const layerPath = path.join(srcDir, layer);

      if (!fs.existsSync(layerPath)) {
        return; // Layer doesn't exist yet
      }

      const files = glob.sync(`${layerPath}/**/*.{ts,tsx}`, {
        ignore: ['**/*.spec.ts', '**/*.test.ts'],
      });

      files.forEach(file => {
        const content = fs.readFileSync(file, 'utf-8');
        const allowedLayers = layerRules[layer];

        // Find all imports
        const importRegex = /import\s+.*\s+from\s+['"]@\/(\w+)\//g;
        let match;

        while ((match = importRegex.exec(content)) !== null) {
          const importedLayer = match[1];

          if (!allowedLayers.includes(importedLayer)) {
            violations.push({
              file: path.relative(srcDir, file),
              violation: `${layer} → ${importedLayer} (not allowed)`,
            });
          }
        }
      });
    });

    expect(violations).toEqual([]);

    if (violations.length > 0) {
      console.error('❌ Layer violations detected:');
      violations.forEach(v => {
        console.error(`  - ${v.file}: ${v.violation}`);
      });
    }
  });

  it('should prevent circular dependencies', () => {
    // This would integrate with madge or similar tools
    // For now, we'll do basic checks

    const files = glob.sync(`${srcDir}/**/*.{ts,tsx}`, {
      ignore: ['**/*.spec.ts', '**/*.test.ts', '**/*.d.ts'],
    });

    const violations: string[] = [];

    files.forEach(file => {
      const content = fs.readFileSync(file, 'utf-8');
      const fileName = path.basename(file, path.extname(file));

      // Check if file imports something that might import it back
      const importRegex = /import\s+.*\s+from\s+['"](\.\.?\/.+)['"]/g;
      let match;

      while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        const importedFile = path.resolve(path.dirname(file), importPath);

        if (fs.existsSync(importedFile + '.ts') || fs.existsSync(importedFile + '.tsx')) {
          const importedContent = fs.readFileSync(
            fs.existsSync(importedFile + '.ts') ? importedFile + '.ts' : importedFile + '.tsx',
            'utf-8'
          );

          // Simple check: does imported file import us back?
          if (importedContent.includes(fileName)) {
            violations.push(
              `Potential circular dependency: ${path.relative(srcDir, file)} ↔ ${importPath}`
            );
          }
        }
      }
    });

    expect(violations).toEqual([]);

    if (violations.length > 0) {
      console.error('⚠️  Potential circular dependencies:');
      violations.forEach(v => console.error(`  - ${v}`));
    }
  });

  it('should have clear abstraction boundaries', () => {
    // Check that interfaces/abstractions exist for key layers
    const requiredAbstractions = ['repositories', 'services'];

    requiredAbstractions.forEach(layer => {
      const layerPath = path.join(srcDir, layer);

      if (fs.existsSync(layerPath)) {
        const interfaceFiles = glob.sync(`${layerPath}/**/*.interface.ts`);

        // If layer has implementations, it should have interfaces
        const implFiles = glob.sync(`${layerPath}/**/*.ts`, {
          ignore: ['**/*.interface.ts', '**/*.spec.ts', '**/*.test.ts'],
        });

        if (implFiles.length > 0) {
          expect(interfaceFiles.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
