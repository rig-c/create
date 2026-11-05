import { expect, test } from 'bun:test';
import { approvalStageOfStep, hasStageOrder, interviewStageOfGuide, STAGE_ORDER_SPEC } from '../src/stages.ts';

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
import { fixture, arr, obj, step, waypoint, rehashSignoffs } from './fixtures.ts';
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
