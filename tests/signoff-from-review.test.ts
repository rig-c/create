import { afterEach, expect, test } from 'bun:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_STEP_ANSWER_SINCE } from '../src/check.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { decodeReviewAct, reviewActSignoff, signoffActIdentity } from '../src/review-act.ts';
import { Refusal } from '../src/refusal.ts';
import { selectAnswerHashes } from '../src/signoff-answers.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { signoffCommand as rawSignoff } from '../src/signoff.ts';
import { signoffIdentity } from '../src/stage-progress.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, diffClassesCommand, signoffCommand, testClock, TEST_NOW } from './clock.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { arr, fixture, obj, plantLegacyReopen, retimeFixture, step, withdrawSignature } from './fixtures.ts';
import { preparePartsApproval } from './parts-receipt-fixture.ts';

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
function seedStoredSignoffAct(dir: string, act: JsonObject, extraFields: JsonObject = {}): JsonObject {
  const bytes = JSON.stringify(act);
  const decoded = decodeReviewAct(bytes, 'signoff');
  const p = read(dir);
  const stage = decoded.value.stage;
  const phase = stage === 'post-interview' ? 'post' : ['plan-approved', 'rigging-interview'].includes(stage) ? 'rig' : undefined;
  const steps = phase === undefined ? [] : arr(obj(p.plan).steps).map(obj).filter(s => s.phase === phase);
  const hashes: JsonObject = {};
  for (const step of steps) {
    if (step.checkpoint === null || step.checkpoint === undefined) {
      step.checkpoint = { delegated: false, by: 'user', at: decoded.at, verbatim: words, value: step.checkpoint_proposed };
    }
    hashes[String(step.id)] = stepHash(step);
  }
  const signed: JsonObject = {
    ...reviewActSignoff(decoded),
    ...(phase === undefined ? {} : { steps: steps.map(s => s.id!), step_hashes: hashes }),
    ...extraFields,
  };
  const answerHashes = selectAnswerHashes(dir, p, signed);
  if (answerHashes !== undefined) signed.answer_hashes = answerHashes;
  p.signoffs = [...arr(p.signoffs), signed];
  p.review_acts = [...arr(p.review_acts), {
    schema: 'rig-create/review-act@1',
    kind: 'signoff',
    jobId: decoded.jobId,
    actId: decoded.actId,
    stage,
    bytes,
    sha256: jobHash(bytes),
    version_hash: jobHash(JSON.stringify(signoffActIdentity(decoded))),
  }];
  save(dir, p);
  return signed;
}

