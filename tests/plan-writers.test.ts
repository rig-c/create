import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkProject, isObject } from '../src/check.ts';
import { checkReplacedSignoffs, collectPlanReplaced } from '../src/plan-history.ts';
import { planCommand } from '../src/plan-writers.ts';
import { reopenCommand } from '../src/reopen.ts';
import { Refusal } from '../src/refusal.ts';
import { STAGE_ORDER_SPEC } from '../src/stages.ts';
import { stepHash } from '../src/step-hash.ts';
import type { Json, JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, step, waypoint } from './fixtures.ts';
import { cli, gitEnv } from './helpers.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const fields = ['--phase', 'post', '--order', '1', '--does', 'Frame the approved rig.', '--produces', 'A camera track.',
  '--rests-on', 'bones', '--bar', 'The frame retains every approved part.', '--checkpoint-proposed', 'false'];
const codes = (dir: string): string[] => checkProject(dir).refusals.map(finding => finding.code);
function draft(): string {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
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
  reopenCommand([stage, dir, '--by', 'user', '--verbatim-file', words]);
}
function retained(record: JsonObject, at = '2026-11-20T00:00:00Z'): JsonObject {
  return { step: structuredClone(record), sha256: stepHash(record), action: 'revised', at, by: 'agent' };
}
afterEach(() => setSystemTime());

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
  setSystemTime(new Date('2026-11-20T00:00:01Z'));
  write(dir, 'revise', 'camera', ['--does', 'Use the revised framing.', '--checkpoint-proposed', 'true']);
  const second = read(dir);
  expect(obj(arr(obj(second.plan).replaced)[0])).toEqual({ ...retained(step(first, 'camera'), '2026-11-20T00:00:01.000Z'), action: 'revised' });
  expect(step(second, 'camera')['x-note']).toEqual(step(first, 'camera')['x-note']);
  expect(step(second, 'camera').checkpoint).toBeNull();
  expect(step(second, 'camera').checkpoint_proposed).toBe(true);
  setSystemTime(new Date('2026-11-20T00:00:02Z'));
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
  setSystemTime(new Date('2026-11-20T00:00:01Z'));
  write(dir, 'revise', 'camera', ['--bar', 'Second revised bar.']);
  expect(arr(obj(read(dir).plan).replaced).map(entry => obj(obj(entry).step).id)).toEqual(['camera', 'camera']);
  setSystemTime(new Date('2026-11-19T00:00:00Z'));
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

test.each(['revise', 'remove'])('live signed %s refuses, including legacy approvals without hashes', action => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(project => {
    step(project, 'bones').status = 'pending';
    for (const signature of arr(project.signoffs)) delete obj(signature).step_hashes;
  });
  unchanged(dir, 'PLAN_STEP_SIGNED', () => write(dir, action, 'bones', action === 'revise' ? ['--bar', 'Revised bar.'] : []));
});

test('the exact reopen cutoff releases a pending signed step and retained hashes still resolve', () => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
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

test('reopening a later stage leaves the earlier plan binding live', () => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(project => { step(project, 'bones').status = 'pending'; });
  reopen(dir, 'post-interview');
  unchanged(dir, 'PLAN_STEP_SIGNED', () => write(dir, 'revise', 'bones', ['--bar', 'Changed.']));
});

test('subset approvals protect only the covered step', () => {
  const dir = draft();
  write(dir, 'add', 'bones', fields.map(value => value === 'post' ? 'rig' : value));
  write(dir, 'add', 'meshes', fields.map(value => value === 'post' ? 'rig' : value));
  const project = read(dir);
  project.signoffs = [{ stage: 'plan-approved', checkpoint: null, at: '2026-11-20T00:00:00Z', by: 'user', verbatim: 'Approve bones only.', steps: ['bones'], step_hashes: { bones: stepHash(step(project, 'bones')) } }];
  save(dir, project);
  unchanged(dir, 'PLAN_STEP_SIGNED', () => write(dir, 'remove', 'bones'));
  write(dir, 'revise', 'meshes', ['--bar', 'Only the unsigned subset changes.']);
});

