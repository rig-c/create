import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from '../src/refusal.ts';
import type { JsonObject } from '../src/templates.ts';
import { arr, obj } from './fixtures.ts';
import { clockedCli, run, tempDir } from './helpers.ts';
import { checkProject, pauseCommand, reopenCommand, resumeCommand, signoffCommand, testClock } from './clock.ts';

const CHECKPOINTS = join(import.meta.dir, '../templates/example-chain/checkpoints');
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
function words(dir: string): string { const path = join(dir, 'words.txt'); writeFileSync(path, 'Hold the synthetic project.\n'); return path; }
/** A writer-built prefix of the example chain: check passes with no refusals and no warnings. */
function chain(checkpoint: string): string {
  const dir = join(tempDir(), 'project');
  cpSync(join(CHECKPOINTS, checkpoint), dir, { recursive: true });
  return dir;
}
let minute = 0;
/** Each writer call runs one minute after the last, so every new record is ordered in time. */
function tick(): void { testClock.set(Date.parse('2026-11-20T00:00:00Z') + 60_000 * minute++); }
function signPaused(dir: string): void { tick(); signoffCommand(['paused', dir, '--by', 'owner', '--verbatim-file', words(dir)]); }
function pause(dir: string): void { tick(); pauseCommand([dir, '--by', 'owner', '--verbatim-file', words(dir)]); }
function resume(dir: string, stage: string): void { tick(); resumeCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir)]); }
function clean(dir: string): void {
  const report = checkProject(dir);
  expect(report.refusals.map(f => f.code)).toEqual([]);
  expect(report.warnings.map(f => f.code)).toEqual([]);
}
function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  try { action(); throw new Error(`expected ${code}`); } catch (error) {
    expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe(code);
  }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

beforeEach(() => { minute = 0; tick(); });
afterEach(() => testClock.reset());

