import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkProject } from '../src/check.ts';
import { reviewCommand } from '../src/feedback.ts';
import { signoffCommand } from '../src/signoff.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, framing, obj, waypoint } from './fixtures.ts';

afterEach(() => setSystemTime());
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2) + '\n');
function sign(dir: string, stage: string, steps?: string): void {
  const words = join(dir, 'approval.txt');
  writeFileSync(words, 'Approve the revised synthetic answers.\n');
  signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', words, ...(steps ? ['--steps', steps] : [])]);
}

test('feedback additions can be approved by partial rigging and post re-signatures', () => {
  const dir = fixture(() => {}, 'example-project.json', {}, true);
  const original = arr(load(dir).signoffs);
  reviewCommand(['4', dir, '--review', 'direction-review', '--verdict', 'provisional', '--by', 'user', '--source', 'chat',
    '--at', '2026-11-20T00:00:00Z', '--verbatim', 'Add a slower pause and hold the camera.', '--item', 'motion:not-asked', '--item', 'camera_depth:not-asked']);
  const changed = checkProject(dir);
  expect(changed.refusals.map(f => f.code)).toContain('SIGNOFF_ANSWERS_STALE');
  expect(changed.refusals.filter(f => f.code === 'GUIDE_CHANGED_UNSIGNED').map(f => f.path)).toEqual([
    'plan.steps[motion]', 'plan.steps[camera]', 'plan.steps[timing]',
  ]);
  setSystemTime(new Date('2026-11-21T00:00:00Z'));
  sign(dir, 'rigging-interview', 'motion');
  expect(checkProject(dir).refusals.filter(f => f.code === 'GUIDE_CHANGED_UNSIGNED').map(f => f.path)).toEqual(['plan.steps[camera]', 'plan.steps[timing]']);
  sign(dir, 'post-interview', 'camera,timing');
  expect(checkProject(dir).refusals).toEqual([]);
  expect(arr(load(dir).signoffs).slice(0, arr(original).length)).toEqual(original);
});

test('interview re-sign supersedes an earlier framing answer binding', () => {
  const dir = fixture(() => {}, 'example-project.json', {}, true), p = load(dir);
  obj(framing(p, 'reference').answer).additions = [{ by: 'user', at: '2026-11-20T00:00:00Z', verbatim: 'A newly stated framing sentence.', value: 'none' }];
  const before = arr(structuredClone(p.signoffs)); save(dir, p);
  setSystemTime(new Date('2026-11-21T00:00:00Z')); sign(dir, 'interview');
  expect(checkProject(dir).refusals).toEqual([]);
  expect(arr(load(dir).signoffs).slice(0, arr(before).length)).toEqual(before);
});

test('fixture mutation preserves the approval hashes that existed before the mutation', () => {
  const baseline = load(fixture(() => {}, 'example-project.json', {}, true));
  const dir = fixture(p => { obj(waypoint(p, 'motion').guide).verbatim = 'DISTINCT unapproved motion change'; }, 'example-project.json');
  const changed = load(dir);
  expect(changed.signoffs).toEqual(baseline.signoffs);
  expect(checkProject(dir, changed).refusals.map(f => f.code)).toContain('SIGNOFF_ANSWERS_STALE');
});

test.each(['2026-11-01T00:00:00Z', 'unparseable'])('later first answer with at %s is outside earlier interview coverage', at => {
  const dir = fixture(() => {}, 'example-project.json', {}, true), p = load(dir);
  obj(p.interview).framing = [...arr(obj(p.interview).framing), { id: 'later', answer: { delegated: false, by: 'user', at, value: 'later', verbatim: 'Recorded after the interview.' } }];
  expect(checkProject(dir, p).refusals.filter(f => f.code.startsWith('SIGNOFF_ANSWERS_'))).toEqual([]);
});


