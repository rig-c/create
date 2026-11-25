import { expect, test } from 'bun:test';
import { checkProject } from '../src/check.ts';
import { depthPlanMoves, TURN_BODY_SINCE } from '../src/rig-version.ts';
import { deriveWaypoints, TURN_OPTIONS, TURN_QUESTION } from '../src/waypoints.ts';
import { interviewStageOfGuide } from '../src/stages.ts';
import { readTemplate, type Json, type JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

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
  expect(moves[2]!.act).toContain('--groups head');
  expect(moves[2]!.act).toContain('turn.body');
  expect(moves[2]!.act).toContain('DEPTH_GROUP_LEFT_OUT');
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
    { id: 'turn-body', kind: 'value', label: 'Head and body turn', effect: 'The head and body turn with depth.', fragment: { mode: 'depth', body: true } },
    { id: 'other', kind: 'other', label: 'Other', effect: 'Describe the view you want.' },
    { id: 'auto', kind: 'auto', label: 'Let the agent decide', effect: 'The agent records its decision before approval.' },
  ]);
  expect(TURN_OPTIONS.every(option => !('recommended' in option) && !('reason' in option))).toBe(true);
});

test('#1000 head-and-body depth moves keep turn.body instead of stripping it', () => {
  const moves = depthPlanMoves(project({ mode: 'depth', body: true }));
  expect(moves).toHaveLength(3);
  expect(moves[2]!.act).toContain('keep turn.body in the working config and apply both head and body groups');
  expect(moves[2]!.act).not.toContain('--groups head');
});

test('#1000 TURN_BODY_VALUE_INVALID accepts only body: true with mode: "depth" and refuses invalid body before writing', () => {
  const dir = tempDir();
  const base = readTemplate('example-project.json');
  const now = Date.parse('2026-11-25T00:00:00Z');
  const withGuide = (guide: JsonObject): JsonObject => {
    const candidate = structuredClone(base);
    const turn = arr(obj(candidate.interview).waypoints).map(obj).find(w => w.id === 'turn')!;
    turn.guide = guide;
    return candidate;
  };
  const validGuide = structuredClone(obj(arr(obj(base.interview).waypoints).map(obj).find(w => w.id === 'turn')!.guide));
  delete validGuide.choice;
  expect(checkProject(dir, withGuide({ ...structuredClone(validGuide), value: { mode: 'depth', body: true } }), { now, recordPublication: true }).refusals
    .filter(f => f.code === 'TURN_BODY_VALUE_INVALID')).toEqual([]);

  for (const invalid of [
    { mode: 'depth', body: false },
    { mode: 'depth', body: 'true' },
    { mode: 'depth', body: null },
    { mode: 'fixed', body: true },
    { mode: 'fixed', body: false },
    { body: true },
  ] as Json[]) {
    const report = checkProject(dir, withGuide({ ...structuredClone(validGuide), value: invalid }), { now, recordPublication: true });
    expect(report.refusals.filter(f => f.code === 'TURN_BODY_VALUE_INVALID').map(f => f.path))
      .toEqual(['interview.waypoints[turn].guide.value.body']);
  }

  const delegatedBad = withGuide({
    delegated: true, by: 'user', at: TURN_BODY_SINCE, verbatim: 'Let the agent decide',
    agent_decision: { by: 'agent', at: TURN_BODY_SINCE, reasoning: 'Invalid combo', covers: 'view', value: { mode: 'fixed', body: true } },
  });
  expect(checkProject(dir, delegatedBad, { now, recordPublication: true }).refusals.filter(f => f.code === 'TURN_BODY_VALUE_INVALID').map(f => f.path))
    .toEqual(['interview.waypoints[turn].guide.agent_decision.value.body']);

  const additionBad = withGuide({
    ...structuredClone(validGuide), value: { mode: 'depth' },
    additions: [{ by: 'user', at: TURN_BODY_SINCE, verbatim: 'No body', source: 'polish feedback, v1', value: { mode: 'depth', body: false } }],
  });
  expect(checkProject(dir, additionBad, { now, recordPublication: true }).refusals.filter(f => f.code === 'TURN_BODY_VALUE_INVALID').map(f => f.path))
    .toEqual(['interview.waypoints[turn].guide.additions[0].value.body']);
});

test('#1003 TURN_BODY_VALUE_INVALID is dated by the agent decision: WARN before TURN_BODY_SINCE, refusal from it', () => {
  const dir = tempDir();
  const base = readTemplate('example-project.json');
  const now = Date.parse(TURN_BODY_SINCE) + 24 * 60 * 60 * 1000;
  const path = 'interview.waypoints[turn].guide.agent_decision.value.body';
  const decided = (at: string): JsonObject => {
    const candidate = structuredClone(base);
    const turn = arr(obj(candidate.interview).waypoints).map(obj).find(w => w.id === 'turn')!;
    turn.guide = {
      delegated: true, by: 'user', at, verbatim: 'Let the agent decide',
      agent_decision: { by: 'agent', at, reasoning: 'Head only', covers: 'view', value: { mode: 'depth', body: false } },
    };
    return candidate;
  };
  const earlier = checkProject(dir, decided(new Date(Date.parse(TURN_BODY_SINCE) - 60 * 1000).toISOString()), { now, recordPublication: true });
  expect(earlier.refusals.filter(f => f.code === 'TURN_BODY_VALUE_INVALID')).toEqual([]);
  expect(earlier.warnings.filter(f => f.code === 'TURN_BODY_VALUE_INVALID').map(f => f.path)).toEqual([path]);

  const from = checkProject(dir, decided(TURN_BODY_SINCE), { now, recordPublication: true });
  expect(from.refusals.filter(f => f.code === 'TURN_BODY_VALUE_INVALID').map(f => f.path)).toEqual([path]);
  expect(from.warnings.filter(f => f.code === 'TURN_BODY_VALUE_INVALID')).toEqual([]);
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
