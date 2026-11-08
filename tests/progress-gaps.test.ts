import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { STAGE_PROGRESS_SINCE } from '../src/stage-progress.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, bindFixtureAnswers, fixture, obj, rehashSignoffs, step } from './fixtures.ts';
import { amendCommand, checkProject, stepStatusCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
function amend(dir: string, stage: string): void {
  writeFileSync(join(dir, 'replacement.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(join(dir, 'words.txt'), 'Replace the synthetic panel.');
  amendCommand([stage, dir, '--kind', 'part', '--target', 'panel', '--change', 'replacement.svg', '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
}

beforeEach(() => testClock.set(new Date('2026-11-20T00:00:00Z')));
afterEach(() => testClock.reset());

// An amended record keeps the latest-move check while its signature window is exempt (PROJECT.md, Forward amendments).
test.each(['post', 'rig-review'])('an amended project whose stage was moved by hand to %s is refused', hand => {
  const dir = fixture(() => {}, 'example-project.json');
  amend(dir, 'rigging');
  const amended = checkProject(dir);
  expect(amended.refusals).toEqual([]);
  expect([amended.stage, amended.effective_stage]).toEqual(['accepted', 'rigging']);
  const p = read(dir); p.stage = hand; save(dir, p);
  expect(checkProject(dir).effective_stage).toBe('rigging');
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_SKIPPED');
});

// Control: a hand move onto the effective stage itself.
test('an amended project moved by hand onto its effective stage is refused', () => {
  const dir = fixture(() => {}, 'example-project.json');
  amend(dir, 'rigging');
  const p = read(dir); p.stage = 'rigging'; save(dir, p);
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_SKIPPED');
});

// The legacy rigging route for step-status still needs the live stage-level plan approval.
test('an amended pre-parts project cannot run a parts step in rigging through the oldOrder route', () => {
  const dir = fixture(p => {
    Object.assign(p, JSON.parse(JSON.stringify(p).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,
      value => new Date(Date.parse(value) - 30 * 86_400_000).toISOString())));
    p.stage = 'rigging'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'rigging'].includes(String(obj(s).stage)));
    for (const raw of arr(p.signoffs)) {
      const signature = obj(raw); if (signature.stage === 'parts') signature.stage = 'rigging'; delete signature.answer_hashes;
    }
    for (const raw of arr(obj(p.plan).steps)) if (obj(raw).phase === 'post') obj(raw).status = 'pending';
    step(p, 'assemble').status = 'pending'; rehashSignoffs(p); bindFixtureAnswers(p);
  });
  expect(checkProject(dir).refusals).toEqual([]);
  amend(dir, 'plan-approved');
  expect([checkProject(dir).stage, checkProject(dir).effective_stage]).toEqual(['rigging', 'plan-approved']);
  const before = readFileSync(join(dir, 'project.json'));
  try { stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent']); throw new Error('expected refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe('STEP_RUN_UNAPPROVED');
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

// A legacy record without advances keeps its retained approvals as the date of its unrecorded move after amend voids them.
// On the cutoff the refusal is carried, so amend records the change and check keeps reporting it.
test.each([
  ['before', 'warns', false],
  ['on', 'refuses', true],
] as const)('an amended legacy project without advances whose arrival is dated %s STAGE_PROGRESS_SINCE %s STAGE_SKIPPED', (_when, _verdict, atCutoff) => {
  const dir = fixture(p => {
    delete p.advances;
    if (atCutoff) for (const raw of arr(p.signoffs)) if (obj(raw).stage === 'direction-review') obj(raw).at = STAGE_PROGRESS_SINCE;
  });
  const before = checkProject(dir);
  expect(before.stage).toBe('accepted');
  if (!atCutoff) {
    expect(before.refusals).toEqual([]);
    amend(dir, 'interview');
    const after = checkProject(dir);
    expect([after.stage, after.effective_stage]).toEqual(['accepted', 'interview']);
    expect(after.refusals).toEqual([]);
    expect(after.warnings.map(f => `${f.code}@${f.path}`)).toContain('STAGE_SKIPPED@stage');
    return;
  }
  expect(before.refusals.map(f => `${f.code}@${f.path}`)).toEqual(['STAGE_SKIPPED@stage']);
  amend(dir, 'interview');
  const after = checkProject(dir);
  expect([after.stage, after.effective_stage]).toEqual(['accepted', 'interview']);
  expect(after.refusals.map(f => `${f.code}@${f.path}`)).toEqual(['STAGE_SKIPPED@stage']);
});
