import { expect, test, setSystemTime } from 'bun:test';
import { approvalStageOfStep, approvalStageOfGuide, hasStageOrder, interviewStageOfGuide, STAGE_ORDER_SPEC } from '../src/stages.ts';

test('approval ownership separates parts from rigging only after explicit adoption', () => {
  expect(approvalStageOfStep('rig', 'assemble', true)).toBe('plan-approved');
  expect(approvalStageOfStep('rig', 'bones', true)).toBe('rigging-interview');
  expect(approvalStageOfStep('rig', 'bones')).toBe('plan-approved');
  expect(approvalStageOfStep('post', 'camera', true)).toBe('post-interview');
  expect(interviewStageOfGuide('bones', false, true)).toBe('rigging-interview');
  expect(interviewStageOfGuide('assemble', false, true)).toBe('interview');
  expect(interviewStageOfGuide('camera', true, true)).toBe('post-interview');
  expect(hasStageOrder({ interview: { order: { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-05T00:00:00Z' } } })).toBe(true);
  expect(hasStageOrder({ interview: { date: '2026-11-30' } })).toBe(false);
});

import { checkProject } from '../src/check.ts';
import { fixture, arr, obj, step, waypoint, framing, rehashSignoffs } from './fixtures.ts';
import { STAGE_VALUES } from '../src/stages.ts';

test('source interview can finish with later rig guides and plan absent', () => {
  const dir = fixture(p => {
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-05T00:00:00Z' };
    p.stage_values = [...STAGE_VALUES]; p.stage = 'parts'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts'].includes(String(obj(s).stage)));
    obj(p.plan).steps = arr(obj(p.plan).steps).filter(s => ['seethrough', 'assemble'].includes(String(obj(s).id)));
    for (const id of ['bones', 'meshes', 'constraints', 'motion']) waypoint(p, id).guide = null;
    step(p, 'assemble').rests_on = ['assemble'];
    for (const raw of arr(p.signoffs)) if (obj(raw).step_hashes !== undefined) {
      const hashes = obj(obj(raw).step_hashes); for (const id of Object.keys(hashes)) if (!['seethrough', 'assemble'].includes(id)) delete hashes[id];
    }
    rehashSignoffs(p);
  });
  expect(checkProject(dir).refusals).toEqual([]);
});

test('early production execution cannot use a parts plan approval as rigging approval', () => {
  const dir = fixture(p => {
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-05T00:00:00Z' };
    p.stage_values = [...STAGE_VALUES]; p.stage = 'parts'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts'].includes(String(obj(s).stage)));
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
    step(p, 'bones').status = 'done';
  });
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('RIGGING_INTERVIEW_UNSIGNED');
});


import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signoffCommand } from '../src/signoff.ts';
import { Refusal } from '../src/refusal.ts';
import { readTemplate } from '../src/templates.ts';
import { stepHash } from '../src/step-hash.ts';

test('delegated framing must be decided for the first approval and parts execution', () => {
  expect(approvalStageOfGuide('reference', false, true)).toBe('plan-approved');
  expect(approvalStageOfGuide('rig_type', false, true)).toBe('plan-approved');
  const dir = fixture(p => {
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-19T00:00:00Z' };
    obj(p.interview).question_set = obj(readTemplate('project.json').interview).question_set;
    p.stage_values = [...STAGE_VALUES]; p.stage = 'plan-approved'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => obj(s).stage === 'interview');
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
    framing(p, 'reference').answer = { delegated: true, by: 'owner', at: '2026-11-19T00:00:00Z', verbatim: 'auto' };
  });
  const file = join(dir, 'project.json'); const before = readFileSync(file); const words = join(dir, 'words.txt'); writeFileSync(words, 'Approve the parts plan.');
  setSystemTime(new Date('2026-11-20T00:00:00Z'));
  try {
    try { signoffCommand(['plan-approved', dir, '--by', 'owner', '--verbatim-file', words]); throw Error('expected refusal'); } catch (e) { expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe('DELEGATION_UNDECIDED'); }
    expect(readFileSync(file)).toEqual(before);
    const p = JSON.parse(before.toString());
    p.stage = 'parts';
    p.signoffs.push({ stage: 'plan-approved', checkpoint: null, by: 'owner', at: '2026-11-20T00:00:00Z', verbatim: 'yes',
      step_hashes: Object.fromEntries(['seethrough', 'assemble'].map(id => [id, stepHash(step(p, id))])) });
    step(p, 'seethrough').status = 'done';
    writeFileSync(file, JSON.stringify(p));
    expect(checkProject(dir).refusals.map(f => f.code)).toContain('DELEGATION_UNDECIDED');
  } finally { setSystemTime(); }
});
