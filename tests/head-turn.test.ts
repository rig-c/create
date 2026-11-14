import { expect, test } from 'bun:test';
import { depthPlanMoves } from '../src/rig-version.ts';
import { deriveWaypoints, TURN_OPTIONS, TURN_QUESTION } from '../src/waypoints.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';

function project(value?: JsonObject): JsonObject {
  return { interview: { waypoints: value ? [{ id: 'turn', guide: { delegated: false, by: 'user', at: '2026-11-14T01:00:00Z', verbatim: 'Keep this synthetic view.', value } }] : [] }, versions: [] };
}

test('#514 fixed view and an unanswered turn add no depth moves', () => {
  expect(depthPlanMoves(project())).toEqual([]);
  expect(depthPlanMoves(project({ mode: 'fixed' }))).toEqual([]);
});
test('#514 per-part depth names prepare, the external model and apply before rig', () => {
  const moves = depthPlanMoves(project({ mode: 'depth' }));
  expect(moves).toHaveLength(3);
  expect(moves[0]!.act).toContain('rig-parts depth-prepare');
  expect(moves[1]!.act).toContain('face normals');
  expect(moves[2]!.act).toContain('rig-parts depth-apply');
  expect(moves[2]!.act).toContain('--depth-manifest');
  expect(moves.every(m => m.command === null && m.role === 'agent')).toBe(true);
});
test('#514 route metadata in an old answer does not select next moves', () => {
  const moves = depthPlanMoves(project({ mode: 'depth', route: 'per-layer' }));
  expect(moves).toEqual(depthPlanMoves(project({ mode: 'depth' })));
  expect(moves[0]!.act).toContain('route and reason in the turn plan step text');
});
test('#514 turn and depth move to rigging while camera stays post', () => {
  const derived = deriveWaypoints(['turn', 'depth']);
  expect(derived.waypoints).toEqual([{ id: 'turn', config: ['turn', 'depth'] }]);
  expect(derived.post_items.find(i => i.id === 'camera_depth')?.config).toEqual([]);
  expect(deriveWaypoints(['turn', 'depth'], false).post_items[0]).toEqual({ id: 'camera_depth', config: ['turn', 'depth'] });
  expect(interviewStageOfGuide('turn', false, true)).toBe('rigging-interview');
});
test('#514 the owner question and options are concrete Review option-set input', () => {
  const template = obj(readTemplate('project.json').interview);
  const turn = arr(template.waypoints).map(obj).find(w => w.id === 'turn')!;
  expect(obj(arr(turn.prompts)[0]).text).toBe(TURN_QUESTION);
  expect(TURN_QUESTION).toBe('Should this rig keep the painted view, or turn its head with depth?');
  expect(TURN_OPTIONS).toEqual([
    { id: 'fixed', kind: 'value', label: 'Fixed view', effect: 'Keep the painted view.', fragment: { mode: 'fixed' } },
    { id: 'turn', kind: 'value', label: 'Head turn', effect: 'The head turns with depth, like the head-turn demo.', fragment: { mode: 'depth' } },
    { id: 'other', kind: 'other', label: 'Other', effect: 'Describe the view you want.' },
    { id: 'auto', kind: 'auto', label: 'Let the agent decide', effect: 'The agent records its decision before approval.' },
  ]);
  expect(TURN_OPTIONS.every(option => !('recommended' in option) && !('reason' in option))).toBe(true);
});

test('#514 an approved depth turn requires an earlier depth plan step', async () => {
  const { depthPlanFindings } = await import('../src/rig-version.ts');
  const p = project({ mode: 'depth' });
  p.stage = 'rigging';
  obj(arr(obj(p.interview).waypoints)[0]).guide = { delegated: false, by: 'user', at: '2026-11-14T01:00:00Z', verbatim: 'Turn the head.', value: { mode: 'depth' } };
  expect(depthPlanFindings(p, []).map(f => f.code)).toEqual(['RIG_DEPTH_PLAN_MISSING']);
  p.plan = { steps: [{ id: 'turn', phase: 'rig', rests_on: ['turn'], order: 1 }, { id: 'bones', phase: 'rig', order: 2 }] };
  expect(depthPlanFindings(p, [])).toEqual([]);
});


test('#514 depth precedes every rigging-phase step, including a custom step id', async () => {
  const { depthPlanFindings } = await import('../src/rig-version.ts');
  const p = project({ mode: 'depth' }); p.stage = 'rigging';
  p.plan = { steps: [{ id: 'custom-rig', phase: 'rig', order: 1 }, { id: 'turn', phase: 'rig', rests_on: ['turn'], order: 2 }] };
  expect(depthPlanFindings(p, []).map(f => f.code)).toEqual(['RIG_DEPTH_PLAN_MISSING']);
});
