import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, bindFixtureAnswers, fixture, obj, rehashSignoffs, step } from './fixtures.ts';
import { amendCommand, checkProject, stepStatusCommand, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
function amend(dir: string, stage: string): void {
  writeFileSync(join(dir, 'replacement.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  writeFileSync(join(dir, 'words.txt'), 'Replace the synthetic panel.');
  amendCommand([stage, dir, '--kind', 'part', '--target', 'panel', '--change', 'replacement.svg', '--by', 'owner', '--verbatim-file', join(dir, 'words.txt')]);
}

beforeEach(() => testClock.set(EXAMPLE_NOW));
afterEach(() => testClock.reset());

// #981: an amended project runs a step without a live stage-level plan approval; dependency decides what is rebuilt.
test('an amended pre-parts project runs a parts step in rigging through the oldOrder route', () => {
  const dir = fixture(p => {
    Object.assign(p, JSON.parse(JSON.stringify(p).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,
      value => new Date(Date.parse(value) - 30 * 86_400_000).toISOString())));
    p.stage = 'rigging'; p.versions = [];
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'rigging'].includes(String(obj(s).stage)));
    for (const raw of arr(p.signoffs)) {
      const signature = obj(raw); if (signature.stage === 'parts') signature.stage = 'rigging'; delete signature.answer_hashes;
    }
    for (const raw of arr(obj(p.plan).steps)) if (obj(raw).phase === 'post') obj(raw).status = 'pending';
    step(p, 'assemble').status = 'pending'; rehashSignoffs(p); bindFixtureAnswers(p);
  });
  expect(checkProject(dir).refusals).toEqual([]);
  amend(dir, 'plan-approved');
  expect([checkProject(dir).stage, checkProject(dir).effective_stage]).toEqual(['rigging', 'plan-approved']);
  expect(stepStatusCommand(['seethrough', 'in-progress', dir, '--by', 'agent']).exit).toBe(0);
  expect(step(read(dir), 'seethrough').status).toBe('in-progress');
});
