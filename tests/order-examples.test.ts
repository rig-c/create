import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { validateCorrectionIdentity } from '../src/corrections.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { fixture } from './fixtures.ts';
import { CLI } from './helpers.ts';

test('all generated example events satisfy every source contract date within two minutes', () => {
  const src = join(import.meta.dir, '../src');
  const boundaries = readdirSync(src).filter(name => name.endsWith('.ts')).flatMap(name =>
    [...readFileSync(join(src, name), 'utf8').matchAll(/export const \w+_SINCE = '([^']+)'/g)].map(match => Date.parse(match[1]!)));
  expect(boundaries.length).toBeGreaterThan(0);
  const dates: number[] = [];
  const collect = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) collect(child);
      else if (entry.name.endsWith('.json')) dates.push(...[...readFileSync(child, 'utf8').matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map(match => Date.parse(match[0])));
    }
  };
  const templates = join(import.meta.dir, '../templates');
  for (const name of ['example-draft', 'example-interview-options', 'example-invariants']) collect(join(templates, name));
  for (const name of ['example-project.json', 'example-interview-choice.json']) {
    dates.push(...[...readFileSync(join(templates, name), 'utf8').matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map(match => Date.parse(match[0])));
  }
  expect(dates.length).toBeGreaterThan(0);
  for (const boundary of boundaries) expect(Math.min(...dates)).toBeGreaterThanOrEqual(boundary);
  expect(Math.min(...dates)).toBe(Math.max(...boundaries));
  expect(Math.max(...dates) - Math.min(...dates)).toBeLessThanOrEqual(120_000);
  expect(dates.every(date => date % 1000 === 0)).toBe(true);
});

test('the public writer reopens the signed example at the real clock and keeps its approvals', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const before = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  writeFileSync(join(dir, 'words.txt'), 'Reopen the synthetic parts for correction.');
  const result = Bun.spawnSync([process.execPath, CLI, 'reopen', 'parts-review', dir,
    '--by', 'reviewer', '--verbatim-file', join(dir, 'words.txt')], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(after.stage).toBe('parts-review');
  expect(after.signoffs).toEqual(before.signoffs);
  expect(checkProject(dir).refusals).toEqual([]);
});

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

test('frozen pre-split example is refused by build-identity and missing review targets', () => {
  const report = checkProject(fixture(() => {}, 'legacy-example-project.json', {}, true));
  expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_PARTS_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH', 'REVIEW_PACKAGE_PART_FILE_MISMATCH']);
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
