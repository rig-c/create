import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { validateCorrectionIdentity } from '../src/corrections.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { fixture } from './fixtures.ts';

test('the signed example draft resolves as a parts-review correction identity', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const project = readTemplate('example-project.json');
  const draft = (project.drafts as JsonObject[])[0]!;
  const parts = draft.parts as JsonObject;
  const files = [...parts.files as JsonObject[]].sort((a, b) => String(a.path) < String(b.path) ? -1 : 1);
  const identity = {
    kind: 'draft', id: draft.id!, config: draft.config!,
    parts: { manifest: files.find(file => file.path === `${String(parts.path)}/parts.json`)!, files },
    model: (draft.files as JsonObject[]).find(file => String(file.path).endsWith('/skeleton.model.json'))!,
  };
  expect(identity.model).toBeDefined();
  expect(validateCorrectionIdentity(dir, project, identity, 'parts-review')).toEqual(identity);
});

test('the shipped new-order example passes at zero refusals and warnings', () => {
  const report = checkProject(fixture(() => {}, 'example-project.json'));
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test('frozen pre-split example stays valid with exactly pin-drift and legacy-order warnings', () => {
  const report = checkProject(fixture());
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
  const bytes = readFileSync(join(import.meta.dir, '../templates/legacy-example-project.json'));
  // Sealed original bytes from the pre-split main head, not a rewritten migration.
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('257482dcd2ea43d93903075116706067f278137296e1cb57b3df943c2a604985');
});


test('a cloned new-order example keeps its retained structure while ignored artifacts warn', () => {
  const dir = fixture(() => {}, 'example-project.json');
  rmSync(join(dir, 'derived'), { recursive: true });
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual([
    'DRAFT_RIG_UNAVAILABLE', 'DERIVED_RESULT_MISSING', 'REVIEW_PACKAGE_MISSING', 'REVIEW_PACKAGE_MISSING',
  ]);
  // A retained human snapshot remains mandatory and hash-bound on that same clone.
  rmSync(join(dir, 'evidence/structure-decisions.json'));
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STRUCTURE_DECISIONS_INVALID');
});
