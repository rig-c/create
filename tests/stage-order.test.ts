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
