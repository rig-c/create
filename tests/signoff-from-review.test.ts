import { afterEach, expect, test } from 'bun:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentJobIdentity } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { decodeReviewAct } from '../src/review-act.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand as rawSignoff } from '../src/signoff.ts';
import { signoffIdentity } from '../src/stage-progress.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, signoffCommand, testClock } from './clock.ts';
import { arr, fixture, obj, retimeFixture } from './fixtures.ts';

afterEach(() => testClock.reset());
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
const codes = (dir: string): string[] => checkProject(dir).refusals.map(f => f.code);
const jobId = 'synthetic-signoff-job';
const words = '  좋아\r\n초안대로\n\n';

/** Synthetic finalized acts enter through the injected job fetch adapter, as the other --from-review routes do. */
function bindReview(dir: string): void {
  const identity = currentJobIdentity({ root: dir, stateDir: 'unused-private-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, dir);
  writePrivateJson(join(realpathSync(dir), JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId, origin: 'http://127.0.0.1:43123', fetchCapability: 'synthetic-read-grant' }, true);
  const project = read(dir); project.review_job = { jobId, origin: 'http://127.0.0.1:43123' }; save(dir, project);
}
function displayedPlan(dir: string): JsonObject {
  return { steps: arr(obj(read(dir).plan).steps).map(raw => ({ id: obj(raw).id!, hash: stepHash(obj(raw)) })) };
}
function signoffAct(dir: string, stage: string, actId: string, edit?: (act: JsonObject) => void): JsonObject {
  const act: JsonObject = { schema: 'rig-review/act@2', kind: 'signoff', jobId, actId, askId: 'synthetic-ask', publicationId: 'synthetic-publication',
    at: testClock.iso(), authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: { sourceHash: '1'.repeat(64), projectHash: '2'.repeat(64), package: { id: 'synthetic-package', revision: 'one' },
      selector: null, model: null, direction: null, optionSet: null, appliedResult: null,
      plan: ['plan-approved', 'rigging-interview', 'post-interview'].includes(stage) ? displayedPlan(dir) : null,
      parts: { enumeratorVersion: '2.34.0' } },
    value: { stage, decision: 'approved', words } };
  edit?.(act);
  return act;
}
function fromReview(dir: string, stage: string, act: JsonObject, extra: string[] = []): ReturnType<typeof rawSignoff> {
  return rawSignoff([stage, realpathSync(dir), '--from-review', String(act.actId), ...extra], testClock.now(), { fetch: transport => {
    expect(transport.kind).toBe('signoff'); expect(transport.jobId).toBe(jobId); expect(transport.actId).toBe(String(act.actId));
    return { bytes: JSON.stringify(act) };
  } });
}
function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  let got = 'NO_REFUSAL';
  try { action(); } catch (error) { if (!(error instanceof Refusal)) throw error; got = error.code; }
  expect(got).toBe(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test('a non-plan stage sign-off ingests the act and equals the flag route except for its named source', () => {
  const flags = fixture(); const act = fixture(); bindReview(act); bindReview(flags);
  writeFileSync(join(flags, 'words.txt'), words);
  signoffCommand(['interview', flags, '--by', 'user', '--verbatim-file', join(flags, 'words.txt')]);
  const recorded = signoffAct(act, 'interview', 'sign-interview');
  expect(fromReview(act, 'interview', recorded).exit).toBe(0);
  const fromFlags = obj(arr(read(flags).signoffs).at(-1)); const fromAct = obj(arr(read(act).signoffs).at(-1));
  expect(fromAct.source).toBe(`review act ${jobId}/sign-interview`);
  expect({ ...fromAct, source: undefined }).toEqual({ ...fromFlags, source: undefined });
  const receipt = obj(arr(read(act).review_acts).at(-1));
  expect(receipt).toMatchObject({ kind: 'signoff', jobId, actId: 'sign-interview', stage: 'interview', bytes: JSON.stringify(recorded), sha256: jobHash(JSON.stringify(recorded)) });
  expect(codes(act)).toEqual(codes(flags));
});

test('a plan-bound sign-off ingests with the displayed plan and refuses a stale one by name', () => {
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  const dir = fixture(); bindReview(dir);
  const stale = signoffAct(dir, 'plan-approved', 'sign-stale', act => {
    obj(arr(obj(obj(act.source).plan).steps)[0]).hash = 'f'.repeat(64);
  });
  refused(dir, 'REVIEW_ACT_SOURCE_STALE', () => fromReview(dir, 'plan-approved', stale));
  const reordered = signoffAct(dir, 'plan-approved', 'sign-reordered', act => { arr(obj(obj(act.source).plan).steps).reverse(); });
  refused(dir, 'REVIEW_ACT_SOURCE_STALE', () => fromReview(dir, 'plan-approved', reordered));
  const missing = signoffAct(dir, 'plan-approved', 'sign-missing', act => { obj(act.source).plan = null; });
  refused(dir, 'REVIEW_ACT_INVALID', () => fromReview(dir, 'plan-approved', missing));
  const act = signoffAct(dir, 'plan-approved', 'sign-plan');
  expect(fromReview(dir, 'plan-approved', act).exit).toBe(0);
  const signed = obj(arr(read(dir).signoffs).at(-1));
  expect(signed).toMatchObject({ stage: 'plan-approved', checkpoint: null, by: 'user', at: '2026-11-20T00:00:00.000Z', verbatim: words, source: `review act ${jobId}/sign-plan` });
  for (const raw of arr(obj(read(dir).plan).steps).map(obj).filter(step => step.phase === 'rig')) expect(obj(signed.step_hashes)[String(raw.id)]).toBe(stepHash(raw));
  expect(codes(dir)).toEqual([]);
  // A replay returns the recorded signoff; changed act bytes are a conflict.
  refused(dir, 'NO_REFUSAL', () => fromReview(dir, 'plan-approved', act));
  refused(dir, 'REVIEW_ACT_REPLAY_CONFLICT', () => fromReview(dir, 'plan-approved', { ...act, at: '2026-11-19T00:00:00.000Z' }));
});

test('the wrong act kind or stage refuses', () => {
  const dir = fixture(); bindReview(dir);
  refused(dir, 'REVIEW_ACT_KIND_MISMATCH', () => fromReview(dir, 'interview', signoffAct(dir, 'interview', 'sign-kind', act => { act.kind = 'checkpoint'; })));
  refused(dir, 'REVIEW_ACT_KIND_MISMATCH', () => fromReview(dir, 'interview', signoffAct(dir, 'rig-review', 'sign-stage')));
  refused(dir, 'REVIEW_ACT_INVALID', () => fromReview(dir, 'interview', signoffAct(dir, 'interview', 'sign-decision', act => { obj(act.value).decision = 'changes-requested'; })));
  refused(dir, 'REVIEW_ACT_INVALID', () => fromReview(dir, 'interview', signoffAct(dir, 'interview', 'sign-agent', act => { obj(act.authority).actor = 'agent'; })));
  expect(() => decodeReviewAct(JSON.stringify(signoffAct(dir, 'interview', 'sign-decode')), 'review-verdict')).toThrow(Refusal);
});

test.each(['--by', '--verbatim-file', '--steps'])('mixed human flag %s refuses', flag => {
  const dir = fixture(); bindReview(dir);
  refused(dir, 'SIGNOFF_OPTION_INVALID', () => fromReview(dir, 'interview', signoffAct(dir, 'interview', 'sign-mixed'), [flag, 'bones']));
});

test('check refuses a recorded signoff that differs from its retained act', () => {
  const dir = fixture(); bindReview(dir);
  fromReview(dir, 'interview', signoffAct(dir, 'interview', 'sign-ledger'));
  const p = read(dir); obj(arr(p.signoffs).at(-1)).verbatim = 'other words'; save(dir, p);
  expect(codes(dir)).toContain('REVIEW_ACT_LEDGER_INVALID');
});

test('advance after a review sign-off records the signoff it rests on and no words', () => {
  testClock.reset();
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 1);
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
    retimeFixture(p, testClock.now());
  });
  bindReview(dir);
  fromReview(dir, 'plan-approved', signoffAct(dir, 'plan-approved', 'sign-move'));
  expect(codes(dir)).toContain('STAGE_LAGGING');
  advanceCommand(['parts', dir]);
  const p = read(dir); const entry = obj(arr(p.advances).at(-1));
  expect(entry.signoff).toEqual(signoffIdentity(obj(arr(p.signoffs).at(-1))));
  expect(obj(arr(p.signoffs).at(-1)).source).toBe(`review act ${jobId}/sign-move`);
  expect('by' in entry || 'verbatim' in entry).toBe(false);
  expect(codes(dir)).toEqual([]);
});
