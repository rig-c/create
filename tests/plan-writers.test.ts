import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { isObject } from '../src/check.ts';
import { closeCreateJob, openCreateJob, openRecordPublication } from '../src/job-host.ts';
import { JOB_BINDING_FILE, jobHash, jobHostStateRoot, jobPrivateRoot, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity, readRecordPublished } from '../src/job-publication.ts';
import { checkpointRequired, collectCheckpointWithdrawals, checkReplacedSignoffs, collectPlanReplaced } from '../src/plan-history.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand as rawSignoff } from '../src/signoff.ts';
import { STAGE_ORDER_SPEC } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { amendCommand, checkDirections, checkProject, directionCommand, planCommand, signoffCommand, testClock } from './clock.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { directionFixture } from './direction-fixture.ts';
import { plantLegacyReopen, arr, fixture, obj, retainSignoffs, step, waypoint } from './fixtures.ts';
import { cli, gitEnv, tempDir } from './helpers.ts';
import { seedStoredVersionSignoff } from './historical-review-fixture.ts';
import { seedRetainedDirectionPost } from './numbered-seed.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const fields = ['--phase', 'post', '--order', '1', '--does', 'Frame the approved rig.', '--produces', 'A camera track.',
  '--rests-on', 'bones', '--bar', 'The frame retains every approved part.', '--checkpoint-proposed', 'false'];
const codes = (dir: string): string[] => checkProject(dir).refusals.map(finding => finding.code);
function draft(): string {
  testClock.set('2026-11-20T00:00:00Z');
  return fixture(project => {
    waypoint(project, 'bones').guide = { delegated: false, by: 'user', at: '2026-11-10T00:00:00Z', verbatim: 'Use the approved rig.', value: 'Use the approved rig.' };
  }, 'project.json');
}
function write(dir: string, action: string, id = 'camera', flags: string[] = []): void {
  expect(planCommand([action, id, dir, '--by', 'agent', ...flags]).exit).toBe(0);
}
function unchanged(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Refusal);
  expect((error as Refusal).code).toBe(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
function reopen(dir: string, stage = 'plan-approved'): void {
  const words = join(dir, 'words.txt');
  writeFileSync(words, 'Reopen the plan for a new draft.');
  plantLegacyReopen(dir, stage, { by: 'user', wordsFile: words });
}
function retained(record: JsonObject, at = '2026-11-20T00:00:00Z'): JsonObject {
  return { step: structuredClone(record), sha256: stepHash(record), action: 'revised', at, by: 'agent' };
}
afterEach(() => testClock.reset());

test('add, partial revise and remove preserve previous full steps, hashes and write order', () => {
  const dir = draft();
  const baseline = checkProject(dir).refusals;
  write(dir, 'add', 'camera', fields);
  const first = read(dir);
  expect(obj(first.plan)).toMatchObject({ drafted_by: null, drafted_at: null });
  expect(obj(first.plan).replaced).toBeUndefined();
  expect(step(first, 'camera')).toMatchObject({ phase: 'post', order: 1, rests_on: ['bones'], checkpoint_proposed: false, checkpoint: null, status: 'pending' });
  step(first, 'camera')['x-note'] = { text: 'Retain the whole definition.', values: [1, 2] };
  save(dir, first);
  testClock.set('2026-11-20T00:00:01Z');
  write(dir, 'revise', 'camera', ['--does', 'Use the revised framing.', '--checkpoint-proposed', 'true']);
  const second = read(dir);
  expect(obj(arr(obj(second.plan).replaced)[0])).toEqual({
    ...retained(step(first, 'camera'), '2026-11-20T00:00:01.000Z'), reason: 'Revise the authored step fields.',
  });
  expect(step(second, 'camera')['x-note']).toEqual(step(first, 'camera')['x-note']);
  expect(step(second, 'camera').checkpoint).toBeNull();
  expect(step(second, 'camera').checkpoint_proposed).toBe(true);
  testClock.set('2026-11-20T00:00:02Z');
  write(dir, 'remove');
  const third = read(dir);
  expect(obj(third.plan).steps).toEqual([]);
  expect(arr(obj(third.plan).replaced)).toEqual([
    ...arr(obj(second.plan).replaced), { ...retained(step(second, 'camera'), '2026-11-20T00:00:02.000Z'), action: 'removed' },
  ]);
  expect(obj(third.plan)).toMatchObject({ drafted_by: null, drafted_at: null });
  expect(checkProject(dir).refusals).toEqual(baseline);
});

test('a second revision appends under the same id, then a clock reversal is refused byte-identically', () => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  write(dir, 'revise', 'camera', ['--bar', 'First revised bar.']);
  testClock.set('2026-11-20T00:00:01Z');
  write(dir, 'revise', 'camera', ['--bar', 'Second revised bar.']);
  expect(arr(obj(read(dir).plan).replaced).map(entry => obj(obj(entry).step).id)).toEqual(['camera', 'camera']);
  testClock.set('2026-11-19T00:00:00Z');
  unchanged(dir, 'PLAN_REPLACED_ORDER', () => write(dir, 'remove'));
});

test('pre-existing refusals remain allowed, but a new code/path pair is refused without a write', () => {
  const dir = draft();
  expect(checkProject(dir).refusals.length).toBeGreaterThan(0);
  unchanged(dir, 'STEP_BASIS_UNKNOWN', () => write(dir, 'add', 'camera', fields.map(value => value === 'bones' ? 'unknown' : value)));
  write(dir, 'add', 'camera', fields);
  unchanged(dir, 'PLAN_OPTION_INVALID', () => {
    planCommand(['revise', 'camera', dir, '--by', 'agent', '--rests-on', '']);
  });
});

test('the refusal delta counts duplicate findings at the same code and path', () => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  const project = read(dir); step(project, 'camera').rests_on = ['unknown']; save(dir, project);
  expect(checkProject(dir).refusals.filter(f => f.code === 'STEP_BASIS_UNKNOWN' && f.path === 'plan.steps[camera]')).toHaveLength(1);
  unchanged(dir, 'STEP_BASIS_UNKNOWN', () => write(dir, 'revise', 'camera', ['--rests-on', 'unknown,other-unknown']));
});

