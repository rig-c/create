import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Refusal } from '../src/refusal.ts';
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
function refused(dir: string, code: string, action: () => unknown): string {
  const before = readFileSync(join(dir, 'project.json'));
  let message = '';
  try { action(); throw new Error('expected refusal'); } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
    message = (error as Refusal).message;
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  return message;
}

// Amend retains project.stage; step-status follows the check's effective stage, so the cycle closes on writers alone.
describe('redoing the steps an amendment reset', () => {
  beforeEach(() => testClock.set(new Date('2026-11-20T00:00:00Z')));
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
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    for (const id of post) redo(dir, id);
    expect(checkProject(dir).refusals).toEqual([]);
    expect(checkProject(dir).effective_stage).toBe('direction-review');
    signoffCommand(['direction-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'accepted']);
    expect(read(dir).advances).toEqual(fixtureAdvances(template));
  });

  test('the resumed stage keeps bar order: a reset step waits for its lapsed stage approval', () => {
    const dir = fixture(() => {}, 'example-project.json');
    amend(dir, 'post-interview');
    expect(checkProject(dir).effective_stage).toBe('post-interview');
    const message = refused(dir, 'STEP_STATUS_TRANSITION', () => stepStatusCommand(['camera', 'in-progress', dir, '--by', 'agent']));
    expect(message).toContain('resumes at post-interview');
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    signoffCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    expect(checkProject(dir).effective_stage).toBe('post');
    for (const id of stepsOf(dir, 'post')) redo(dir, id);
    signoffCommand(['direction-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'accepted']);
  });

  test('an amended rig stage opens its own reset steps and no later ones', () => {
    const dir = fixture(() => {}, 'example-project.json');
    amend(dir, 'rigging');
    expect([read(dir).stage, checkProject(dir).effective_stage]).toEqual(['accepted', 'rigging']);
    expect(refused(dir, 'STEP_STATUS_TRANSITION', () => stepStatusCommand(['camera', 'in-progress', dir, '--by', 'agent']))).toContain('runs in post; the amended project resumes at rigging');
    // An upstream parts step is outside the resumed stage; the amendment does not reopen it.
    expect(refused(dir, 'STEP_STATUS_TRANSITION', () => stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent']))).toContain('runs in parts; the amended project resumes at rigging');
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    stepStatusCommand(['bones', 'in-progress', dir, '--by', 'agent']);
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'rigging']);
  });

  test('a reset checkpointed step is done again only with a new live checkpoint signature', () => {
    const dir = fixture(() => {}, 'example-project.json');
    amend(dir, 'rigging');
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    const rig = arr(obj(read(dir).plan).steps).map(obj).filter(s => s.phase === 'rig' && s.status === 'pending').map(s => String(s.id));
    expect(rig).toEqual(['bones', 'meshes', 'constraints', 'motion']);
    for (const id of rig) {
      stepStatusCommand([id, 'in-progress', dir, '--by', 'agent']);
      stepStatusCommand([id, 'at-checkpoint', dir, '--by', 'agent']);
      if (id === 'constraints') {
        // The earlier constraints signature lapsed with the amendment.
        refused(dir, 'CHECKPOINT_UNSIGNED', () => stepStatusCommand([id, 'done', dir, '--by', 'agent']));
        signoffCommand(['rigging', dir, '--by', 'owner', '--checkpoint', 'constraints', '--verbatim-file', words(dir)]);
      }
      stepStatusCommand([id, 'done', dir, '--by', 'agent']);
    }
    const report = checkProject(dir);
    expect(report.refusals).toEqual([]);
    expect([report.stage, report.effective_stage]).toEqual(['accepted', 'rig-review']);
  });

  test('a project without an amendment still runs steps only in its stored stage', () => {
    const dir = fixture(() => {}, 'example-project.json');
    const message = refused(dir, 'STEP_STATUS_TRANSITION', () => stepStatusCommand(['camera', 'in-progress', dir, '--by', 'agent']));
    expect(message).toContain('current stage is accepted; advance to its execution stage first');
  });
});

function fixtureAdvances(template: string): JsonObject['advances'] {
  return read(fixture(() => {}, template)).advances;
}
