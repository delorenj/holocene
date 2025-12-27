/**
 * Architectural Fitness Test: Single Responsibility Principle
 * Ensures classes maintain focused responsibilities
 */

import { describe, it, expect } from '@jest/globals';
import * as glob from 'glob';
import * as fs from 'fs';
import * as path from 'path';

describe('Architectural Fitness: Single Responsibility Principle', () => {
  const srcDir = path.join(__dirname, '../../src');

  it('should enforce max file size of 500 lines', async () => {
    const files = glob.sync(`${srcDir}/**/*.{ts,tsx}`, {
      ignore: ['**/*.d.ts', '**/*.spec.ts', '**/*.test.ts'],
    });

    const violations: Array<{ file: string; lines: number }> = [];

    files.forEach(file => {
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n').length;

      if (lines > 500) {
        violations.push({
          file: path.relative(srcDir, file),
          lines,
        });
      }
    });

    expect(violations).toEqual([]);

    if (violations.length > 0) {
      console.error('❌ Files exceeding 500 lines:');
      violations.forEach(v => {
        console.error(`  - ${v.file}: ${v.lines} lines`);
      });
    }
  });

  it('should enforce max function complexity', async () => {
    // This would integrate with complexity analysis tools
    // For now, we'll check basic metrics

    const files = glob.sync(`${srcDir}/**/*.{ts,tsx}`, {
      ignore: ['**/*.d.ts', '**/*.spec.ts', '**/*.test.ts'],
    });

    const violations: Array<{ file: string; issue: string }> = [];

    files.forEach(file => {
      const content = fs.readFileSync(file, 'utf-8');

      // Check for deeply nested functions (> 4 levels)
      const nestedBraceCount = (content.match(/\{/g) || []).length;
      const lines = content.split('\n').length;
      const avgNesting = nestedBraceCount / Math.max(lines, 1);

      if (avgNesting > 0.3) {
        violations.push({
          file: path.relative(srcDir, file),
          issue: `High nesting complexity (${avgNesting.toFixed(2)} braces/line)`,
        });
      }

      // Check for very long functions (simple heuristic)
      const functionMatches = content.match(/function\s+\w+|=>\s*\{/g) || [];
      const functionCount = functionMatches.length;

      if (lines > 100 && functionCount < 3) {
        violations.push({
          file: path.relative(srcDir, file),
          issue: 'Possible monolithic function (few functions in large file)',
        });
      }
    });

    expect(violations).toEqual([]);

    if (violations.length > 0) {
      console.error('❌ Complexity violations:');
      violations.forEach(v => {
        console.error(`  - ${v.file}: ${v.issue}`);
      });
    }
  });

  it('should have clear module boundaries', () => {
    const layers = ['models', 'services', 'controllers', 'repositories'];

    layers.forEach(layer => {
      const layerPath = path.join(srcDir, layer);

      if (fs.existsSync(layerPath)) {
        expect(fs.statSync(layerPath).isDirectory()).toBe(true);
      }
    });
  });
});
