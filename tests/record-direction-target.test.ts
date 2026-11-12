import { expect, test } from 'bun:test';
import { recordDirectionTarget, requireRecordDirectionTarget } from '../src/record-direction-target.ts';
import type { JsonObject } from '../src/templates.ts';

const post = (n: number): JsonObject => ({ n, kind: 'post', at: '2026-11-10T01:00:00Z',
  verdicts: [{ review: 'direction-review', verdict: 'accepted', by: 'user', at: '2026-11-10T02:00:00Z' }] });
const project = (...versions: JsonObject[]): JsonObject => ({ stage: 'direction-review', versions });

test('record direction target selects the sole current live accepted post', () => {
  expect(recordDirectionTarget(project(post(2)))).toBe(2);
  expect(recordDirectionTarget(project(post(2), post(3)))).toBe(3);
});

test.each(['missing', 'duplicate', 'newer-unaccepted', 'withdrawn', 'future'])(
  'record direction target refuses %s with a named code', problem => {
    const p = project(post(2));
    if (problem === 'missing') p.versions = [];
    if (problem === 'duplicate') (p.versions as JsonObject[]).push(post(2));
    if (problem === 'newer-unaccepted') (p.versions as JsonObject[]).push({ ...post(3), verdicts: [] });
    if (problem === 'withdrawn') ((p.versions as JsonObject[])[0]!.verdicts as JsonObject[]).push({ review: 'direction-review', verdict: 'bounced', by: 'user', at: '2026-11-10T03:00:00Z' });
    const at = problem === 'future' ? Date.parse('2026-11-10T01:30:00Z') : Infinity;
    expect(recordDirectionTarget(p, at)).toBeNull();
    expect(() => requireRecordDirectionTarget(p, at)).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_RECORD_TARGET_INVALID' }));
  },
);

test.each(['post', 'direction-review'])('record direction target honors a %s reopen and strict cutoff', stage => {
  const p = project(post(2));
  p.reopens = [{ stage, from_stage: 'direction-review', by: 'user', at: '2026-11-10T02:00:00Z', verbatim: 'Review again', steps_before: [] }];
  expect(recordDirectionTarget(p)).toBeNull();
  const fresh = post(3); fresh.at = '2026-11-10T03:00:00Z';
  (fresh.verdicts as JsonObject[])[0]!.at = '2026-11-10T04:00:00Z';
  (p.versions as JsonObject[]).push(fresh);
  expect(recordDirectionTarget(p)).toBe(3);
});