describe('pause and resume round trip through the writers', () => {
  test.each([['1-parts-verdict', 'parts'], ['3-rig-review', 'rig-review'], ['4-direction-post', 'post']])('%s: %s -> paused -> back', (checkpoint, stage) => {
    const dir = chain(checkpoint);
    const before = read(dir);
    expect(before.stage).toBe(stage);
    clean(dir);
    signPaused(dir); clean(dir);
    pause(dir);
    const paused = read(dir);
    expect(paused.stage).toBe('paused');
    expect(arr(paused.pauses).map(raw => [obj(raw).from_stage, obj(raw).stage, obj(raw).by])).toEqual([[stage, 'paused', 'owner']]);
    expect(obj(obj(arr(paused.pauses)[0]).signoff).stage).toBe('paused');
    clean(dir);
    resume(dir, stage);
    const resumed = read(dir);
    expect(resumed.stage).toBe(stage);
    expect(arr(resumed.pauses).map(raw => [obj(raw).from_stage, obj(raw).stage])).toEqual([[stage, 'paused'], ['paused', stage]]);
    // Only the sign-off and the pause history were added; the move history is untouched.
    expect(resumed.advances).toEqual(before.advances);
    const rest = (project: JsonObject): JsonObject => { const copy = structuredClone(project); delete copy.signoffs; delete copy.pauses; return copy; };
    expect(rest(resumed)).toEqual(rest(before));
    expect(arr(resumed.signoffs).slice(0, -1)).toEqual(arr(before.signoffs));
    clean(dir);
    expect([...checkProject(dir).refusals, ...checkProject(dir).warnings].map(f => f.code)).not.toContain('STAGE_MOVE_UNLINKED');
  });

  test('a second pause needs a new paused sign-off after the resume', () => {
    const dir = chain('3-rig-review');
    signPaused(dir); pause(dir); resume(dir, 'rig-review');
    refused(dir, 'PAUSED_UNSIGNED', () => pause(dir));
    signPaused(dir); pause(dir); clean(dir);
    resume(dir, 'rig-review'); clean(dir);
    expect(arr(read(dir).pauses)).toHaveLength(4);
  });

  test('the CLI process records the round trip at the injected instant', () => {
    const dir = chain('1-parts-verdict');
    const at = (args: string[]): { code: number; stderr: string } => { tick(); return run([process.execPath, ...clockedCli(), ...args], dir, process.env as Record<string, string>); };
    const file = words(dir);
    expect(at(['signoff', 'paused', '--by', 'owner', '--verbatim-file', file]).code).toBe(0);
    const paused = at(['pause', '--by', 'owner', '--verbatim-file', file]);
    expect(paused.code).toBe(0);
    expect(read(dir).stage).toBe('paused');
    expect(obj(arr(read(dir).pauses)[0]).at).toBe(testClock.iso());
    const wrong = at(['resume', 'rigging', '--by', 'owner', '--verbatim-file', file]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('RESUME_STAGE_MISMATCH');
    expect(at(['resume', 'parts', '--by', 'owner', '--verbatim-file', file]).code).toBe(0);
    expect(read(dir).stage).toBe('parts');
    clean(dir);
  });
});

describe('pause and resume refusals leave the bytes unchanged', () => {
  test('resuming to any stage other than the one paused from', () => {
    const dir = chain('3-rig-review');
    signPaused(dir); pause(dir);
    for (const stage of ['rigging', 'post-interview', 'interview', 'accepted', 'paused', 'unknown']) refused(dir, 'RESUME_STAGE_MISMATCH', () => resume(dir, stage));
    resume(dir, 'rig-review'); clean(dir);
  });

  test('pausing a paused project, and resuming one that is not paused', () => {
    const dir = chain('1-parts-verdict');
    refused(dir, 'RESUME_NOT_PAUSED', () => resume(dir, 'parts'));
    signPaused(dir); pause(dir);
    signPaused(dir);
    refused(dir, 'PAUSE_ALREADY_PAUSED', () => pause(dir));
  });

  test('pause needs a human paused sign-off, a human mover and a stage in the order before accepted', () => {
    const dir = chain('1-parts-verdict');
    refused(dir, 'PAUSED_UNSIGNED', () => pause(dir));
    signPaused(dir);
    refused(dir, 'SIGNOFF_NOT_HUMAN', () => { tick(); pauseCommand([dir, '--by', 'Agent', '--verbatim-file', words(dir)]); });
    refused(dir, 'PROGRESS_OPTION_INVALID', () => { tick(); pauseCommand([dir, '--verbatim-file', words(dir)]); });
    refused(dir, 'UNKNOWN_OPTION', () => { tick(); pauseCommand([dir, '--by', 'owner', '--to', 'parts']); });
    const done = chain('../');
    signPaused(done);
    refused(done, 'PAUSE_STAGE_INVALID', () => pause(done));
  });

  test('resume refuses an agent mover', () => {
    const dir = chain('1-parts-verdict');
    signPaused(dir); pause(dir);
    refused(dir, 'SIGNOFF_NOT_HUMAN', () => { tick(); resumeCommand(['parts', dir, '--by', 'agent', '--verbatim-file', words(dir)]); });
  });
});

describe('leaving a pause another way', () => {
  test('a project paused by hand resumes, through the writer, at the stage its latest recorded move reached', () => {
    const dir = chain('3-rig-review');
    signPaused(dir);
    const p = read(dir); p.stage = 'paused'; save(dir, p);
    clean(dir);
    refused(dir, 'RESUME_STAGE_MISMATCH', () => resume(dir, 'rigging'));
    resume(dir, 'rig-review'); clean(dir);
    expect(arr(read(dir).pauses).map(raw => [obj(raw).from_stage, obj(raw).stage])).toEqual([['paused', 'rig-review']]);
  });

  test('a reopen out of a pause leaves the project unpaused, so resume refuses', () => {
    const dir = chain('3-rig-review');
    signPaused(dir); pause(dir);
    tick(); reopenCommand(['rigging', dir, '--by', 'owner', '--verbatim-file', words(dir)]);
    expect(read(dir).stage).toBe('rigging');
    clean(dir);
    refused(dir, 'RESUME_NOT_PAUSED', () => resume(dir, 'rig-review'));
  });
});

describe('check reads pauses[]', () => {
  const planted = (mutate: (entries: JsonObject[]) => void): string[] => {
    const dir = chain('3-rig-review');
    signPaused(dir); pause(dir); resume(dir, 'rig-review');
    const p = read(dir); mutate(arr(p.pauses) as JsonObject[]); save(dir, p);
    return checkProject(dir).refusals.filter(f => f.code === 'PAUSE_MALFORMED').map(f => f.path);
  };
  test('a well-formed history has no finding', () => expect(planted(() => {})).toEqual([]));
  test.each([
    ['an agent mover', (e: JsonObject[]) => { e[1]!.by = 'agent'; }, ['pauses[1]']],
    ['a missing verbatim', (e: JsonObject[]) => { delete e[0]!.verbatim; }, ['pauses[0]']],
    ['an unreadable date', (e: JsonObject[]) => { e[1]!.at = 'later'; }, ['pauses[1]']],
    ['a pause from accepted', (e: JsonObject[]) => { e[0]!.from_stage = 'accepted'; }, ['pauses[0]']],
    ['a move that neither enters nor leaves paused', (e: JsonObject[]) => { e[1]!.from_stage = 'rigging'; }, ['pauses[1]']],
    ['a pause with no paused sign-off', (e: JsonObject[]) => { obj(e[0]!.signoff).at = '2026-11-01T00:00:00Z'; }, ['pauses[0]']],
    ['an entry dated before the one before it', (e: JsonObject[]) => { e[1]!.at = '2026-11-19T00:00:00Z'; }, ['pauses[1]']],
  ])('%s is PAUSE_MALFORMED', (_, mutate, paths) => expect(planted(mutate)).toEqual(paths));
  test('pauses must be a list', () => {
    const dir = chain('1-parts-verdict');
    const p = read(dir); p.pauses = {}; save(dir, p);
    expect(checkProject(dir).refusals.map(f => [f.code, f.path])).toEqual([['PAUSE_MALFORMED', 'pauses']]);
  });
  test('a hand resume to another stage is still STAGE_SKIPPED, as before pauses[] existed', () => {
    const dir = chain('3-rig-review');
    signPaused(dir); pause(dir);
    const p = read(dir); p.stage = 'post-interview'; save(dir, p);
    const skipped = (): string[][] => {
      const report = checkProject(dir);
      return [...report.refusals.map(f => ['refusal', f.code]), ...report.warnings.map(f => ['warning', f.code])].filter(([, code]) => code === 'STAGE_SKIPPED');
    };
    // The example's events predate STAGE_PROGRESS_SINCE, so the hand move is dated by them and WARNs,
    // for the latest-move mismatch and for the signature window, exactly as without pauses[].
    const withPauses = skipped();
    expect(withPauses).toEqual([['warning', 'STAGE_SKIPPED'], ['warning', 'STAGE_SKIPPED']]);
    delete p.pauses; save(dir, p);
    expect(skipped()).toEqual(withPauses);
  });
});
