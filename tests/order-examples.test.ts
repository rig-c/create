import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCorrectionIdentity } from '../src/corrections.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { fixture, materializeFixture, obj, plantLegacyReopen } from './fixtures.ts';
import { checkProject } from './clock.ts';
import { run, tempDir } from './helpers.ts';

const templates = join(import.meta.dir, '../templates');

function exampleDates(path: string): number[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path).flatMap(name => exampleDates(join(path, name)));
  }
  if (!path.endsWith('.json')) return [];
  return [...readFileSync(path, 'utf8').matchAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g)].map(match => Date.parse(match[0]));
}

function expectTwoMinuteWindow(dates: number[], anchor: number): void {
  expect(dates.length).toBeGreaterThan(0);
  expect(Math.min(...dates)).toBe(anchor);
  expect(Math.max(...dates) - anchor).toBeLessThanOrEqual(120_000);
  expect(dates.every(date => date % 1000 === 0)).toBe(true);
}

test('the current example and shared producer stamps follow the latest source contract date', () => {
  const src = join(import.meta.dir, '../src');
  const boundaries = readdirSync(src).filter(name => name.endsWith('.ts')).flatMap(name =>
    [...readFileSync(join(src, name), 'utf8').matchAll(/export const \w+_SINCE = '([^']+)'/g)].map(match => Date.parse(match[1]!)));
  expect(boundaries.length).toBeGreaterThan(0);
  for (const name of ['example-current', 'example-draft']) {
    expectTwoMinuteWindow(exampleDates(join(templates, name)), Math.max(...boundaries));
  }
});

test('numbered events and their dependent examples retain the frozen two-minute window', () => {
  const numbered = join(templates, 'example-numbered');
  const dates = ['example-project.json', 'derived', 'evidence', 'inputs', 'outputs']
    .flatMap(name => exampleDates(join(numbered, name)));
  const anchor = Date.parse('2026-11-27T00:00:00Z');
  expectTwoMinuteWindow(dates, anchor);
  for (const name of ['example-interview-options', 'example-interview-choice.json', 'example-invariants']) {
    const dependentDates = exampleDates(join(templates, name));
    expect(dependentDates.length).toBeGreaterThan(0);
    dates.push(...dependentDates);
  }
  expectTwoMinuteWindow(dates, anchor);
});

test('the numbered fixture CLI verifies the file hash and reader baselines', () => {
  const root = tempDir();
  const result = run([process.execPath, join(import.meta.dir, '../scripts/check-example-numbered.ts'),
    join(root, 'numbered'), '--check'], root, process.env as Record<string, string>);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(8);
  expect(result.stdout).toContain('numbered example: 216 file hashes and 7 reader results match');
}, 30_000);

test('the default materialized example has current outputs and passes at zero refusals and warnings', () => {
  const dir = materializeFixture(join(tempDir(), 'current'));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(project.stage).toBe('accepted');
  expect(project.versions).toEqual([]);
  expect(Object.keys(obj(project.current)).sort()).toEqual(['direction', 'motion', 'parts', 'rig']);
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test('the signed example still checks with a historical reopen and its retained approvals', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const before = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  writeFileSync(join(dir, 'words.txt'), 'Reopen the synthetic parts for correction.');
  plantLegacyReopen(dir, 'parts-review', { by: 'reviewer', wordsFile: join(dir, 'words.txt') });
  const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(after.stage).toBe('parts-review');
  expect(after.signoffs).toEqual(before.signoffs);
  expect(checkProject(dir).refusals).toEqual([]);
});

test('the signed example draft resolves as a parts-review correction identity', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const project = readTemplate('example-numbered/example-project.json');
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
  const report = checkProject(fixture(() => {}, 'example-numbered/example-project.json'));
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test('a clean older record with no declaration still passes the check', () => {
  const dir = fixture(project => { delete project.owner; }, 'example-numbered/example-project.json');
  const report = checkProject(dir);
  expect(report.ok).toBe(true);
  expect(report.refusals).toEqual([]);
  expect(report.warnings.map(warning => warning.code)).toEqual(['OWNER_LANGUAGE_MISSING']);
});

test('frozen pre-split example is refused by build-identity and missing review targets', () => {
  const report = checkProject(fixture(() => {}, 'legacy-example-project.json', {}, true));
  expect(report.refusals.map(f => f.code)).toEqual(['SIGNOFF_TARGET_MISSING', 'SIGNOFF_TARGET_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'SIGNOFF_ANSWERS_MISSING', 'PARTS_VERDICT_RECEIPT_REQUIRED', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'REVIEW_PACKAGE_CONFIG_MISMATCH', 'DIRECTION_SCENE_REQUIRED', 'DIRECTION_SCENE_REQUIRED']);
  expect(report.warnings.map(f => f.code)).toEqual(['CREATE_PIN_MISSING', 'QUESTION_SET_STALE', 'RIGGING_INTERVIEW_PAINTING_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY', 'OWNER_LANGUAGE_MISSING']);
  const bytes = readFileSync(join(import.meta.dir, '../templates/legacy-example-project.json'));
  // Sealed original bytes from the pre-split main head, not a rewritten migration.
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('257482dcd2ea43d93903075116706067f278137296e1cb57b3df943c2a604985');
});


test('a cloned new-order example keeps its retained structure while ignored artifacts warn', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  rmSync(join(dir, 'derived'), { recursive: true });
  const report = checkProject(dir);
  expect(report.refusals.map(f => f.code)).toEqual(['SCENE_MODEL_MISMATCH', 'SCENE_MODEL_MISMATCH']);
  expect(report.warnings.map(f => f.code)).toEqual([
    'DRAFT_RIG_UNAVAILABLE', 'DRAFT_RIG_UNAVAILABLE', 'DERIVED_RESULT_MISSING', 'REVIEW_PACKAGE_MISSING', 'REVIEW_PACKAGE_MISSING',
  ]);
  // A retained human snapshot remains mandatory and hash-bound on that same clone.
  rmSync(join(dir, 'evidence/structure-example.json'));
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STRUCTURE_DECISIONS_INVALID');
});
