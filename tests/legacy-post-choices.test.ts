import { afterEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAdoption } from '../src/choices.ts';
import { collectItems } from '../src/check.ts';
import { fixture, obj } from './fixtures.ts';
import { interviewOptionsCommand, checkProject, testClock } from './clock.ts';

afterEach(() => testClock.reset());
const now = Date.parse('2026-11-12T12:00:00Z');

test('legacy post adoption changes one post field and preserves the first date', () => {
  const root = fixture(p => { p.stage = 'post-interview'; });
  const file = join(root, 'project.json');
  const before = readFileSync(file, 'utf8');
  testClock.set(now);
  interviewOptionsCommand(['--adopt', root]);
  const after = readFileSync(file, 'utf8');
  expect(after.replace(/,?\n\s*"choices_adopted_at": "[^"]+"/, '')).toBe(before);
  const project = JSON.parse(after);
  expect(obj(project.interview).order).toBeUndefined();
  expect(choiceAdoption(project)).toBeNull();
  for (const item of collectItems(project, { collection: null })) {
    expect(choiceAdoption(project, item)).toBe(item.kind === 'post' ? now : null);
  }
  testClock.set(now + 1000);
  interviewOptionsCommand(['--adopt', root]);
  expect(readFileSync(file, 'utf8')).toBe(after);
});

test('legacy adoption outside post interview refuses without a write', () => {
  const root = fixture();
  const file = join(root, 'project.json');
  const before = readFileSync(file);
  testClock.set(now);
  expect(() => interviewOptionsCommand(['--adopt', root])).toThrow(expect.objectContaining({ code: 'INTERVIEW_CHOICE_INVALID' }));
  expect(readFileSync(file)).toEqual(before);
});

test('malformed post adoption refuses in both writer and checker', () => {
  const root = fixture(p => { p.stage = 'post-interview'; obj(obj(p.interview).post).choices_adopted_at = 'invalid'; });
  const file = join(root, 'project.json');
  const before = readFileSync(file);
  testClock.set(now);
  expect(() => interviewOptionsCommand(['--adopt', root])).toThrow(expect.objectContaining({ code: 'INTERVIEW_CHOICE_INVALID' }));
  expect(readFileSync(file)).toEqual(before);
  expect(checkProject(root).refusals).toContainEqual(expect.objectContaining({ code: 'INTERVIEW_CHOICE_INVALID', path: 'interview.post' }));
  // A fresh post sentence is governed by the post clock, without adopting earlier items.
  const project = JSON.parse(before.toString());
  obj(obj(project.interview).post).choices_adopted_at = new Date(now).toISOString();
  const item = collectItems(project, { collection: null }).find(item => item.kind === 'post')!;
  item.record.guide = { by: 'user', at: new Date(now).toISOString(), verbatim: 'Fresh sentence', delegated: false, source: 'chat', value: 'Fresh sentence' };
  writeFileSync(file, JSON.stringify(project, null, 2) + '\n');
  expect(checkProject(root).refusals).toContainEqual(expect.objectContaining({ code: 'INTERVIEW_CHOICE_REQUIRED', path: item.path }));
});
