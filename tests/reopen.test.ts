import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectSignoffs } from '../src/check.ts';
import { OWNER_CHAT_SOURCE, REOPEN_RESTART_OWNER_CHAT_SINCE } from '../src/owner-chat.ts';
import { collectReopens, liveSignoff } from '../src/reopen.ts';
import { readVersions, latestAccepted } from '../src/review.ts';
import { jobHash } from '../src/job-outbox.ts';
import { reviewActFindings } from '../src/review-act.ts';
import { stepHash } from '../src/step-hash.ts';
import { Refusal } from '../src/refusal.ts';
import { fixture, arr, obj, step, version, plantLegacyReopen } from './fixtures.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, handoff, testClock } from './clock.ts';

const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2));
function words(dir: string): string { const p = join(dir, 'words.txt'); writeFileSync(p, '\uFEFFRevisit the synthetic parts.\r\n'); return p; }
function reopen(dir: string, stage = 'parts'): void { plantLegacyReopen(dir, stage, { wordsFile: words(dir) }); }
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
function refusal(fn: () => unknown, code: string): void {
  try { fn(); throw new Error('expected refusal'); } catch (e) { expect(e).toBeInstanceOf(Refusal); expect((e as Refusal).code).toBe(code); }
}

describe('legacy stage reopen history', () => {
  beforeEach(() => testClock.set(new Date('2026-11-20T00:00:00Z')));
  afterEach(() => testClock.reset());

  test('a historic status snapshot preserves superseded approvals and plan hashes', () => {
    const dir = fixture(p => { p.stage = 'post'; p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'direction-review'); });
    const before = read(dir);
    const hashes = arr(obj(before.plan).steps).map(s => stepHash(obj(s)));
    reopen(dir);
    const p = read(dir);
    expect(p.stage).toBe('parts');
    expect(p.signoffs).toEqual(before.signoffs);
    expect(p.versions).toEqual(before.versions);
    const entry = obj(arr(p.reopens)[0]);
    expect(entry).toMatchObject({ stage: 'parts', by: 'owner', at: '2026-11-20T00:00:00.000Z',
      source: OWNER_CHAT_SOURCE, verbatim: '\uFEFFRevisit the synthetic parts.\r\n',
      said_at: '2026-11-20T00:00:00.000Z', relayed_by: 'synthetic-relay' });
    expect(entry.steps_before).toEqual(arr(obj(before.plan).steps).map(s => ({ id: obj(s).id, status: obj(s).status })));
    expect(arr(obj(p.plan).steps).every(s => obj(s).status === 'pending')).toBe(true);
    expect(arr(obj(p.plan).steps).map(s => stepHash(obj(s)))).toEqual(hashes);
    for (const raw of arr(p.signoffs)) {
      const signed = obj(raw);
      if (signed.step_hashes === undefined) continue;
      for (const [id, hash] of Object.entries(obj(signed.step_hashes))) expect(stepHash(step(p, id))).toBe(hash as string);
    }
    expect(codes(dir)).toEqual([]);
    expect(checkProject(dir).warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY',
      ...Array<string>(5).fill('REOPEN_SIGNOFF_LAPSED'), 'REOPEN_VERDICT_LAPSED', 'REOPEN_VERDICT_LAPSED']);
    step(p, 'bones').status = 'done'; save(dir, p);
    expect(codes(dir)).toContain('PARTS_REVIEW_UNSIGNED');
  });

  test('ahead signatures are valid with a historical stage witness', () => {
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

  test('legacy authority warns before the cutoff and refuses invalid records at the cutoff', () => {
    const dir = fixture();
    const cutoff = Date.parse(REOPEN_RESTART_OWNER_CHAT_SINCE);
    testClock.set(cutoff - 1);
    reopen(dir);
    const p = read(dir);
    const entry = obj(arr(p.reopens)[0]);
    delete entry.source;
    delete entry.said_at;
    delete entry.relayed_by;
    save(dir, p);
    testClock.set(cutoff);
    expect(checkProject(dir).warnings).toContainEqual(expect.objectContaining({ code: 'OWNER_CHAT_REQUIRED', path: 'reopens[0]' }));
    expect(collectReopens(read(dir), [])).toHaveLength(1);
    entry.at = REOPEN_RESTART_OWNER_CHAT_SINCE;
    entry.source = 'review act synthetic-job/synthetic-act';
    save(dir, p);
    expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({ code: 'OWNER_CHAT_REQUIRED', path: 'reopens[0]' }));
    expect(collectReopens(p, [])).toEqual([]);
    entry.source = OWNER_CHAT_SOURCE;
    save(dir, p);
    expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({ code: 'OWNER_CHAT_INVALID', path: 'reopens[0]' }));
    expect(collectReopens(p, [])).toEqual([]);
  });

  test('legacy eligibility uses from_stage and only witnesses reached at the recorded instant', () => {
    const at = '2026-11-20T00:00:00.000Z';
    const witness = { kind: 'rig', at };
    const findings = (stage: string, fromStage: string, time = at): string[] => {
      const refusals: Parameters<typeof collectReopens>[1] = [];
      collectReopens({ stage: 'accepted', versions: [witness], reopens: [{
        stage, from_stage: fromStage, at: time, by: 'user', verbatim: 'Revisit the synthetic stage.', steps_before: [],
        source: OWNER_CHAT_SOURCE, said_at: time, relayed_by: 'synthetic-relay',
      }] }, refusals);
      return refusals.map(f => f.code);
    };
    const earlier = '2026-11-19T23:59:59.999Z';
    expect(findings('parts', 'parts', earlier)).toEqual([]);
    expect(findings('rigging', 'parts', earlier)).toEqual(['REOPEN_NOT_PASSED']);
    expect(findings('rigging', 'parts')).toEqual([]);
    expect(findings('accepted', 'accepted')).toEqual(['REOPEN_STAGE_UNKNOWN']);
    expect(findings('paused', 'parts')).toEqual(['REOPEN_STAGE_UNKNOWN']);
    expect(findings('parts', 'unknown')).toEqual(['REOPEN_MALFORMED']);
  });

  test.each(['reopen', 'reopen-empty'])('an already recorded Review %s act is valid and only a matching receipt lapses approvals', name => {
    const dir = fixture(p => { p.stage = 'post'; p.signoffs = arr(p.signoffs).filter(s => obj(s).stage !== 'direction-review'); });
    const bytes = readFileSync(join(import.meta.dir, 'fixtures/record-acts', name + '.json'), 'utf8').trimEnd();
    const act = JSON.parse(bytes) as JsonObject;
    plantLegacyReopen(dir, 'parts', { by: 'synthetic-owner', at: String(act.at) });
    const p = read(dir);
    const entry = obj(arr(p.reopens)[0]);
    entry.verbatim = obj(act.value).words!;
    entry.source = 'review act ' + String(act.jobId) + '/' + String(act.actId);
    delete entry.said_at;
    delete entry.relayed_by;
    p.review_acts = [{ schema: 'rig-create/review-act@1', kind: 'reopen', jobId: act.jobId!, actId: act.actId!, reopen: 0,
      bytes, sha256: jobHash(bytes), version_hash: jobHash(JSON.stringify(entry)) }];
    save(dir, p);

    expect(entry).toMatchObject({ stage: 'parts', by: 'synthetic-owner', at: act.at!, verbatim: obj(act.value).words! });
    expect(arr(obj(p.plan).steps).map(s => obj(s).status)).toEqual(arr(obj(p.plan).steps).map(() => 'pending'));
    expect(reviewActFindings(p)).toEqual([]);
    expect(codes(dir)).toEqual([]);
    expect(collectReopens(p, [])).toHaveLength(1);
    expect(checkProject(dir).warnings.map(f => f.code)).toContain('REOPEN_SIGNOFF_LAPSED');

    entry.verbatim = 'different words';
    save(dir, p);
    expect(reviewActFindings(p).map(row => row.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
    expect(codes(dir)).toContain('REVIEW_ACT_LEDGER_INVALID');
    expect(collectReopens(p, [])).toEqual([]);
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
    p.reopens = {}; save(dir, p);
    expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({ code: 'REOPEN_MALFORMED', path: 'reopens' }));
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


});