test('a currently done unsigned step cannot be revised and removal retains its status', () => {
  const dir = draft(); write(dir, 'add', 'camera', fields);
  const project = read(dir); step(project, 'camera').status = 'done'; save(dir, project);
  unchanged(dir, 'PLAN_STEP_DONE', () => write(dir, 'revise', 'camera', ['--bar', 'Changed.']));
  write(dir, 'remove');
  expect(obj(obj(arr(obj(read(dir).plan).replaced)[0]).step).status).toBe('done');
});

test('the existing global drafted_at check still refuses a newly introduced stale parts approval', () => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(project => { step(project, 'camera').status = 'pending'; });
  reopen(dir, 'post-interview');
  const before = readFileSync(join(dir, 'project.json'));
  const candidate = read(dir);
  obj(candidate.plan).drafted_at = '2026-11-20T00:00:00.000Z';
  expect(checkProject(dir, candidate).refusals.map(f => f.code)).toContain('SIGNOFF_BEFORE_PLAN');
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test.each(['legacy-example-project.json', 'example-project.json'])('post re-plan after post-interview reopen preserves both plan dates in %s', template => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(project => {
    step(project, 'camera').status = 'pending';
    step(project, 'camera').status_history = [];
    if (obj(project.plan).rigging_drafted_at === undefined) obj(project.plan).rigging_drafted_at = obj(project.plan).drafted_at;
  }, template);
  reopen(dir, 'post-interview');
  const before = read(dir);
  const dateBytes = (): Buffer => Buffer.from(readFileSync(join(dir, 'project.json'), 'utf8')
    .match(/"(?:drafted_at|rigging_drafted_at)"\s*:\s*"[^"]*"/g)!.join('\n'));
  const dates = dateBytes();
  const baseline = checkProject(dir).refusals;
  write(dir, 'revise', 'camera', ['--bar', 'Changed.']);
  expect(dateBytes()).toEqual(dates);
  expect(obj(read(dir).plan).drafted_by).toEqual(obj(before.plan).drafted_by);
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
    setSystemTime(new Date(at));
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
  const at = '2026-11-20T00:00:01.000Z'; setSystemTime(new Date(at));
  write(dir, 'revise', id, ['--phase', to]);
  const after = obj(read(dir).plan);
  expect(after.drafted_at).toEqual(parts ? at : before.drafted_at);
  expect(after.drafted_by).toEqual(parts ? 'agent' : before.drafted_by);
  expect(after.rigging_drafted_at).toEqual(rigging ? at : before.rigging_drafted_at);
  expect(after.rigging_drafted_by).toBeUndefined();
  expect(after.post_drafted_at).toBeUndefined();
});

test('done work cannot be revised after reopen, can be removed with checkpoint history, and needs a new id', () => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture();
  reopen(dir);
  unchanged(dir, 'PLAN_STEP_DONE', () => write(dir, 'revise', 'camera', ['--bar', 'Changed.']));
  const before = read(dir);
  write(dir, 'remove', 'camera');
  const next = read(dir);
  expect(obj(arr(obj(next.plan).replaced)[0]).step).toEqual(step(before, 'camera'));
  expect(codes(dir)).toEqual([]);
  unchanged(dir, 'PLAN_STEP_DONE', () => write(dir, 'add', 'camera', fields));
  write(dir, 'add', 'camera-next', fields);
  expect(step(read(dir), 'camera-next').status).toBe('pending');
});

test('a live plan hash cannot resolve only to removed history', () => {
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture();
  const project = read(dir);
  obj(project.plan).replaced = [{ ...retained(step(project, 'camera')), action: 'removed' }];
  obj(project.plan).steps = arr(obj(project.plan).steps).filter(value => obj(value).id !== 'camera');
  save(dir, project);
  expect(codes(dir)).toContain('PLAN_REPLACED_SIGNOFF');
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
  project.signoffs = [signature];
  checkReplacedSignoffs(project, [entry], findings);
  expect(findings.map(f => f.code)).toEqual(['PLAN_REPLACED_SIGNOFF']);
  project.reopens = [{ stage: 'post-interview', from_stage: 'post', at: signature.at, by: 'user', verbatim: 'Reopen.', steps_before: [] }];
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
  expect(cli(['plan', 'revise', 'camera', dir, '--by', 'agent', '--bar', 'Revised through CLI.'], dir, env).code).toBe(0);
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
