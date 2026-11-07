import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json, JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, step, withCode } from './fixtures.ts';
import { cli, gitEnv } from './helpers.ts';
import { checkProject, signoffCommand, testClock } from './clock.ts';

function read(dir: string): JsonObject {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
}
function edit(dir: string, change: (project: JsonObject) => void): void {
  const project = read(dir);
  change(project);
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
}
function sign(dir: string, stage = 'plan-approved', ids?: string): void {
  const file = join(dir, 'words.txt');
  writeFileSync(file, 'Approve these steps.');
  const args = [stage, dir, '--by', 'user', '--verbatim-file', file];
  if (ids !== undefined) args.push('--steps', ids);
  expect(signoffCommand(args).exit).toBe(0);
}
afterEach(() => testClock.reset());

describe('signed step contents', () => {
  test('the command signs, an edited bar refuses, and re-signing clears it', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir);
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF')).toEqual([]);
    edit(dir, (p) => { step(p, 'bones').bar = 'Every joint stays attached throughout motion.'; });
    const refusal = withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF');
    expect(refusal.map((f) => f.path)).toEqual(['plan.steps[bones]']);
    expect(refusal[0]?.message).toContain('signoffs[10]');
    expect(refusal[0]?.message).toContain('sign again');
    expect(cli(['interview', '--check', dir], dir, gitEnv()).code).toBe(1);
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    sign(dir, 'plan-approved', 'bones');
    expect(checkProject(dir).ok).toBe(true);
    expect(cli(['interview', '--check', dir], dir, gitEnv()).code).toBe(0);
  });

  test('a pending signed step is checked before it runs', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture((p) => { step(p, 'bones').status = 'pending'; });
    sign(dir);
    edit(dir, (p) => { step(p, 'bones').does = 'Use a different joint layout.'; });
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF').map((f) => f.path)).toEqual(['plan.steps[bones]']);
  });

  test('a subset re-sign does not approve another edited step', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir);
    edit(dir, (p) => {
      step(p, 'bones').bar = 'New bone bar.';
      step(p, 'meshes').bar = 'New mesh bar.';
    });
    sign(dir, 'plan-approved', 'bones');
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF').map((f) => f.path)).toEqual(['plan.steps[meshes]']);
  });

  test('the latest date wins over array position', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir);
    edit(dir, (p) => { step(p, 'bones').bar = 'New bar.'; });
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    sign(dir, 'plan-approved', 'bones');
    edit(dir, (p) => {
      const records = arr(p.signoffs);
      records.push(records.splice(records.length - 2, 1)[0]);
    });
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF')).toEqual([]);
  });

  test('post steps read post approval hashes', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir, 'post-interview');
    edit(dir, (p) => { step(p, 'camera').bar = 'New camera bar.'; });
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF').map((f) => f.path)).toEqual(['plan.steps[camera]']);
    sign(dir, 'post-interview', 'camera');
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF')).toEqual([]);
  });

  test('execution status changes preserve approval', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir);
    edit(dir, (p) => { step(p, 'bones').status = 'in-progress'; });
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF')).toEqual([]);
  });

  test('a legacy filled example warns without assuming matching step contents', () => {
    const report = checkProject(fixture((p) => {
      for (const raw of arr(p.signoffs)) delete obj(raw).step_hashes;
    }));
    expect(report.ok).toBe(true);
    const warnings = report.warnings.filter((w) => w.code === 'STEP_SIGNOFF_HASH_MISSING');
    expect(warnings).toHaveLength(9);
    expect(warnings.map((w) => w.path)).toContain('plan.steps[bones]');
    expect(warnings.find((w) => w.path === 'plan.steps[bones]')?.message).toContain('signoffs[5]');
  });

  test('a newer legacy approval warns instead of falling back to an older hash', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir);
    edit(dir, (p) => { step(p, 'bones').bar = 'Changed bar.'; });
    sign(dir, 'plan-approved', 'bones');
    edit(dir, (p) => { delete obj(arr(p.signoffs).at(-1)).step_hashes; });
    const report = checkProject(dir);
    expect(withCode(report, 'STEP_EDITED_AFTER_SIGNOFF')).toEqual([]);
    expect(report.warnings.filter((w) => w.code === 'STEP_SIGNOFF_HASH_MISSING').map((w) => w.path)).toContain('plan.steps[bones]');
  });

  test.each([null, {}, { bones: 42 }] as Json[])('a present malformed or incomplete hash record refuses', (hashes) => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir, 'plan-approved', 'bones');
    edit(dir, (p) => { obj(arr(p.signoffs).at(-1)).step_hashes = hashes; });
    expect(withCode(checkProject(dir), 'STEP_EDITED_AFTER_SIGNOFF').map((f) => f.path)).toEqual(['plan.steps[bones]']);
  });
});