function fromReview(dir: string, stage: string, act: JsonObject, extra: string[] = []): ReturnType<typeof rawSignoff> {
  return rawSignoff([stage, realpathSync(dir), '--from-review', String(act.actId), ...extra], testClock.now());
}
function refused(dir: string, code: string, action: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  let got = 'NO_REFUSAL';
  try { action(); } catch (error) { if (!(error instanceof Refusal)) throw error; got = error.code; }
  expect(got).toBe(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test('signoff --from-review refuses with SIGNOFF_FROM_REVIEW_REMOVED and exit 2 across stages and flag combinations', () => {
  const dir = fixture(); bindReview(dir);
  for (const [stage, extra] of [
    ['interview', []],
    ['plan-approved', []],
    ['rig-review', []],
    ['parts-review', ['--draft', 'receipt-fixture']],
    ['interview', ['--by', 'user']],
    ['interview', ['--verbatim-file', 'words.txt']],
    ['interview', ['--steps', 'bones']],
  ] as [string, string[]][]) {
    refused(dir, 'SIGNOFF_FROM_REVIEW_REMOVED', () => fromReview(dir, stage, signoffAct(dir, stage, 'sign-retired'), extra));
  }
});

test('a stored non-plan stage sign-off act equals the flag route except for its named source', () => {
  const flags = fixture(); const act = fixture(); bindReview(act); bindReview(flags);
  writeFileSync(join(flags, 'words.txt'), words);
  signoffCommand(['interview', flags, '--by', 'user', '--verbatim-file', join(flags, 'words.txt')]);
  const recorded = signoffAct(act, 'interview', 'sign-interview');
  seedStoredSignoffAct(act, recorded);
  const fromFlags = obj(arr(read(flags).signoffs).at(-1)); const fromAct = obj(arr(read(act).signoffs).at(-1));
  expect(fromAct.source).toBe(`review act ${jobId}/sign-interview`);
  expect({ ...fromAct, source: undefined }).toEqual({ ...fromFlags, source: undefined });
  const receipt = obj(arr(read(act).review_acts).at(-1));
  expect(receipt).toMatchObject({ kind: 'signoff', jobId, actId: 'sign-interview', stage: 'interview', bytes: JSON.stringify(recorded), sha256: jobHash(JSON.stringify(recorded)) });
  expect(codes(act)).toEqual(codes(flags));
});

test('#561 owner-chat signoff cannot use its candidate approval to settle an unsigned stale step', () => {
  const dir = fixture(() => {}, 'example-numbered/example-project.json');
  const stage = 'post-interview';
  testClock.set(TEST_NOW);
  plantLegacyReopen(dir, stage);
  const project = read(dir);
  const camera = step(project, 'camera');
  const originalDate = camera.drafted_at!;
  camera.drafted_at = PLAN_STEP_ANSWER_SINCE;
  save(dir, project);
  expect(checkProject(dir).refusals).toContainEqual(expect.objectContaining({
    code: 'PLAN_STEP_PREDATES_ANSWER', path: 'plan.steps[camera]',
  }));
  testClock.set(testClock.now() + 1_000);
  const wordsPath = join(dir, 'owner.txt');
  writeFileSync(wordsPath, words);
  refused(dir, 'PLAN_STEP_PREDATES_ANSWER', () => signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', wordsPath]));

  camera.drafted_at = originalDate;
  save(dir, project);
  expect(signoffCommand([stage, dir, '--by', 'user', '--verbatim-file', wordsPath]).exit).toBe(0);
});

test('decodeReviewAct rejects the wrong act kind or malformed decision/actor', () => {
  const dir = fixture(); bindReview(dir);
  expect(() => decodeReviewAct(JSON.stringify(signoffAct(dir, 'interview', 'sign-kind', act => { act.kind = 'checkpoint'; })), 'signoff'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_KIND_MISMATCH' }));
  expect(() => decodeReviewAct(JSON.stringify(signoffAct(dir, 'interview', 'sign-decision', act => { obj(act.value).decision = 'changes-requested'; })), 'signoff'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(() => decodeReviewAct(JSON.stringify(signoffAct(dir, 'interview', 'sign-agent', act => { obj(act.authority).actor = 'agent'; })), 'signoff'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(() => decodeReviewAct(JSON.stringify(signoffAct(dir, 'plan-approved', 'sign-missing', act => { obj(act.source).plan = null; })), 'signoff'))
    .toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(() => decodeReviewAct(JSON.stringify(signoffAct(dir, 'interview', 'sign-decode')), 'review-verdict')).toThrow(Refusal);
});

test('check refuses a recorded signoff that differs from its retained act', () => {
  const dir = fixture(); bindReview(dir);
  seedStoredSignoffAct(dir, signoffAct(dir, 'interview', 'sign-ledger'));
  const p = read(dir); obj(arr(p.signoffs).at(-1)).verbatim = 'other words'; save(dir, p);
  expect(codes(dir)).toContain('REVIEW_ACT_LEDGER_INVALID');
});

test('advance after a stored review sign-off records the signoff it rests on and no words', () => {
  testClock.reset();
  const dir = fixture(p => {
    p.stage = 'plan-approved'; p.versions = []; p.signoffs = arr(p.signoffs).slice(0, 1);
    for (const raw of arr(obj(p.plan).steps)) obj(raw).status = 'pending';
    retimeFixture(p, testClock.now());
  });
  bindReview(dir);
  seedStoredSignoffAct(dir, signoffAct(dir, 'plan-approved', 'sign-move'));
  expect(codes(dir)).toEqual([]);
  advanceCommand(['parts', dir]);
  const p = read(dir); const entry = obj(arr(p.advances).at(-1));
  expect(entry.signoff).toEqual(signoffIdentity(obj(arr(p.signoffs).at(-1))));
  expect(obj(arr(p.signoffs).at(-1)).source).toBe(`review act ${jobId}/sign-move`);
  expect('by' in entry || 'verbatim' in entry).toBe(false);
  expect(codes(dir)).toEqual([]);
});

/** A rig-review sign-off fixture whose live signature is withdrawn, so the act's version is signable again. */
function rigReview(): string {
  const dir = fixture(); bindReview(dir);
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  testClock.set(new Date(withdrawSignature(dir, 'rig-review')));
  return dir;
}
const rigAct = (dir: string, actId: string, selector: JsonObject | null): JsonObject => signoffAct(dir, 'rig-review', actId, act => { obj(act.source).selector = selector; });

test('check refuses a review signature whose recorded target version differs from its act', () => {
  const dir = rigReview();
  const target = selectSignoffTarget(dir, read(dir), 'rig-review', '2')!;
  seedStoredSignoffAct(dir, rigAct(dir, 'sign-tamper', { kind: 'rig', version: 2 }), { target });
  expect(codes(dir)).not.toContain('REVIEW_ACT_LEDGER_INVALID');
  const p = read(dir); obj(obj(arr(p.signoffs).at(-1)).target).version = 1; save(dir, p);
  expect(codes(dir)).toContain('REVIEW_ACT_LEDGER_INVALID');
});

const partsDiffFlags = ['--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:synthetic painting', '--component', 'p1000-n3=in-painting:synthetic painting'];
test('signoff parts-review rejects removed diff flags and numbered --draft / --from-review', () => {
  const dir = fixture();
  preparePartsApproval(dir, testClock.now());
  testClock.set(new Date('2026-11-20T00:00:00Z'));
  testClock.set(new Date(withdrawSignature(dir, 'parts-review')));
  refused(dir, 'SIGNOFF_DIFF_MAP_REMOVED', () => rawSignoff(['parts-review', realpathSync(dir), ...partsDiffFlags], testClock.now()));
  refused(dir, 'SIGNOFF_FROM_REVIEW_REMOVED', () => fromReview(dir, 'parts-review', signoffAct(dir, 'parts-review', 'sign-parts')));
});
