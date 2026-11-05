import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { fixture } from './fixtures.ts';

test('the shipped new-order example passes at zero refusals and warnings', () => {
  const report = checkProject(fixture(() => {}, 'example-project.json'));
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test('frozen pre-split example stays valid with exactly pin-drift and legacy-order warnings', () => {
  const report = checkProject(fixture());
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY']);
  const bytes = readFileSync(join(import.meta.dir, '../templates/legacy-example-project.json'));
  // Sealed original bytes from the pre-split main head, not a rewritten migration.
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('257482dcd2ea43d93903075116706067f278137296e1cb57b3df943c2a604985');
});
