import { afterEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { PROGRESS_HISTORY_SINCE } from '../src/stage-progress.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, retimeFixture } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { advanceCommand, checkProject, reopenCommand, signoffCommand, stepStatusCommand, testClock } from './clock.ts';

const CHECKPOINTS = join(import.meta.dir, '../templates/example-chain/checkpoints');
const CODE = 'REOPEN_STEP_UNLINKED';
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
function words(dir: string): string { const path = join(dir, 'words.txt'); writeFileSync(path, 'Move the synthetic project.\n'); return path; }
const findings = (dir: string, list: 'refusals' | 'warnings'): string[][] => checkProject(dir)[list].map(f => [f.code, f.path]);
const unlinked = (dir: string, list: 'refusals' | 'warnings'): string[][] => findings(dir, list).filter(([code]) => code!.endsWith('_UNLINKED'));
function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); throw new Error(`expected ${code}`); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code);
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

let clock = 0;
/** Each writer call runs one minute after the last, so every new record is ordered in time. */
function at(instant: number): void { clock = instant; testClock.set(clock); }
function tick(): void { at(clock + 60_000); }
const status = (dir: string, id: string, value: string): void => { tick(); stepStatusCommand([id, value, dir, '--by', 'agent']); };
const reopen = (dir: string, stage: string): void => { tick(); reopenCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]); };

