import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import { baselineOf, countFindings, newFindings } from '../src/refusal-baseline.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { advanceCommand, checkProject, pauseCommand, reopenCommand, resumeCommand, reviewCommand, signoffCommand, stepStatusCommand, testClock } from './clock.ts';

const CHECKPOINTS = join(import.meta.dir, '../templates/example-chain/checkpoints');
/** The one planted refusal: a second inventory row for the same input. No writer below touches inputs[]. */
const PLANTED = { code: 'INPUT_PATH_DUPLICATE', path: 'inputs[1].path' };

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const refusals = (dir: string): { code: string; path: string }[] => checkProject(dir).refusals.map(f => ({ code: f.code, path: f.path }));
function words(dir: string): string { const path = join(dir, 'words.txt'); writeFileSync(path, 'Synthetic approval words.\n'); return path; }

/** A writer-built prefix of the example chain, optionally carrying the planted refusal. */
function chain(checkpoint: string, planted: boolean): string {
  const dir = join(tempDir(), 'project');
  cpSync(join(CHECKPOINTS, checkpoint), dir, { recursive: true });
  expect(refusals(dir)).toEqual([]);
  if (planted) {
    const project = read(dir);
    project.inputs = [...arr(project.inputs), structuredClone(arr(project.inputs)[0]!)];
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    expect(refusals(dir)).toEqual([PLANTED]);
  }
  return dir;
}
const unplanted = (project: JsonObject): JsonObject => ({ ...project, inputs: arr(project.inputs).slice(0, -1) });

let minute = 0;
function tick(): void { testClock.set(Date.parse('2026-11-20T00:00:00Z') + 60_000 * minute++); }
beforeEach(() => { minute = 0; });
afterEach(() => testClock.reset());

function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); throw new Error(`expected ${code}`); } catch (error) {
    expect(error).toBeInstanceOf(Refusal);
    expect((error as Refusal).code).toBe(code);
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

const reopen = (dir: string, stage: string): void => { tick(); reopenCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]); };
const sign = (dir: string, stage: string, ...rest: string[]): void => { tick(); signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', words(dir), ...rest]); };
function acceptRig(dir: string): void {
  tick();
  reviewCommand(['1', dir, '--verdict', 'accepted', '--by', 'user', '--review', 'rig-review', '--verbatim-file', words(dir), '--source', 'synthetic example']);
  sign(dir, 'rig-review', '--version', '1');
}

const writes: [string, string, (dir: string) => void][] = [
  ['reopen', '3-rig-review', dir => reopen(dir, 'rigging-interview')],
  ['signoff', '3-rig-review', acceptRig],
  ['step-status', '3-rig-review', dir => { reopen(dir, 'parts'); tick(); stepStatusCommand(['assemble', 'in-progress', dir, '--by', 'agent']); }],
  ['pause and resume', '3-rig-review', dir => {
    sign(dir, 'paused');
    tick(); pauseCommand([dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    tick(); resumeCommand(['rig-review', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
  }],
];

test.each(writes)('%s succeeds on a record that already carries an unrelated refusal', (_name, checkpoint, write) => {
  const clean = chain(checkpoint, false);
  write(clean);
  const after = refusals(clean);
  minute = 0;
  const planted = chain(checkpoint, true);
  write(planted);
  // The carried refusal stays reported by check beside whatever the write leaves on a clean
  // record (signoff's own pending advance), and the write added nothing else to the record.
  const key = (f: { code: string; path: string }): string => `${f.code} ${f.path}`;
  expect(refusals(planted).map(key).sort()).toEqual([...after, PLANTED].map(key).sort());
  expect(unplanted(read(planted))).toEqual(read(clean));
});

test('a write that adds a refusal is refused with only the new code and leaves the record unchanged', () => {
  tick();
  const dir = chain('3-rig-review', true);
  refused(dir, 'SIGNOFF_AHEAD_OF_STAGE', () => sign(dir, 'accepted'));
  expect(refusals(dir)).toEqual([PLANTED]);
});

test('advance still requires check to pass: a carried refusal blocks the stage boundary', () => {
  const clean = chain('3-rig-review', false);
  acceptRig(clean);
  tick(); advanceCommand(['post-interview', clean, '--by', 'owner', '--verbatim-file', words(clean)]);
  expect(read(clean).stage).toBe('post-interview');
  minute = 0;
  const dir = chain('3-rig-review', true);
  acceptRig(dir);
  tick();
  refused(dir, PLANTED.code, () => advanceCommand(['post-interview', dir, '--by', 'owner', '--verbatim-file', words(dir)]));
  expect(read(dir).stage).toBe('rig-review');
});

test('the baseline matches code and path with multiplicity', () => {
  const at = (code: string, path: string, message = `${path}: synthetic`): { code: string; path: string; message: string } => ({ code, path, message });
  const baseline = countFindings([at('A', 'x'), at('B', 'y')]);
  // A carried refusal that moves to another path is new; a removed one is fine.
  expect(newFindings(baseline, [at('A', 'z')]).map(f => f.path)).toEqual(['z']);
  expect(newFindings(baseline, [])).toEqual([]);
  // A second copy of a carried refusal is new; the first copy is covered.
  expect(newFindings(baseline, [at('A', 'x'), at('A', 'x', 'second')]).map(f => f.message)).toEqual(['second']);
  // The same path under another code is new.
  expect(newFindings(baseline, [at('B', 'x')]).map(f => f.code)).toEqual(['B']);
  expect(baseline.get(JSON.stringify(['A', 'x']))).toBe(1);
});

test('a check that stopped early supplies no baseline', () => {
  const report = checkProject(chain('3-rig-review', false), { schema: 'unknown' });
  expect(report.refusals.map(f => f.code)).toEqual(['SCHEMA_UNKNOWN']);
  expect(baselineOf(report).size).toBe(0);
});