test('#981 a live signed revise records, including legacy approvals without hashes; removal meets the structural waypoint rule', () => {
  testClock.set('2026-11-20T00:00:00Z');
  const dir = fixture(project => {
    step(project, 'bones').status = 'pending';
    for (const signature of arr(project.signoffs)) delete obj(signature).step_hashes;
  });
  write(dir, 'revise', 'bones', ['--bar', 'Revised bar.']);
  expect(obj(arr(obj(read(dir).plan).replaced).at(-1)).action).toBe('revised');
  testClock.set('2026-11-20T00:00:01Z');
  unchanged(dir, 'STEP_MISSING_FOR_WAYPOINT', () => write(dir, 'remove', 'bones'));
});

test('the exact reopen cutoff releases a pending signed step and retained hashes still resolve', () => {
  testClock.set('2026-11-20T00:00:00Z');
  const dir = fixture(project => { step(project, 'bones').status = 'pending'; });
  reopen(dir);
  const before = read(dir);
  write(dir, 'revise', 'bones', ['--bar', 'A new measurable rig bar.']);
  const next = read(dir);
  expect(obj(arr(obj(next.plan).replaced)[0]).step).toEqual(step(before, 'bones'));
  expect(next.signoffs).toEqual(before.signoffs);
  expect(codes(dir)).toEqual([]);
  const historical = arr(next.signoffs).find(signature => isHashFor(signature, 'bones'))!;
  obj(obj(historical).step_hashes).bones = '0'.repeat(64);
  save(dir, next);
  expect(codes(dir)).toContain('PLAN_REPLACED_SIGNOFF');
});

function isHashFor(value: Json, id: string): boolean {
  return isObject(value) && isObject(value.step_hashes) && typeof value.step_hashes[id] === 'string';
}

test('#981 a currently done step can be revised and the history retains its status', () => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  const project = read(dir); step(project, 'camera').status = 'done'; save(dir, project);
  write(dir, 'revise', 'camera', ['--bar', 'Changed.']);
  expect(obj(obj(arr(obj(read(dir).plan).replaced)[0]).step).status).toBe('done');
});

test.each(['legacy-example-project.json', 'example-numbered/example-project.json'])('post re-plan after post-interview reopen preserves both plan dates in %s', template => {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(project => {
    step(project, 'camera').status = 'pending';
    step(project, 'camera').status_history = [];
    if (obj(project.plan).rigging_drafted_at === undefined) obj(project.plan).rigging_drafted_at = obj(project.plan).drafted_at;
  }, template);
  reopen(dir, 'post-interview');
  const expected = read(dir);
  const plan = obj(expected.plan);
  const camera = step(expected, 'camera');
  const at = testClock.iso();
  const bar = 'Changed.';
  plan.replaced = [...(plan.replaced === undefined ? [] : arr(plan.replaced)),
    { ...retained(camera, at), reason: 'Revise the authored step fields.' }];
  Object.assign(camera, { bar, drafted_at: at });
  const baseline = checkProject(dir).refusals;
  write(dir, 'revise', 'camera', ['--bar', bar]);
  expect(read(dir)).toEqual(expected);
  expect(checkProject(dir).refusals).toEqual(baseline);
  expect(baseline).toEqual([]);
});

test.each([
  { newOrder: false, id: 'bones', phase: 'rig', ownership: 'parts' },
  { newOrder: true, id: 'assemble', phase: 'rig', ownership: 'parts' },
  { newOrder: true, id: 'bones', phase: 'rig', ownership: 'rigging' },
  { newOrder: true, id: 'camera', phase: 'post', ownership: 'post' },
])('add, revise and remove date their $ownership owner for $id', ({ newOrder, id, phase, ownership }) => {
  const dir = draft(); const project = read(dir);
  const partsDate = '2026-11-10T00:00:00.000Z';
  const riggingDate = '2026-11-11T00:00:00.000Z';
  Object.assign(obj(project.plan), { drafted_by: 'earlier drafter', drafted_at: partsDate, rigging_drafted_at: riggingDate });
  if (newOrder) obj(project.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: partsDate };
  save(dir, project);
  const actions = ['add', 'revise', 'remove'];
  for (const [index, action] of actions.entries()) {
    const at = `2026-11-20T00:00:0${index}.000Z`;
    testClock.set(at);
    write(dir, action, id, action === 'add' ? fields.map(value => value === 'post' ? phase : value)
      : action === 'revise' ? ['--bar', 'Revised owner bar.'] : []);
    expect(obj(read(dir).plan)).toMatchObject({
      drafted_by: ownership === 'parts' ? 'agent' : 'earlier drafter',
      drafted_at: ownership === 'parts' ? at : partsDate,
      rigging_drafted_at: ownership === 'rigging' ? at : riggingDate,
    });
    expect(obj(read(dir).plan).rigging_drafted_by).toBeUndefined();
    expect(obj(read(dir).plan).post_drafted_at).toBeUndefined();
  }
});

