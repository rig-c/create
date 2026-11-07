import { createHash } from 'node:crypto';
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { advanceCommand } from '../src/progress-writers.ts';
import { reopenCommand } from '../src/reopen.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand } from '../src/signoff.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, supersede } from './fixtures.ts';

afterEach(() => setSystemTime());
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
function withoutPost(signed: boolean): string {
  return fixture(p => {
    if (!signed) p.stage = 'post-interview';
    for (const item of arr(obj(obj(p.interview).post).items).map(obj)) supersede(item, 'guide', { not_applicable: true, because: 'No post work applies.', by: 'user', at: '2026-11-20T00:00:00Z' });
    obj(p.plan).steps = arr(obj(p.plan).steps).filter(s => obj(s).phase === 'rig');
    p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'direction-review' && (signed || obj(s).stage !== 'post-interview'));
  });
}
function words(dir: string): string { const file = join(dir, 'words.txt'); writeFileSync(file, 'Approve no post work.'); return file; }

test('the user approves an honestly empty post phase and every N/A post answer', () => {
  const dir = withoutPost(false);
  setSystemTime(new Date('2030-01-01T00:00:00Z'));
  signoffCommand(['interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
  advanceCommand(['accepted', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  const p = load(dir), signed = obj(arr(p.signoffs).at(-1));
  expect(p.stage).toBe('accepted');
  expect(signed.steps).toEqual([]);
  expect(signed.step_hashes).toEqual({});
  const post = arr(obj(obj(p.interview).post).items).map(obj);
  const expected = Object.fromEntries(post.map(item => {
    const answer = Object.fromEntries(Object.entries(obj(item.guide)).sort(([a], [b]) => a.localeCompare(b)));
    const bytes = JSON.stringify({ raw: answer, resolved: answer });
    return [String(item.id), createHash('sha256').update(bytes, 'utf8').digest('hex')];
  }));
  expect(signed.answer_hashes).toEqual(expected);
  expect(checkProject(dir).refusals).toEqual([]);
  delete obj(signed.answer_hashes)[String(post[0]!.id)];
  expect(checkProject(dir, p).refusals.map(f => f.code)).toContain('SIGNOFF_ANSWERS_MISSING');
});

test('after N/A replacement, reopen moves to post-interview and its empty approval completes', () => {
  const dir = withoutPost(true);
  const original = arr(load(dir).signoffs);
  setSystemTime(new Date('2030-01-01T00:00:00Z'));
  signoffCommand(['interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  setSystemTime(new Date('2030-01-01T00:00:01Z'));
  reopenCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  expect(load(dir).stage).toBe('post-interview');
  setSystemTime(new Date('2030-01-01T00:00:02Z'));
  signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  expect(checkProject(dir).refusals.map(f => f.code)).toContain('STAGE_LAGGING');
  advanceCommand(['accepted', dir, '--by', 'user', '--verbatim-file', words(dir)]);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(arr(load(dir).signoffs).slice(0, arr(original).length)).toEqual(original);
});

test.each(['unanswered', 'applicable'])('empty post phase refuses an %s item without writing', kind => {
  const dir = withoutPost(false), p = load(dir);
  const item = obj(arr(obj(obj(p.interview).post).items)[0]);
  item.guide = kind === 'unanswered' ? null : { delegated: false, value: 'Move camera', verbatim: 'Move camera', by: 'user', at: '2026-11-20T00:00:00Z' };
  const file = join(dir, 'project.json'); writeFileSync(file, JSON.stringify(p));
  const before = readFileSync(file);
  let failure: unknown;
  try { signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', words(dir)]); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Refusal);
  expect((failure as Refusal).code).toBe('SIGNOFF_STEP_INVALID');
  expect(readFileSync(file)).toEqual(before);
});