/** A writer-built example-chain prefix: its rig steps are done with no status history. */
function rigReview(start: number): string {
  const dir = join(tempDir(), 'project');
  cpSync(join(CHECKPOINTS, '3-rig-review'), dir, { recursive: true });
  at(start);
  return dir;
}
/** A fixture with every step pending, moved by the writers into parts. */
function parts(start: number): string {
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = [];
    p.signoffs = arr(p.signoffs).slice(0, 2);
    retimeFixture(p, start);
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
  });
  at(start); advanceCommand(['parts', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  expect(read(dir).stage).toBe('parts');
  return dir;
}
const before = (project: JsonObject, id: string, reopen = 0): JsonObject =>
  obj(arr(obj(arr(project.reopens)[reopen]).steps_before).find(raw => obj(raw).id === id));
const beforePath = (project: JsonObject, id: string, reopen = 0): string =>
  `reopens[${reopen}].steps_before[${arr(obj(arr(project.reopens)[reopen]).steps_before).findIndex(raw => obj(raw).id === id)}]`;
const handSet = (dir: string, id: string, value: string): void => {
  const project = read(dir); obj(arr(obj(project.plan).steps).find(raw => obj(raw).id === id)).status = value; save(dir, project);
};

afterEach(() => testClock.reset());

const NOW = Date.parse('2026-11-20T00:00:00Z');
const SINCE = Date.parse(PROGRESS_HISTORY_SINCE);

/** What a reopen to post voids on the filled example (#220): the direction-review sign-off and acceptance. */
const POST_LAPSES = [['REOPEN_SIGNOFF_LAPSED', 'signoffs[10]'], ['REOPEN_VERDICT_LAPSED', 'versions[v4].verdicts[0]']];

test('writer-only round trip on the generated example: reopen, step-status chain, reopen, check lists only the lapsed approvals', () => {
  const dir = fixture(() => {}, 'example-project.json');
  expect(read(dir).stage).toBe('accepted');
  expect(findings(dir, 'refusals')).toEqual([]);
  expect(findings(dir, 'warnings')).toEqual([]);
  at(NOW); reopen(dir, 'post');
  expect(before(read(dir), 'camera').status).toBe('done');
  expect(findings(dir, 'refusals')).toEqual([]);
  expect(findings(dir, 'warnings')).toEqual(POST_LAPSES);
  status(dir, 'camera', 'in-progress'); status(dir, 'camera', 'at-checkpoint'); status(dir, 'timing', 'in-progress');
  reopen(dir, 'post');
  const project = read(dir);
  expect([before(project, 'camera', 1).status, before(project, 'timing', 1).status, before(project, 'composition', 1).status])
    .toEqual(['at-checkpoint', 'in-progress', 'pending']);
  expect(findings(dir, 'refusals')).toEqual([]);
  expect(findings(dir, 'warnings')).toEqual(POST_LAPSES);
});

test('a planted steps_before status on an example-chain prefix is refused at its record path', () => {
  const dir = rigReview(NOW);
  reopen(dir, 'rigging');
  expect(findings(dir, 'refusals')).toEqual([]);
  expect(findings(dir, 'warnings')).toEqual([]);
  status(dir, 'bones', 'in-progress');
  reopen(dir, 'rigging');
  const planted = read(dir);
  const path = beforePath(planted, 'bones', 1);
  // The prefix's done bones had no history at the first reopen, so that snapshot is not judged.
  expect(unlinked(dir, 'refusals')).toEqual([]);
  expect(unlinked(dir, 'warnings')).toEqual([]);
  before(planted, 'bones', 1).status = 'done'; save(dir, planted);
  expect(unlinked(dir, 'refusals')).toEqual([[CODE, path]]);
  expect(unlinked(dir, 'warnings')).toEqual([]);
});

test('a step done with no history at a reopen dated from the cutoff can still be redone through step-status', () => {
  const dir = parts(NOW);
  expect(Date.parse(String(obj(arr(read(dir).advances).at(-1)).at))).toBeGreaterThanOrEqual(SINCE);
  handSet(dir, 'seethrough', 'done');
  expect(unlinked(dir, 'refusals')).toEqual([]);
  reopen(dir, 'parts');
  expect(before(read(dir), 'seethrough').status).toBe('done');
  status(dir, 'seethrough', 'in-progress');
  expect(arr(obj(arr(obj(read(dir).plan).steps).find(raw => obj(raw).id === 'seethrough')).status_history)).toHaveLength(1);
  expect(checkProject(dir).refusals.map(f => f.code)).not.toContain(CODE);
  expect(checkProject(dir).warnings.map(f => f.code)).not.toContain(CODE);
});

test('an omitted steps_before status reads as pending; a malformed one keeps REOPEN_MALFORMED', () => {
  const dir = parts(NOW);
  status(dir, 'seethrough', 'in-progress');
  reopen(dir, 'parts');
  const planted = read(dir);
  const path = beforePath(planted, 'seethrough');
  delete before(planted, 'seethrough').status; save(dir, planted);
  expect(unlinked(dir, 'refusals')).toEqual([[CODE, path]]);
  before(planted, 'assemble').status = 'done'; before(planted, 'seethrough').status = 'in-progress'; save(dir, planted);
  // assemble has no history, so its chain is not recorded and the snapshot is not judged.
  expect(unlinked(dir, 'refusals')).toEqual([]);
  before(planted, 'seethrough').status = 'finished'; save(dir, planted);
  expect(unlinked(dir, 'refusals')).toEqual([]);
  expect(findings(dir, 'refusals').map(([code]) => code)).toContain('REOPEN_MALFORMED');
});

test('a step whose history is malformed is skipped; its shape error keeps its own code', () => {
  const dir = parts(NOW);
  status(dir, 'seethrough', 'in-progress');
  reopen(dir, 'parts');
  const planted = read(dir);
  before(planted, 'seethrough').status = 'done';
  delete obj(arr(obj(arr(obj(planted.plan).steps).find(raw => obj(raw).id === 'seethrough')).status_history)[0]).checkpoint_required;
  save(dir, planted);
  expect(unlinked(dir, 'refusals')).toEqual([]);
  expect(findings(dir, 'refusals').map(([code]) => code)).toContain('STEP_STATUS_TRANSITION');
});

// The reopen writer copies the current status, so a hand-set status reaches steps_before.
test('the reopen writer refuses to carry a hand-set status dated from the cutoff into steps_before', () => {
  const dir = parts(NOW);
  status(dir, 'seethrough', 'in-progress');
  handSet(dir, 'seethrough', 'at-checkpoint');
  expect(unlinked(dir, 'refusals')).toEqual([['STEP_STATUS_UNLINKED', 'plan.steps[seethrough].status']]);
  refused(dir, CODE, () => reopen(dir, 'parts'));
  handSet(dir, 'seethrough', 'in-progress');
  reopen(dir, 'parts');
  expect(findings(dir, 'refusals')).toEqual([]);
});

test('a legacy hand-set status still reopens, and the copied mismatch stays a WARN', () => {
  const dir = parts(SINCE - 3_600_000);
  at(SINCE - 1000); stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent']);
  handSet(dir, 'seethrough', 'at-checkpoint');
  expect(unlinked(dir, 'warnings')).toEqual([['STEP_STATUS_UNLINKED', 'plan.steps[seethrough].status']]);
  at(NOW); reopen(dir, 'parts');
  expect(before(read(dir), 'seethrough').status).toBe('at-checkpoint');
  expect(unlinked(dir, 'refusals')).toEqual([]);
  expect(unlinked(dir, 'warnings')).toEqual([[CODE, beforePath(read(dir), 'seethrough')]]);
  status(dir, 'seethrough', 'in-progress');
  expect(unlinked(dir, 'refusals')).toEqual([]);
});

test.each([[-1000, 'warnings'], [0, 'refusals'], [1000, 'refusals']] as const)(
  'a mismatch whose latest preceding event is %ims from PROGRESS_HISTORY_SINCE lands in %s', (offset, list) => {
    const dir = parts(SINCE - 3_600_000);
    at(SINCE + offset); stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent']);
    at(NOW); reopen(dir, 'parts');
    const planted = read(dir); before(planted, 'seethrough').status = 'done'; save(dir, planted);
    const other = list === 'refusals' ? 'warnings' : 'refusals';
    expect(unlinked(dir, list)).toEqual([[CODE, beforePath(planted, 'seethrough')]]);
    expect(unlinked(dir, other)).toEqual([]);
  });