test.each([
  { newOrder: true, id: 'assemble', from: 'rig', to: 'post', parts: true, rigging: false },
  { newOrder: true, id: 'assemble', from: 'post', to: 'rig', parts: true, rigging: false },
  { newOrder: true, id: 'bones', from: 'rig', to: 'post', parts: false, rigging: true },
  { newOrder: true, id: 'bones', from: 'post', to: 'rig', parts: false, rigging: true },
  { newOrder: false, id: 'bones', from: 'rig', to: 'post', parts: true, rigging: false },
  { newOrder: false, id: 'bones', from: 'post', to: 'rig', parts: true, rigging: false },
])('phase revision from $from to $to dates both ownerships for $id', ({ newOrder, id, from, to, parts, rigging }) => {
  const dir = draft(); const project = read(dir);
  if (newOrder) obj(project.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-10T00:00:00Z' };
  save(dir, project);
  write(dir, 'add', id, fields.map(value => value === 'post' ? from : value));
  const before = obj(read(dir).plan);
  const at = '2026-11-20T00:00:01.000Z'; testClock.set(at);
  write(dir, 'revise', id, ['--phase', to]);
  const after = obj(read(dir).plan);
  expect(after.drafted_at).toEqual(parts ? at : before.drafted_at);
  expect(after.drafted_by).toEqual(parts ? 'agent' : before.drafted_by);
  expect(after.rigging_drafted_at).toEqual(rigging ? at : before.rigging_drafted_at);
  expect(after.rigging_drafted_by).toBeUndefined();
  expect(after.post_drafted_at).toBeUndefined();
});

test('#981 done work can be removed with checkpoint history and added again under its id', () => {
  testClock.set('2026-11-20T00:00:00Z');
  const dir = fixture();
  reopen(dir);
  const before = read(dir);
  write(dir, 'remove', 'camera');
  const next = read(dir);
  expect(obj(arr(obj(next.plan).replaced)[0]).step).toEqual(step(before, 'camera'));
  expect(codes(dir)).toEqual([]);
  write(dir, 'add', 'camera', fields);
  expect(step(read(dir), 'camera').status).toBe('pending');
});

function rigReplacement(): { dir: string; original: JsonObject; removedStep: JsonObject; priorHistory: Json[]; flags: string[] } {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const project = read(dir);
  const original = step(project, 'seethrough');
  const priorHistory = arr(obj(project.plan).replaced);
  reopen(dir);
  const removedStep = step(read(dir), 'seethrough');
  write(dir, 'remove', 'seethrough');
  const flags = ['--phase', 'rig', '--order', String(original.order), '--does', 'Rebuild the approved parts.',
    '--produces', 'Replacement parts.', '--rests-on', 'seethrough', '--bar', 'The replacement meets the owner answer.', '--checkpoint-proposed', 'false'];
  return { dir, original, removedStep, priorHistory, flags };
}

test('a removed done rig step accepts its waypoint id after a later plan-approved reopen and keeps full history', () => {
  const { dir, removedStep, priorHistory, flags } = rigReplacement();
  const before = read(dir);
  const history = arr(obj(before.plan).replaced);
  expect(priorHistory.length).toBeGreaterThan(0);
  expect(history.slice(0, -1)).toEqual(priorHistory);
  const removal = obj(history.at(-1));
  expect(removal).toEqual({ ...retained(removedStep, testClock.iso()), action: 'removed' });
  unchanged(dir, 'STEP_NOT_A_WAYPOINT', () => write(dir, 'add', 'seethrough-raw', flags));
  write(dir, 'add', 'seethrough', flags);
  const after = read(dir);
  expect(arr(obj(after.plan).steps).filter(value => obj(value).id === 'seethrough')).toHaveLength(1);
  expect(step(after, 'seethrough')).toMatchObject({ status: 'pending', checkpoint: null });
  expect(step(after, 'seethrough').status_history).toBeUndefined();
  expect(obj(after.plan).replaced).toEqual(history);
  expect(obj(removal.step).status_history).toBeDefined();
  expect(codes(dir)).toEqual([]);
  testClock.set(EXAMPLE_NOW + 1_000);
  write(dir, 'revise', 'seethrough', ['--bar', 'A refined replacement bar.']);
  expect(step(read(dir), 'seethrough').status).toBe('pending');
  testClock.set(EXAMPLE_NOW + 2_000);
  write(dir, 'remove', 'seethrough');
  testClock.set(EXAMPLE_NOW + 3_000);
  write(dir, 'add', 'seethrough', flags);
  expect(codes(dir)).toEqual([]);
});

test('#674 a completed step is replaced under the same id after an amendment and retains its signed history', () => {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const before = read(dir);
  const original = step(before, 'seethrough');
  expect(original.status).toBe('done');

  writeFileSync(join(dir, 'changed-input.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  const quote = join(dir, 'amend.txt');
  writeFileSync(quote, 'Redo the synthetic separation with this updated input.\n');
  expect(amendCommand(['plan-approved', dir, '--kind', 'part', '--target', 'seethrough',
    '--change', 'changed-input.svg', '--by', 'user', '--verbatim-file', quote]).exit).toBe(0);
  write(dir, 'remove', 'seethrough');
  const archived = obj(arr(obj(read(dir).plan).replaced).at(-1));
  const flags = ['--phase', 'rig', '--order', String(original.order), '--does', 'Rebuild the approved parts.',
    '--produces', 'Replacement parts.', '--rests-on', 'seethrough', '--bar', 'The replacement meets the owner answer.', '--checkpoint-proposed', 'false'];
  write(dir, 'add', 'seethrough', flags);

  const after = read(dir);
  expect(after.stage).toBe(before.stage!);
  expect(after.reopens).toEqual(before.reopens);
  expect(after.signoffs).toEqual(before.signoffs);
  expect(step(after, 'seethrough')).toMatchObject({ status: 'pending', does: 'Rebuild the approved parts.' });
  expect(obj(arr(obj(after.plan).replaced).at(-1))).toEqual(archived);
  expect(archived.sha256).toBe(stepHash(original));
  expect(obj(arr(obj(archived.step).status_history).at(-1)).status).toBe('done');
  expect(codes(dir)).toEqual([]);
});

function postReplacement(stage = 'rig-review'): { dir: string; original: JsonObject; removedStep: JsonObject; priorHistory: Json[]; flags: string[] } {
  testClock.set(EXAMPLE_NOW);
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const project = read(dir);
  const original = step(project, 'camera');
  const priorHistory = arr(obj(project.plan).replaced);
  reopen(dir, stage);
  const removedStep = step(read(dir), 'camera');
  write(dir, 'remove', 'camera');
  const flags = ['--phase', 'post', '--order', String(original.order), '--does', 'Frame the second take.',
    '--produces', 'The second take camera track.', '--rests-on', 'camera_depth', '--bar', 'The second take push-in closes cleanly.', '--checkpoint-proposed', 'false'];
  return { dir, original, removedStep, priorHistory, flags };
}

test.each(['rig-review', 'post-interview'])('a removed done post step accepts its id after a later %s reopen and retains the first take record in plan.replaced', stage => {
  const { dir, original, removedStep, priorHistory, flags } = postReplacement(stage);
  const before = read(dir);
  const history = arr(obj(before.plan).replaced);
  expect(priorHistory.length).toBeGreaterThan(0);
  expect(history.slice(0, -1)).toEqual(priorHistory);
  const removal = obj(history.at(-1));
  expect(removal).toEqual({ ...retained(removedStep, testClock.iso()), action: 'removed' });
  write(dir, 'add', 'camera', flags);
  const after = read(dir);
  expect(arr(obj(after.plan).steps).filter(value => obj(value).id === 'camera')).toHaveLength(1);
  expect(step(after, 'camera')).toMatchObject({ does: 'Frame the second take.', bar: 'The second take push-in closes cleanly.', status: 'pending', checkpoint: null });
  expect(step(after, 'camera').status_history).toBeUndefined();
  expect(obj(after.plan).replaced).toEqual(history);
  const archived = obj(removal.step);
  expect(archived.does).toBe(original.does);
  expect(archived.bar).toBe(original.bar);
  expect(obj(arr(archived.status_history).at(-1)).status).toBe('done');
  expect(codes(dir)).toEqual([]);
});

test('after a cycle and rig-review reopen, replacing camera lets post-interview signoff and direction write cite the new step while retaining take 1 in plan.replaced', () => {
  const dir = join(tempDir(), 'second-take');
  const f = directionFixture(dir);
  testClock.set('2026-11-04T09:01:00Z');
  expect(seedRetainedDirectionPost(['write', '2', dir, '--file', 'evidence/input.json', '--rig', '1'], testClock.now()).exit).toBe(0);
  const take1 = f.load();
  for (const id of ['camera', 'timing']) {
    step(take1, id).status = 'done';
    step(take1, id).status_history = [{ from_status: 'in-progress', status: 'done', by: 'agent', at: '2026-11-04T09:01:00Z', checkpoint_required: false, signoff: null }];
  }
  take1.signoffs = [{ stage: 'parts-review', checkpoint: null, by: 'user', at: '2026-11-04T08:00:00Z', verbatim: 'Accept parts.' }, ...arr(take1.signoffs)];
  obj(arr(take1.versions)[1]).verdicts = [{ review: 'direction-review', verdict: 'accepted', by: 'user', at: '2026-11-04T09:02:00Z', verbatim: 'Accept take 1.' }];
  f.save(take1);
  testClock.set('2026-11-04T09:02:00Z');
  expect(() => signoffCommand(['direction-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'approval.txt')]))
    .toThrow(expect.objectContaining({ code: 'NUMBERED_WRITER_REMOVED' }));
  seedStoredVersionSignoff(dir, 'direction-review', 2, {
    by: 'user',
    at: '2026-11-04T09:02:00Z',
    verbatim: readFileSync(join(dir, 'approval.txt'), 'utf8'),
  });
  const take1Camera = structuredClone(step(f.load(), 'camera'));
  expect(take1Camera.does).toBe('Author direction');
  expect(take1Camera.status).toBe('done');

  testClock.set('2026-11-04T09:10:00Z');
  reopen(dir, 'rig-review');
  write(dir, 'remove', 'camera');
  const take2Flags = ['--phase', 'post', '--order', '1', '--does', 'Author second-take camera framing',
    '--produces', 'second-take direction document', '--rests-on', 'camera_depth', '--bar', 'second-take camera keys validate', '--checkpoint-proposed', 'false'];
  write(dir, 'add', 'camera', take2Flags);

  const afterAdd = f.load();
  expect(step(afterAdd, 'camera').does).toBe('Author second-take camera framing');
  expect(step(afterAdd, 'camera').status).toBe('pending');
  expect(arr(obj(afterAdd.plan).replaced)).toHaveLength(1);
  const archived = obj(obj(arr(obj(afterAdd.plan).replaced)[0]).step);
  expect(archived.does).toBe('Author direction');
  expect(obj(arr(archived.status_history).at(-1)).status).toBe('done');
  expect(arr(obj(arr(afterAdd.reopens)[0]).steps_before)).toContainEqual({ id: 'camera', status: 'done' });

  obj(arr(afterAdd.versions)[0]).at = '2026-11-04T09:11:00Z';
  afterAdd.signoffs = [...arr(afterAdd.signoffs), { stage: 'rig-review', checkpoint: null, by: 'user', at: '2026-11-04T09:11:00Z', verbatim: 'Accept the synthetic rig' }];
  f.save(afterAdd);

  testClock.set('2026-11-04T09:12:00Z');
  seedRetainedDirectionPost(['write', '3', dir, '--file', 'evidence/input.json', '--rig', '1'], testClock.now());
  const unapprovedCtx = { dir, project: f.load(), refusals: [] as import('../src/check.ts').Finding[], warnings: [] as import('../src/check.ts').Finding[] };
  checkDirections(unapprovedCtx, undefined, true);
  expect(unapprovedCtx.refusals.map(r => r.code)).toContain('DIRECTION_CITATION');
  const signed = JSON.parse(signoffCommand(['post-interview', dir, '--by', 'user', '--steps', 'camera,timing', '--verbatim-file', join(dir, 'approval.txt'), '--json']).stdout) as JsonObject;
  expect(obj(signed.step_hashes).camera).toBe(stepHash(step(f.load(), 'camera')));
  expect(obj(signed.step_hashes).camera).not.toBe(stepHash(take1Camera));
  const approvedCtx = { dir, project: f.load(), refusals: [] as import('../src/check.ts').Finding[], warnings: [] as import('../src/check.ts').Finding[] };
  checkDirections(approvedCtx);
  expect(approvedCtx.refusals).toEqual([]);
  expect(obj(obj(arr(obj(f.load().plan).replaced)[0]).step).does).toBe('Author direction');
});

test('replacement hash resolution preserves latest-covering approval and reopen equality', () => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  const project = read(dir);
  const previous = structuredClone(step(project, 'camera'));
  step(project, 'camera').bar = 'The revised bar.';
  const entry = retained(previous);
  const signature = { stage: 'post-interview', checkpoint: null, at: '2026-11-19T00:00:00Z', by: 'user', verbatim: 'Approve.', steps: ['camera'], step_hashes: { camera: stepHash(previous) } };
  project.signoffs = [signature, { ...signature, at: '2026-11-20T00:00:00Z', step_hashes: { camera: stepHash(step(project, 'camera')) } }];
  let findings: import('../src/check.ts').Finding[] = [];
  checkReplacedSignoffs(project, [entry], findings);
  expect(findings).toEqual([]);
  project.signoffs = [{ ...signature, step_hashes: { camera: '0'.repeat(64) } }];
  checkReplacedSignoffs(project, [entry], findings);
  expect(findings.map(f => f.code)).toEqual(['PLAN_REPLACED_SIGNOFF']);
  // #981: a live signature resolves to its retained definition; no amendment is needed to replan.
  project.signoffs = [signature];
  findings = [];
  checkReplacedSignoffs(project, [entry], findings);
  expect(findings).toEqual([]);
  project.reopens = [{ stage: 'post-interview', from_stage: 'post', at: signature.at, by: 'user', verbatim: 'Reopen.', steps_before: [],
    source: 'owner chat, relayed', said_at: signature.at, relayed_by: 'synthetic-relay' }];
  findings = [];
  checkReplacedSignoffs(project, [entry], findings);
  expect(findings).toEqual([]);
  obj(arr(project.signoffs)[0]).steps = null;
  obj(arr(project.signoffs)[0]).step_hashes = {};
  checkReplacedSignoffs(project, [entry], findings);
  expect(findings).toEqual([]);
});

test.each([
  ['PLAN_REPLACED_INVALID', null],
  ['PLAN_REPLACED_INVALID', [null]],
  ['PLAN_REPLACED_INVALID', [{ step: { id: 'camera', phase: 'post' }, by: '', at: 'bad' }]],
] as [string, Json][])('history shape reports %s through checkProject', (code, value) => {
  const dir = draft(); const project = read(dir); obj(project.plan).replaced = value; save(dir, project);
  expect(codes(dir)).toContain(code);
});

test.each([
  ['PLAN_REPLACED_HASH', (entry: JsonObject) => { entry.sha256 = '0'.repeat(64); }],
  ['PLAN_REPLACED_ACTION', (entry: JsonObject) => { entry.action = 'added'; }],
  ['PLAN_REPLACED_INVALID', (entry: JsonObject) => { entry.at = '2026-11-20'; }],
] as [string, (entry: JsonObject) => void][])('history validates %s through its collector and checkProject', (code, edit) => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  const project = read(dir); const entry = retained(step(project, 'camera')); edit(entry);
  const findings: import('../src/check.ts').Finding[] = [];
  collectPlanReplaced({ plan: { replaced: [entry] } }, findings);
  expect(findings.map(f => f.code)).toContain(code);
  obj(project.plan).replaced = [entry]; save(dir, project);
  expect(codes(dir)).toContain(code);
});

test('history has nondecreasing dates and unique id/at identities, while different ids may share a date', () => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  const first = retained(step(read(dir), 'camera'));
  const findings: import('../src/check.ts').Finding[] = [];
  collectPlanReplaced({ plan: { replaced: [first, first] } }, findings);
  expect(findings.map(f => f.code)).toEqual(['PLAN_REPLACED_DUPLICATE']);
  const second = retained({ ...step(read(dir), 'camera'), id: 'timing' });
  expect(collectPlanReplaced({ plan: { replaced: [first, second] } }, [])).toHaveLength(2);
  unchanged(dir, 'PLAN_STEP_INVALID', () => write(dir, 'add', 'camera', fields));
  write(dir, 'revise', 'camera', ['--bar', 'New bar.']);
  unchanged(dir, 'PLAN_REPLACED_DUPLICATE', () => write(dir, 'remove'));
});

test.each([
  ['revise', 'missing', '--by', 'agent', '--bar', 'Changed.'],
  ['add', 'camera', '--by', 'agent'],
  ['remove', 'camera', '--by', 'agent', '--bar', 'Changed.'],
  ['add', 'camera', '--by', 'agent', ...fields, '--phase', 'post'],
  ['add', 'camera', '--by', 'agent', ...fields.map(value => value === 'false' ? 'yes' : value)],
])('invalid %s command leaves bytes unchanged', (...args: string[]) => {
  const dir = draft();
  unchanged(dir, args[0] === 'revise' ? 'PLAN_STEP_INVALID' : 'PLAN_OPTION_INVALID', () => planCommand([...args, dir]));
});

test('normal CLI entry adds, revises and removes, returning JSON and named usage errors', () => {
  const dir = draft(); const env = gitEnv();
  const added = cli(['plan', 'add', 'camera', dir, '--by', 'agent', ...fields, '--json'], dir, env);
  expect(added.code).toBe(0); expect(added.stderr).toBe('');
  expect(obj(JSON.parse(added.stdout) as JsonObject).drafted_by).toBeNull();
  testClock.set('2026-11-20T00:00:01Z');
  expect(cli(['plan', 'revise', 'camera', dir, '--by', 'agent', '--bar', 'Revised through CLI.'], dir, env).code).toBe(0);
  testClock.set('2026-11-20T00:00:02Z');
  expect(cli(['plan', 'remove', 'camera', dir, '--by', 'agent'], dir, env).code).toBe(0);
  const before = readFileSync(join(dir, 'project.json'));
  const invalid = cli(['plan', 'add', 'camera', dir], dir, env);
  expect(invalid.code).toBe(2); expect(invalid.stderr).toContain('PLAN_OPTION_INVALID');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(cli(['--help'], dir, env).stdout).toContain('plan add|revise|remove');
});

test('competing plan writes refuse byte-identically and successful writes release their lock and temporary file', () => {
  const dir = draft();
  const lock = join(dir, '.plan.lock'); writeFileSync(lock, 'An active plan writer owns this lock.');
  unchanged(dir, 'PLAN_WRITE_CONFLICT', () => write(dir, 'add', 'camera', fields));
  expect(readFileSync(lock, 'utf8')).toBe('An active plan writer owns this lock.');
  rmSync(lock);
  write(dir, 'add', 'camera', fields);
  unchanged(dir, 'STEP_BASIS_UNKNOWN', () => write(dir, 'revise', 'camera', ['--rests-on', 'unknown']));
  expect(readdirSync(dir).filter(name => name.startsWith('.plan'))).toEqual([]);
});

test('the plan writer is refused on a record whose stage check stopped early', () => {
  const dir = draft();
  const project = read(dir); project.stage = 'no-such-stage'; save(dir, project);
  expect(codes(dir)).toEqual(['STAGE_UNKNOWN']);
  unchanged(dir, 'STAGE_UNKNOWN', () => planCommand(['add', 'camera', dir, '--by', 'agent', ...fields]));
});


function withdrawalProject(): JsonObject {
  const original = { id: 'mesh-step', phase: 'rig', status: 'at-checkpoint', does: 'Inspect synthetic geometry.',
    checkpoint: { delegated: false, value: true, by: 'user', at: '2026-11-10T00:00:00Z', verbatim: 'Require inspection.' } };
  return { plan: { steps: [original], checkpoint_withdrawals: [{ schema: 'rig-create/checkpoint-withdrawal@1',
    step: structuredClone(original), sha256: stepHash(original), generation: 0, by: 'operator',
    at: '2026-11-11T00:00:00Z', reason: 'Retire the gate.', verbatim: 'Keep its evidence.' }] } };
}

test('withdrawal binds the exact signed checkpoint and generation without retroactive history exemptions', () => {
  const project = withdrawalProject(); const plan = obj(project.plan); const original = obj(arr(plan.steps)[0]);
  const entries = collectCheckpointWithdrawals(project, [], Date.parse('2026-11-20T00:00:00Z'));
  expect(entries).toHaveLength(1); expect(checkpointRequired(project, original)).toBe(false);
  plan.replaced = [{ step: structuredClone(original), sha256: stepHash(original), action: 'revised', by: 'operator', at: '2026-11-12T00:00:00Z' }];
  expect(checkpointRequired(project, original)).toBe(true);
  expect(collectCheckpointWithdrawals(project, [])).toHaveLength(1);
  original.bar = 'A new signed bar.';
  expect(checkpointRequired(project, original)).toBe(true);
  obj(original.checkpoint).at = '2026-11-13T00:00:00Z';
  expect(checkpointRequired(project, original)).toBe(true);
});

test.each([
  (entry: JsonObject) => { entry.sha256 = '0'.repeat(64); },
  (entry: JsonObject) => { entry.reason = ''; },
  (entry: JsonObject) => { entry.by = ''; },
  (entry: JsonObject) => { entry.verbatim = ''; },
  (entry: JsonObject) => { entry.generation = 1; },
  (entry: JsonObject) => { entry.at = '2026-11-09T00:00:00Z'; },
  (entry: JsonObject) => { entry.at = '2026-12-01T00:00:00Z'; },
  (entry: JsonObject) => { entry.extra = 'unrecognized'; },
])('malformed withdrawal grants no effective exemption', edit => {
  const project = withdrawalProject(); edit(obj(arr(obj(project.plan).checkpoint_withdrawals)[0]));
  const findings: import('../src/check.ts').Finding[] = [];
  expect(collectCheckpointWithdrawals(project, findings, Date.parse('2026-11-20T00:00:00Z'))).toEqual([]);
  expect(findings.map(f => f.code)).toEqual(['CHECKPOINT_WITHDRAWAL_INVALID']);
  expect(checkpointRequired(project, obj(arr(obj(project.plan).steps)[0]), Date.parse('2026-11-20T00:00:00Z'))).toBe(true);
});

function postInterviewDraft(): string {
  testClock.set(EXAMPLE_NOW);
  return realpathSync(fixture(project => {
    project.stage = 'post-interview';
    retainSignoffs(project, signature => !['post-interview', 'direction-review'].includes(String(obj(signature).stage)));
    project.advances = arr(project.advances).filter(value => !['post', 'direction-review', 'accepted'].includes(String(obj(value).stage)));
    project.versions = arr(project.versions).filter(value => obj(value).kind === 'rig');
    project.scenes = [];
    delete project.direction_contract;
    obj(project.plan).steps = arr(obj(project.plan).steps).filter(value => obj(value).phase === 'rig');
  }, 'example-numbered/example-project.json'));
}

test('plan add and revise --order stable-sort plan.steps[] by order, keeping ties in array order, while revise without --order and remove do not re-sort', () => {
  const dir = draft();
  const base = ['--phase', 'post', '--does', 'Frame the approved rig.', '--produces', 'A camera track.',
    '--rests-on', 'bones', '--bar', 'The frame retains every approved part.', '--checkpoint-proposed', 'false'];
  write(dir, 'add', 'step-a', ['--order', '2', ...base]);
  write(dir, 'add', 'step-b', ['--order', '1', ...base]);
  write(dir, 'add', 'step-c', ['--order', '2', ...base]);
  write(dir, 'add', 'step-d', ['--order', '3', ...base]);
  expect(arr(obj(read(dir).plan).steps).map(s => [obj(s).id, obj(s).order])).toEqual([
    ['step-b', 1], ['step-a', 2], ['step-c', 2], ['step-d', 3],
  ]);
  testClock.set('2026-11-20T00:00:01Z');
  write(dir, 'revise', 'step-d', ['--order', '0']);
  expect(arr(obj(read(dir).plan).steps).map(s => [obj(s).id, obj(s).order])).toEqual([
    ['step-d', 0], ['step-b', 1], ['step-a', 2], ['step-c', 2],
  ]);
  testClock.set('2026-11-20T00:00:02Z');
  write(dir, 'revise', 'step-c', ['--order', '1']);
  expect(arr(obj(read(dir).plan).steps).map(s => [obj(s).id, obj(s).order])).toEqual([
    ['step-d', 0], ['step-b', 1], ['step-c', 1], ['step-a', 2],
  ]);
  // An out-of-order array is not re-sorted by revise without --order or remove.
  const outOfOrder = read(dir);
  arr(obj(outOfOrder.plan).steps).reverse();
  save(dir, outOfOrder);
  testClock.set('2026-11-20T00:00:03Z');
  write(dir, 'revise', 'step-b', ['--bar', 'Updated bar without order flag.']);
  expect(arr(obj(read(dir).plan).steps).map(s => obj(s).id)).toEqual(['step-a', 'step-c', 'step-b', 'step-d']);
  testClock.set('2026-11-20T00:00:04Z');
  write(dir, 'remove', 'step-c');
  expect(arr(obj(read(dir).plan).steps).map(s => obj(s).id)).toEqual(['step-a', 'step-b', 'step-d']);
});

test('after revise --order, the published plan text lists steps in plan order', async () => {
  const dir = postInterviewDraft();
  const base = ['--phase', 'post', '--produces', 'A synthetic post artifact.',
    '--rests-on', 'camera_depth', '--bar', 'The post artifact matches the guide.', '--checkpoint-proposed', 'false'];
  write(dir, 'add', 'camera', ['--order', '10', '--does', 'First post step.', ...base]);
  write(dir, 'add', 'timing', ['--order', '20', '--does', 'Second post step.', ...base]);
  write(dir, 'add', 'composition', ['--order', '30', '--does', 'Third post step.', ...base]);
  testClock.set(EXAMPLE_NOW + 1_000);
  write(dir, 'revise', 'composition', ['--order', '5']);
  const bytes = readFileSync(join(dir, 'project.json'));
  const recordPublished = readRecordPublished({
    root: dir,
    record: { path: 'project.json', sha256: jobHash(bytes) },
    result: { kind: 'plan' },
    phase: 'inventory',
  }, testClock.now());
  expect(recordPublished.plan.steps.filter(s => ['camera', 'timing', 'composition'].includes(s.id)).map(s => s.id))
    .toEqual(['composition', 'camera', 'timing']);
  const host = await openCreateJob(dir, { id: 'synthetic-owner', role: 'owner' }, testClock.now(), undefined, true);
  try {
    await openRecordPublication(dir, host, undefined, true, testClock.now());
    const pubId = host.session.status().publication!.publicationId;
    const entryBase = host.session.displayPublication(pubId).routes.entry;
    const response = await fetch(`${host.origin}${entryBase}api/review`);
    expect(response.status).toBe(200);
    const body = await response.json() as { planText: { schema: string; status: string; steps: { id: string; does?: string }[] } };
    expect(body.planText.schema).toBe('rig-review/job-plan-text@1');
    expect(body.planText.status).toBe('projected');
    expect(body.planText.steps.filter(s => ['camera', 'timing', 'composition'].includes(s.id)).map(s => s.id))
      .toEqual(['composition', 'camera', 'timing']);
  } finally {
    await closeCreateJob(dir);
    host.stop();
    rmSync(jobPrivateRoot(dir), { recursive: true, force: true });
    rmSync(jobHostStateRoot(dir), { recursive: true, force: true });
  }
}, 20_000);

function bindSyntheticReview(dir: string, jobId = 'synthetic-plan-order-job'): string {
  const project = read(dir);
  project.review_job = { jobId, origin: 'http://127.0.0.1:43124' };
  save(dir, project);
  const identity = currentJobIdentity({ root: dir, stateDir: 'unused-private-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, dir);
  writePrivateJson(join(dir, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId, origin: 'http://127.0.0.1:43124', fetchCapability: 'synthetic-read-grant' }, true);
  return jobId;
}

function recordPlanSignoffAct(dir: string, stage: string, actId: string, jobId = 'synthetic-plan-order-job'): JsonObject {
  const bytes = readFileSync(join(dir, 'project.json'));
  const record = { path: 'project.json' as const, sha256: jobHash(bytes) };
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const plan = { steps: arr(obj(project.plan).steps).map(raw => ({ id: String(obj(raw).id), hash: stepHash(obj(raw)) })) };
  const subjects = [{ kind: 'signoff', stage }];
  const files = [record];
  const inputs: never[] = [];
  const sourceHash = jobHash(JSON.stringify({
    schema: 'rig-review-job-record-source/1',
    record,
    selection: { kind: 'plan' },
    inputs,
    optionSet: null,
    optionSetFile: null,
    plan,
    subjects,
    files,
  }));
  return {
    schema: 'rig-review/act@4',
    kind: 'signoff',
    jobId,
    actId,
    askId: 'synthetic-ask',
    publicationId: 'synthetic-publication',
    at: testClock.iso(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: {
      sourceHash,
      projectHash: record.sha256,
      record,
      inputs,
      files,
      subject: 'plan',
      selection: { kind: 'plan' },
      optionSet: null,
      optionSetFile: null,
      plan,
      subjects,
    },
    value: { stage, decision: 'approved', words: 'Approve the plan.\n' },
  };
}

function recordCheckpointAct(dir: string, checkpointId: string, actId: string, jobId = 'synthetic-plan-order-job'): JsonObject {
  const bytes = readFileSync(join(dir, 'project.json'));
  const sha256 = jobHash(bytes);
  const project = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const steps = arr(obj(project.plan).steps).map(raw => ({ id: String(obj(raw).id), hash: stepHash(obj(raw)) }));
  return {
    schema: 'rig-review/act@2',
    kind: 'checkpoint',
    jobId,
    actId,
    askId: 'synthetic-ask',
    publicationId: 'synthetic-publication',
    at: testClock.iso(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: {
      sourceHash: '1'.repeat(64),
      projectHash: sha256,
      package: { id: 'synthetic-package', revision: 'one' },
      selector: null,
      model: null,
      direction: null,
      optionSet: null,
      appliedResult: null,
      plan: { steps },
      parts: { enumeratorVersion: '2.34.0' },
    },
    value: { checkpointId, planStepId: checkpointId, outcome: 'pass', words: 'Pass the checkpoint.\n' },
  };
}

test('a pending act made before the reorder is refused as stale with REVIEW_ACT_SOURCE_STALE', () => {
  const dir = postInterviewDraft();
  const base = ['--phase', 'post', '--produces', 'A synthetic post artifact.',
    '--rests-on', 'camera_depth', '--bar', 'The post artifact matches the guide.', '--checkpoint-proposed', 'false'];
  write(dir, 'add', 'camera', ['--order', '10', '--does', 'First post step.', ...base]);
  write(dir, 'add', 'timing', ['--order', '20', '--does', 'Second post step.', ...base]);
  write(dir, 'add', 'composition', ['--order', '30', '--does', 'Third post step.', ...base]);
  bindSyntheticReview(dir);
  const pendingAct = recordPlanSignoffAct(dir, 'post-interview', 'sign-before-reorder');
  const legacyAct: JsonObject = {
    ...pendingAct,
    schema: 'rig-review/act@2',
    source: {
      sourceHash: '1'.repeat(64),
      projectHash: '2'.repeat(64),
      package: { id: 'synthetic-package', revision: 'one' },
      selector: null,
      model: null,
      direction: null,
      optionSet: null,
      appliedResult: null,
      plan: obj(pendingAct.source).plan!,
      parts: { enumeratorVersion: '2.34.0' },
    },
  };
  testClock.set(EXAMPLE_NOW + 1_000);
  write(dir, 'revise', 'composition', ['--order', '5']);
  expect(pendingAct.kind).toBe('signoff');
  expect(legacyAct.kind).toBe('signoff');
  unchanged(dir, 'SIGNOFF_FROM_REVIEW_REMOVED', () =>
    rawSignoff(['post-interview', dir, '--from-review', 'sign-before-reorder'], testClock.now()));
});

test('signoff step_hashes still match after the array moves', () => {
  const dir = postInterviewDraft();
  const base = ['--phase', 'post', '--produces', 'A synthetic post artifact.',
    '--rests-on', 'camera_depth', '--bar', 'The post artifact matches the guide.', '--checkpoint-proposed', 'false'];
  write(dir, 'add', 'camera', ['--order', '10', '--does', 'First post step.', ...base]);
  write(dir, 'add', 'timing', ['--order', '20', '--does', 'Second post step.', ...base]);
  write(dir, 'add', 'composition', ['--order', '30', '--does', 'Third post step.', ...base]);
  const before = read(dir);
  const rigHashesBefore = Object.fromEntries(
    arr(obj(before.plan).steps).map(obj).filter(s => s.phase === 'rig').map(s => [String(s.id), stepHash(s)]),
  );
  testClock.set(EXAMPLE_NOW + 1_000);
  // Reordering an unsigned post step to order 0 moves all signed rig steps (orders 1..6) in plan.steps[].
  write(dir, 'revise', 'composition', ['--order', '0']);
  const afterMove = read(dir);
  expect(obj(arr(obj(afterMove.plan).steps)[0]).id).toBe('composition');
  for (const [id, hash] of Object.entries(rigHashesBefore)) {
    expect(stepHash(step(afterMove, id))).toBe(hash);
  }
  expect(codes(dir)).toEqual([]);
  const words = join(dir, 'approve-post.txt');
  writeFileSync(words, 'Approve the reordered post plan.\n');
  testClock.set(EXAMPLE_NOW + 2_000);
  const signed = JSON.parse(signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words, '--json']).stdout) as JsonObject;
  expect(advanceCommand(['post', dir], testClock.now()).exit).toBe(0);
  const afterSign = read(dir);
  for (const id of ['composition', 'camera', 'timing']) {
    expect(obj(signed.step_hashes)[id]).toBe(stepHash(step(afterSign, id)));
  }
  expect(codes(dir)).toEqual([]);
});

test.each(['checkpoint-withdraw', 'bar-amend'] as const)('a %s journal write on a record with an out-of-order array leaves the array bytes and a pending act untouched', action => {
  testClock.set(EXAMPLE_NOW);
  const dir = realpathSync(fixture(project => {
    project.stage = 'parts';
    project.versions = [];
    project.signoffs = arr(project.signoffs).slice(0, 2);
    for (const raw of arr(obj(project.plan).steps).map(obj)) {
      raw.status = raw.id === 'assemble' || raw.id === 'seethrough' ? 'at-checkpoint' : 'pending';
    }
    step(project, 'seethrough').checkpoint = {
      delegated: false, value: true, by: 'user', at: '2026-11-10T00:00:00Z', verbatim: 'Inspect seethrough.',
    };
    // Place plan.steps[] out of order before the journal write.
    const steps = arr(obj(project.plan).steps);
    obj(project.plan).steps = [steps[2]!, steps[0]!, steps[1]!, ...steps.slice(3)];
  }, 'example-numbered/example-project.json'));
  bindSyntheticReview(dir);
  const extractStepsBytes = (text: string): string => {
    const start = text.indexOf('"steps": [');
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    throw new Error('steps array not found');
  };
  const beforeText = readFileSync(join(dir, 'project.json'), 'utf8');
  const beforeStepsBytes = extractStepsBytes(beforeText);
  const beforeOrder = arr(obj(read(dir).plan).steps).map(s => [obj(s).id, obj(s).order]);
  expect(beforeOrder.slice(0, 3)).toEqual([['bones', 3], ['seethrough', 1], ['assemble', 2]]);
  // A pending checkpoint act on 'seethrough' captured before the journal write on 'assemble'.
  const pendingCheckpoint = recordCheckpointAct(dir, 'seethrough', `cp-before-${action}`);
  const reason = join(dir, 'reason.txt');
  const quote = join(dir, 'quote.txt');
  const bar = join(dir, 'bar.txt');
  writeFileSync(reason, 'Direct owner instruction.\n');
  writeFileSync(quote, 'Keep the array order untouched.\n');
  writeFileSync(bar, 'Every synthetic part resolves to its registered source.\n');
  const flags = action === 'bar-amend'
    ? ['bar-amend', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', quote, '--bar-file', bar]
    : ['checkpoint-withdraw', 'assemble', dir, '--by', 'operator', '--reason-file', reason, '--quote-file', quote];
  expect(planCommand(flags).exit).toBe(0);
  const afterText = readFileSync(join(dir, 'project.json'), 'utf8');
  expect(extractStepsBytes(afterText)).toBe(beforeStepsBytes);
  expect(arr(obj(read(dir).plan).steps).map(s => [obj(s).id, obj(s).order])).toEqual(beforeOrder);
  // Checkpoint --from-review is retired; refusing it leaves the out-of-order steps array untouched.
  expect(pendingCheckpoint.kind).toBe('checkpoint');
  unchanged(dir, 'SIGNOFF_FROM_REVIEW_REMOVED', () =>
    rawSignoff(['parts', dir, '--checkpoint', 'seethrough', '--from-review', `cp-before-${action}`], testClock.now()));
  expect(extractStepsBytes(readFileSync(join(dir, 'project.json'), 'utf8'))).toBe(beforeStepsBytes);
});
