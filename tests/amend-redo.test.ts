import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { amendCommand, checkProject, signoffCommand, stepStatusCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
function words(dir: string): string {
  const file = join(dir, 'words.txt');
  writeFileSync(file, '﻿Redo the synthetic post work.\r\n');
  return file;
}
function amend(dir: string, stage: string): void {
  writeFileSync(join(dir, 'replacement.json'), '{}\n');
  amendCommand([stage, dir, '--kind', 'motion-track', '--target', 'camera', '--change', 'replacement.json', '--by', 'owner', '--verbatim-file', words(dir)]);
}
const stepsOf = (dir: string, phase: string): string[] =>
  arr(obj(read(dir).plan).steps).map(obj).filter(s => s.phase === phase).map(s => String(s.id));
function redo(dir: string, id: string): void {
  for (const status of ['in-progress', 'at-checkpoint', 'done']) stepStatusCommand([id, status, dir, '--by', 'agent']);
}

// Amend retains project.stage; step-status follows the check's effective stage, so the cycle closes on writers alone.
describe('redoing the steps an amendment reset', () => {
  beforeEach(() => testClock.set(EXAMPLE_NOW));
  afterEach(() => testClock.reset());

  test.each(['example-project.json', 'legacy-example-project.json'])('%s: amend post, redo the reset steps, sign again, check exits 0', template => {
    const dir = fixture(() => {}, template);
    expect(checkProject(dir).refusals).toEqual([]);
    amend(dir, 'post');
    expect(read(dir).stage).toBe('accepted');
    expect(checkProject(dir).effective_stage).toBe('post');
    const post = stepsOf(dir, 'post');
    expect(post.length).toBeGreaterThan(0);
    for (const id of post) expect(obj(arr(obj(read(dir).plan).steps).map(obj).find(s => s.id === id)).status).toBe('pending');
    testClock.set(EXAMPLE_NOW + 86_400_000);
    for (const id of post) redo(dir, id);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(checkProject(dir).effective_stage).toBe('direction-review');
    signoffCommand(['direction-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'accepted']);
    expect(read(dir).advances).toEqual(fixtureAdvances(template));
  });

  test('the resumed stage completes after its approval is signed again', () => {
    const dir = fixture(() => {}, 'example-project.json');
    amend(dir, 'post-interview');
    expect(checkProject(dir).effective_stage).toBe('post-interview');
    testClock.set(EXAMPLE_NOW + 86_400_000);
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    expect(checkProject(dir).effective_stage).toBe('post');
    for (const id of stepsOf(dir, 'post')) redo(dir, id);
    signoffCommand(['direction-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'accepted']);
  });

  test('a reset checkpointed step is done again and a new live checkpoint signature records', () => {
    const dir = fixture(() => {}, 'example-project.json');
    amend(dir, 'rigging');
    testClock.set(EXAMPLE_NOW + 86_400_000);
    const rig = arr(obj(read(dir).plan).steps).map(obj).filter(s => s.phase === 'rig' && s.status === 'pending').map(s => String(s.id));
    expect(rig).toEqual(['bones', 'meshes', 'constraints', 'motion']);
    for (const id of rig) {
      stepStatusCommand([id, 'in-progress', dir, '--by', 'agent']);
      stepStatusCommand([id, 'at-checkpoint', dir, '--by', 'agent']);
      if (id === 'constraints') {
        signoffCommand(['rigging', dir, '--by', 'owner', '--checkpoint', 'constraints', '--verbatim-file', words(dir)]);
      }
      stepStatusCommand([id, 'done', dir, '--by', 'agent']);
    }
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'rig-review']);
  });

});

function fixtureAdvances(template: string): JsonObject['advances'] {
  return read(fixture(() => {}, template)).advances;
}
