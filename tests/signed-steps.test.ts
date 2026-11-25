import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj, step } from './fixtures.ts';
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
  test('#981 the command records step hashes, and editing a signed step needs no new signature', () => {
    testClock.set(new Date('2026-11-20T00:00:00Z'));
    const dir = fixture();
    sign(dir);
    expect(Object.keys(obj(obj(arr(read(dir).signoffs).at(-1)).step_hashes))).toContain('bones');
    edit(dir, (p) => { step(p, 'bones').bar = 'Every joint stays attached throughout motion.'; });
    expect(checkProject(dir).refusals).toEqual([]);
    expect(cli(['interview', '--check', dir], dir, gitEnv()).code).toBe(0);
  });
});
