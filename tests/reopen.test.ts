import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSignoffs } from '../src/check.ts';
import { collectReopens, liveSignoff } from '../src/reopen.ts';
import { readVersions, latestAccepted } from '../src/review.ts';
import { stepHash } from '../src/step-hash.ts';
import { Refusal } from '../src/refusal.ts';
import { fixture, arr, obj, step, version } from './fixtures.ts';
import { cli, clockedCli, gitEnv } from './helpers.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, reopenCommand, handoff, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2));
function words(dir: string): string { const p = join(dir, 'words.txt'); writeFileSync(p, '\uFEFFRevisit the synthetic parts.\r\n'); return p; }
function reopen(dir: string, stage = 'parts'): void { reopenCommand([stage, dir, '--by', 'owner', '--verbatim-file', words(dir), '--source', 'synthetic relay']); }
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
function refusal(fn: () => unknown, code: string): void {
  try { fn(); throw new Error('expected refusal'); } catch (e) { expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe(code); }
}

describe('human stage reopen', () => {
  beforeEach(() => testClock.set(new Date('2026-11-20T00:00:00Z')));
  afterEach(() => testClock.reset());

  test('one write moves the stage, snapshots then resets statuses, and preserves history and plan hashes', () => {
    const dir = fixture(p => { p.stage = 'post'; p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'direction-review'); });
    const before = read(dir);
    const hashes = arr(obj(before.plan).steps).map(s => stepHash(obj(s)));
    reopen(dir);
    const p = read(dir);
    expect(p.stage).toBe('parts');
    expect(p.signoffs).toEqual(before.signoffs);
    expect(p.versions).toEqual(before.versions);
    const entry = obj(arr(p.reopens)[0]);
    expect(entry).toMatchObject({ stage: 'parts', by: 'owner', at: '2026-11-20T00:00:00.000Z', source: 'synthetic relay', verbatim: '\uFEFFRevisit the synthetic parts.\r\n' });
    expect(entry.steps_before).toEqual(arr(obj(before.plan).steps).map(s => ({ id: obj(s).id, status: obj(s).status })));
    expect(arr(obj(p.plan).steps).every(s => obj(s).status === 'pending')).toBe(true);
    expect(arr(obj(p.plan).steps).map(s => stepHash(obj(s)))).toEqual(hashes);
    for (const raw of arr(p.signoffs)) {
      const signed = obj(raw);
      if (signed.step_hashes === undefined) continue;
      for (const [id, hash] of Object.entries(obj(signed.step_hashes))) expect(stepHash(step(p, id))).toBe(hash as string);
    }
    expect(codes(dir)).toEqual([]);
    expect(checkProject(dir).warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY',
      ...Array<string>(5).fill('REOPEN_SIGNOFF_LAPSED'), 'REOPEN_VERDICT_LAPSED', 'REOPEN_VERDICT_LAPSED']);
    step(p, 'bones').status = 'done'; save(dir, p);
    expect(codes(dir)).toContain('PARTS_REVIEW_UNSIGNED');
  });

  test('ahead signatures refuse before reopen; witness-shaped synthetic record passes after', () => {
    const dir = fixture(p => { p.stage = 'parts'; p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'direction-review'); });
    expect(codes(dir)).toContain('SIGNOFF_AHEAD_OF_STAGE');
    reopen(dir);
    expect(codes(dir)).toEqual([]);
  });

  test('forward movement requires fresh signoffs; old signoffs never count', () => {
    const dir = fixture(); reopen(dir);
    const p = read(dir); p.stage = 'post'; save(dir, p);
    expect(codes(dir)).toContain('STAGE_UNSIGNED');
    expect(codes(dir)).toContain('PARTS_REVIEW_UNSIGNED');
    refusal(() => handoff(dir, null), 'RIG_REVIEW_UNSIGNED');
  });

  test('old accepted rig is history even with a fresh verdict; new rig is required', () => {
    const dir = fixture(); reopen(dir);
    const p = read(dir); const v = version(p, 2);
    arr(v.verdicts).push({ by: 'owner', at: '2026-11-21T00:00:00Z', review: 'rig-review', verdict: 'accepted', verbatim: 'yes' });
    expect(readVersions(p).rigs.find(r => r.n === 2)?.accepted).not.toBeNull();
    expect(latestAccepted(readVersions(p))).toBeNull();
    const v5 = structuredClone(v); v5.n = 5; v5.at = '2026-11-21T00:00:00Z'; arr(p.versions).push(v5);
    expect(latestAccepted(readVersions(p))?.n).toBe(5);
    arr(p.signoffs).push({ stage: 'rig-review', checkpoint: null, by: 'owner', at: '2026-11-22T00:00:00Z', verbatim: 'yes' }); save(dir, p);
    expect(handoff(dir, null).rig_version).toBe(5);
  });

  test('reopening post does not invalidate the rig handoff', () => {
    const dir = fixture(); reopen(dir, 'post'); expect(handoff(dir, null).rig_version).toBe(2);
    expect(codes(dir)).toEqual([]);
  });

  test('multiple reopens use dates without resurrecting an earlier invalidation', () => {
    const dir = fixture(); reopen(dir);
    const p = read(dir);
    arr(p.signoffs).push({ stage: 'parts-review', by: 'owner', at: '2026-11-21T00:00:00Z', verbatim: 'yes', checkpoint: null });
    // The stage stays where the first reopen left it: a hand move would leave the second reopen unlinked.
    for (const id of ['seethrough', 'assemble']) step(p, id).status = 'done';
    arr(p.signoffs).push({ stage: 'parts', checkpoint: 'assemble', by: 'owner', at: '2026-11-21T00:00:00Z', verbatim: 'yes' });
    save(dir, p);
    testClock.set(new Date('2026-11-22T00:00:00Z')); reopen(dir, 'parts-review');
    const r = read(dir); const reopens = collectReopens(r, []);
    const live = collectSignoffs(r, []).filter(s => liveSignoff(reopens, s.stage, s.at));
    expect(live.some(s => s.stage === 'parts-review')).toBe(false);
    expect(live.some(s => s.stage === 'post-interview')).toBe(false);
    expect(live.some(s => s.stage === 'plan-approved')).toBe(true);
  });

  test.each(['agent', 'AGENT'])('planted %s reopen is refused and grants no supersession', by => {
    const dir = fixture(p => { p.stage = 'parts'; p.reopens = [{ stage: 'parts', from_stage: 'post', by, at: '2026-11-20T00:00:00Z', verbatim: 'no', steps_before: [] }]; });
    expect(codes(dir)).toContain('SIGNOFF_NOT_HUMAN');
    expect(codes(dir)).toContain('SIGNOFF_AHEAD_OF_STAGE');
    refusal(() => handoff(dir, null), 'SIGNOFF_NOT_HUMAN');
  });

  test.each([['unknown', 'REOPEN_STAGE_UNKNOWN'], ['paused', 'REOPEN_STAGE_UNKNOWN'], ['accepted', 'REOPEN_STAGE_UNKNOWN'], ['direction-review', 'REOPEN_NOT_PASSED']])('refuses target %s without writing', (target, code) => {
    const dir = fixture(p => { p.stage = 'interview'; p.signoffs = []; p.versions = []; });
    const before = readFileSync(join(dir, 'project.json'));
    refusal(() => reopenCommand([target, dir, '--by', 'owner', '--verbatim-file', words(dir)]), code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  });

  test('agent signer, malformed history and invalid UTF-8 leave bytes intact', () => {
    const dir = fixture(); const file = words(dir); const before = readFileSync(join(dir, 'project.json'));
    refusal(() => reopenCommand(['parts', dir, '--by', 'agent']), 'SIGNOFF_NOT_HUMAN');
    writeFileSync(file, Buffer.from([255]));
    refusal(() => reopenCommand(['parts', dir, '--by', 'owner', '--verbatim-file', file]), 'VERBATIM_INVALID_UTF8');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    const p = read(dir); p.reopens = {}; save(dir, p);
    const malformed = readFileSync(join(dir, 'project.json'));
    refusal(() => reopen(dir), 'REOPEN_MALFORMED');
    expect(readFileSync(join(dir, 'project.json'))).toEqual(malformed);
  });

  test('equal/earlier signoff dates are superseded, strictly later signatures are live', () => {
    const dir = fixture(); reopen(dir);
    const p = read(dir);
    const reopenHistory = collectReopens(p, []);
    expect(liveSignoff(reopenHistory, 'rig-review', Date.parse('2026-11-19T00:00:00Z'))).toBe(false);
    expect(liveSignoff(reopenHistory, 'rig-review', Date.parse('2026-11-20T00:00:00Z'))).toBe(false);
    expect(liveSignoff(reopenHistory, 'rig-review', Date.parse('2026-11-20T00:00:00.001Z'))).toBe(true);
    expect(liveSignoff(reopenHistory, 'rig-review', NaN)).toBe(false);
  });

  test('new post cannot use an accepted historical rig, while historical posts remain valid', () => {
    const dir = fixture(); reopen(dir);
    const p = read(dir);
    expect(codes(dir)).toEqual([]);
    const post = structuredClone(version(p, 4)); post.n = 5; post.at = '2026-11-21T00:00:00Z'; arr(p.versions).push(post); save(dir, p);
    expect(codes(dir)).toContain('POST_ON_SUPERSEDED_RIG');
  });

  test('superseded malformed signatures remain structurally checked', () => {
    const dir = fixture(); reopen(dir);
    const p = read(dir);
    arr(p.signoffs).push({ stage: 'rigging', checkpoint: 'missing', by: 'owner', at: '2026-11-19T00:00:00Z', verbatim: 'yes' });
    save(dir, p);
    expect(codes(dir)).toContain('SIGNOFF_UNKNOWN_CHECKPOINT');
  });

  test('planted unreachable and malformed reopens are refused by the shared validator', () => {
    const dir = fixture(p => { p.stage = 'interview'; p.signoffs = []; p.versions = [];
      p.reopens = [{ stage: 'post', from_stage: 'interview', by: 'owner', at: '2026-11-20T00:00:00Z', verbatim: 'yes', steps_before: [] }]; });
    expect(codes(dir)).toContain('REOPEN_NOT_PASSED');
    const p = read(dir); obj(arr(p.reopens)[0]).at = 'invalid'; save(dir, p);
    expect(codes(dir)).toContain('REOPEN_MALFORMED');
  });

  test('reopening rigging then parts preserves the first reopen reach without a rig version', () => {
    const dir = fixture(p => {
      p.stage = 'rigging'; p.versions = [];
      p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts', 'parts-review'].includes(String(obj(s).stage)));
      for (const s of arr(obj(p.plan).steps)) if (obj(s).phase === 'post') obj(s).status = 'pending';
    });
    reopen(dir, 'rigging');
    testClock.set(new Date('2026-11-21T00:00:00Z'));
    reopen(dir, 'parts');
    const p = read(dir);
    expect(arr(p.reopens).map(r => obj(r).from_stage)).toEqual(['rigging', 'rigging']);
    expect(collectReopens(p, [])).toHaveLength(2);
    expect(checkProject(dir).refusals).toEqual([]);
  });

  test('a planted from_stage cannot borrow reach from the later current stage', () => {
    const dir = fixture(p => {
      p.stage = 'post'; p.versions = []; p.signoffs = [];
      p.reopens = [{ stage: 'rigging', from_stage: 'parts', by: 'owner', at: '2026-11-20T00:00:00Z', verbatim: 'yes', steps_before: [] }];
    });
    expect(codes(dir)).toContain('REOPEN_NOT_PASSED');
  });

  test('a candidate refusal the record already carries does not block the reopen, and check still reports it', () => {
    const dir = fixture(p => { step(p, 'assemble').rests_on = []; });
    expect(codes(dir)).toContain('STEP_NO_BASIS');
    reopen(dir);
    expect(read(dir).stage).toBe('parts');
    expect(codes(dir)).toContain('STEP_NO_BASIS');
  });

  test('CLI stdin and help; user clock and repeated arguments are refused', () => {
    const dir = fixture(); const bytes = Buffer.from('\uFEFFSynthetic words\r\n');
    const result = Bun.spawnSync([process.execPath, ...clockedCli(),
      'reopen', 'parts', dir, '--by', 'owner', '--json'], { stdin: bytes, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(obj(arr(read(dir).reopens)[0]).verbatim as string)).toEqual(bytes);
    expect(cli(['--help'], dir, gitEnv()).stdout).toContain('rig-create reopen');
    expect(cli(['reopen', 'parts', '--by', 'owner', '--at', '2026-11-20'], dir, gitEnv()).code).toBe(2);
    refusal(() => reopenCommand(['parts', dir, '--by', 'owner', '--by', 'owner']), 'REOPEN_OPTION_INVALID');
  });
});
