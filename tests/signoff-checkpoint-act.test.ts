import { afterEach, expect, test } from 'bun:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { decodeReviewAct, reviewActFindings } from '../src/review-act.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand as rawSignoff } from '../src/signoff.ts';
import type { SignoffHooks } from '../src/signoff-checkpoint-act.ts';
import { stepHash } from '../src/step-hash.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { arr, fixture, obj } from './fixtures.ts';
import { clockedCli, gitEnv } from './helpers.ts';

afterEach(() => testClock.reset());
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
const JOB = 'synthetic-checkpoint-job';
const ORIGIN = 'http://127.0.0.1:43124';
const WORDS = '  Synthetic pass, 좋아.\r\n';

/** A project whose enabled `constraints` checkpoint is unsigned, bound to a synthetic live job. */
function bound(): { dir: string; at: string } {
  let at = '';
  const dir = realpathSync(fixture((p) => {
    at = String(obj(arr(p.signoffs).find((s) => obj(s).checkpoint === 'constraints')).at);
    p.signoffs = arr(p.signoffs).filter((s) => obj(s).checkpoint !== 'constraints');
  }));
  const identity = currentJobIdentity({ root: dir, stateDir: 'unused-private-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, dir);
  writePrivateJson(join(dir, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId: JOB, origin: ORIGIN, fetchCapability: 'synthetic-read-grant' }, true);
  const p = load(dir);
  p.review_job = { jobId: JOB, origin: ORIGIN };
  save(dir, p);
  return { dir, at };
}

/** A finalized act@2 the way Review's daemon builds it: planStepId copied from the ask, plan identity displayed. */
function checkpointAct(dir: string, at: string, value: Partial<Record<'checkpointId' | 'planStepId' | 'outcome' | 'words', string>> = {}, actId = 'checkpoint-act-1'): JsonObject {
  const steps = arr(obj(load(dir).plan).steps).map((raw) => ({ id: obj(raw).id, hash: stepHash(obj(raw)) }));
  return { schema: 'rig-review/act@2', kind: 'checkpoint', jobId: JOB, actId, askId: 'synthetic-ask', publicationId: 'synthetic-publication', at,
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: { sourceHash: '1'.repeat(64), projectHash: '2'.repeat(64), package: { id: 'synthetic-package', revision: 'one' },
      selector: null, model: null, direction: null, optionSet: null, appliedResult: null, plan: { steps }, parts: { enumeratorVersion: '2.30.1' } },
    value: { checkpointId: 'constraints', planStepId: 'constraints', outcome: 'pass', words: WORDS, ...value } };
}

function served(act: JsonObject, calls: string[] = []): SignoffHooks {
  return { fetch: (transport) => {
    expect(transport).toMatchObject({ jobId: JOB, kind: 'checkpoint', fetchCapability: 'synthetic-read-grant' });
    calls.push(transport.actId);
    return { bytes: JSON.stringify(act) };
  } };
}

function ingest(dir: string, act: JsonObject, extra: string[] = [], stage = 'rigging', id = 'constraints', calls: string[] = []) {
  return rawSignoff([stage, dir, '--checkpoint', id, '--from-review', String(act.actId), ...extra], testClock.now(), served(act, calls));
}

/** Every refusal names its code and leaves project.json byte-identical. */
function refused(dir: string, action: () => unknown): Refusal {
  const before = readFileSync(join(dir, 'project.json'));
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  return caught as Refusal;
}

test('a passed checkpoint act records the checkpoint sign-off and its receipt, checks clean and replays without writing', () => {
  const { dir, at } = bound();
  expect(checkProject(dir).refusals.map((r) => r.code)).toContain('CHECKPOINT_UNSIGNED');
  const act = checkpointAct(dir, at);
  const result = ingest(dir, act, ['--json']);
  expect(result.exit).toBe(0);
  const p = load(dir);
  const index = arr(p.signoffs).length - 1;
  const signed = obj(arr(p.signoffs)[index]);
  expect(signed).toMatchObject({ stage: 'rigging', checkpoint: 'constraints', by: 'user', at, source: `review act ${JOB}/checkpoint-act-1` });
  expect(Buffer.from(String(signed.verbatim))).toEqual(Buffer.from(WORDS));
  const receipt = obj(arr(p.review_acts).at(-1));
  const bytes = JSON.stringify(act);
  expect(receipt).toEqual({ schema: 'rig-create/review-act@1', kind: 'checkpoint', jobId: JOB, actId: 'checkpoint-act-1', checkpoint: 'constraints',
    signoff: index, bytes, sha256: jobHash(bytes), version_hash: stepHash(obj(arr(obj(p.plan).steps).find((s) => obj(s).id === 'constraints'))) });
  expect(reviewActFindings(p)).toEqual([]);
  expect(checkProject(dir).refusals).toEqual([]);
  const before = readFileSync(join(dir, 'project.json'));
  const replay = ingest(dir, act, ['--json']);
  expect(replay.exit).toBe(0);
  expect(JSON.parse(replay.stdout)).toEqual(signed);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('a failed checkpoint act refuses by name and writes nothing', () => {
  const { dir, at } = bound();
  expect(refused(dir, () => ingest(dir, checkpointAct(dir, at, { outcome: 'fail' }))).code).toBe('REVIEW_ACT_CHECKPOINT_FAILED');
  expect(load(dir).review_acts).toBeUndefined();
});

test.each([
  ['checkpointId', { checkpointId: 'displayed-alias' }],
  ['planStepId', { checkpointId: 'motion', planStepId: 'motion' }],
])('a mismatched %s refuses by name', (_field, value) => {
  const { dir, at } = bound();
  expect(refused(dir, () => ingest(dir, checkpointAct(dir, at, value))).code).toBe('REVIEW_ACT_CHECKPOINT_MISMATCH');
});

test.each([['rigging', 'bones'], ['rigging', 'camera'], ['plan-approved', 'constraints']])('%s checkpoint %s is not an enabled checkpoint of that stage and refuses before fetching', (stage, id) => {
  const { dir, at } = bound();
  const calls: string[] = [];
  expect(refused(dir, () => ingest(dir, checkpointAct(dir, at, { checkpointId: id, planStepId: id }), [], stage, id, calls)).code).toBe('SIGNOFF_CHECKPOINT_INVALID');
  expect(calls).toEqual([]);
});

test('an act of another kind refuses by name', () => {
  const { dir, at } = bound();
  const act = { ...checkpointAct(dir, at), kind: 'interview-picks' };
  expect(refused(dir, () => ingest(dir, act)).code).toBe('REVIEW_ACT_KIND_MISMATCH');
});

test('a changed displayed plan, a malformed value, a foreign identity or a future date refuses by name', () => {
  const { dir, at } = bound();
  const stale = checkpointAct(dir, at);
  obj(arr(obj(obj(stale.source).plan).steps)[0]).hash = '3'.repeat(64);
  expect(refused(dir, () => ingest(dir, stale)).code).toBe('REVIEW_ACT_SOURCE_STALE');
  expect(refused(dir, () => ingest(dir, checkpointAct(dir, at, { outcome: 'pending' }))).code).toBe('REVIEW_ACT_INVALID');
  expect(refused(dir, () => ingest(dir, checkpointAct(dir, at, { planStepId: 'not-in-plan', checkpointId: 'not-in-plan' }))).code).toBe('REVIEW_ACT_INVALID');
  expect(refused(dir, () => ingest(dir, { ...checkpointAct(dir, at), jobId: 'other-job' })).code).toBe('REVIEW_ACT_INVALID');
  expect(refused(dir, () => ingest(dir, checkpointAct(dir, new Date(testClock.now() + 60_000).toISOString()))).code).toBe('REVIEW_ACT_INVALID');
});

test.each([
  [['--by', 'user']],
  [['--verbatim-file', 'words.txt']],
])('human-value flag %p refuses with --from-review before fetching', (extra) => {
  const { dir, at } = bound();
  const calls: string[] = [];
  const error = refused(dir, () => ingest(dir, checkpointAct(dir, at), extra, 'rigging', 'constraints', calls));
  expect(error).toMatchObject({ code: 'SIGNOFF_OPTION_INVALID', exitCode: 2 });
  expect(calls).toEqual([]);
});

test('--from-review without --checkpoint takes the stage sign-off route, so a checkpoint act there is the wrong kind', () => {
  const { dir, at } = bound();
  const kinds: string[] = [];
  const hooks: SignoffHooks = { fetch: transport => { kinds.push(String(transport.kind)); return { bytes: JSON.stringify(checkpointAct(dir, at)) }; } };
  expect(refused(dir, () => rawSignoff(['rigging', dir, '--from-review', 'checkpoint-act-1'], testClock.now(), hooks))).toMatchObject({ code: 'REVIEW_ACT_KIND_MISMATCH' });
  expect(kinds).toEqual(['signoff']);
});

test('--steps refuses with --from-review on the checkpoint route before fetching', () => {
  const { dir, at } = bound();
  const calls: string[] = [];
  const error = refused(dir, () => ingest(dir, checkpointAct(dir, at), ['--steps', 'constraints'], 'rigging', 'constraints', calls));
  expect(error).toMatchObject({ code: 'SIGNOFF_OPTION_INVALID', exitCode: 2 });
  expect(calls).toEqual([]);
});

test('check refuses a tampered sign-off, a failed act behind a receipt and a second act receipt on the same sign-off', () => {
  const { dir, at } = bound();
  expect(ingest(dir, checkpointAct(dir, at)).exit).toBe(0);
  const recorded = load(dir);
  const codes = (p: JsonObject) => reviewActFindings(p).map((f) => f.code);
  const words = structuredClone(recorded);
  obj(arr(words.signoffs).at(-1)).verbatim = 'edited words';
  expect(codes(words)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const failed = structuredClone(recorded);
  const receipt = obj(arr(failed.review_acts).at(-1));
  const act = decodeReviewAct(String(receipt.bytes), 'checkpoint');
  receipt.bytes = JSON.stringify({ ...act, value: { ...act.value, outcome: 'fail' } });
  receipt.sha256 = jobHash(String(receipt.bytes));
  expect(codes(failed)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const twice = structuredClone(recorded);
  const copy: JsonObject = { ...obj(arr(twice.review_acts).at(-1)), actId: 'checkpoint-act-2' };
  copy.bytes = JSON.stringify({ ...JSON.parse(String(copy.bytes)), actId: 'checkpoint-act-2' });
  copy.sha256 = jobHash(String(copy.bytes));
  twice.review_acts = [...arr(twice.review_acts), copy];
  expect(codes(twice)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
});

test('the CLI fetches the checkpoint act through the job API binding and records it', async () => {
  const { dir, at } = bound();
  const act = checkpointAct(dir, at);
  const requests: JsonObject[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as JsonObject;
    requests.push({ ...body, accept: request.headers.get('accept'), authorization: request.headers.get('authorization') });
    return Response.json({ schema: 'rig-review/job-api@2', verb: 'fetch-act', ok: true, jobId: JOB, requestId: body.requestId, value: act });
  } });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const binding = JSON.parse(readFileSync(join(dir, JOB_BINDING_FILE), 'utf8')) as JsonObject;
    writePrivateJson(join(dir, JOB_BINDING_FILE), { ...binding, origin }, true);
    const p = load(dir);
    p.review_job = { jobId: JOB, origin };
    save(dir, p);
    const child = Bun.spawn([process.execPath, ...clockedCli(), 'signoff', 'rigging', dir, '--checkpoint', 'constraints', '--from-review', 'checkpoint-act-1'],
      { cwd: dir, env: gitEnv(), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
    expect(stdout).toContain('signoff: recorded rigging by user');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: JOB, actId: 'checkpoint-act-1', accept: 'application/json', authorization: 'Bearer synthetic-read-grant' });
    expect(obj(arr(load(dir).review_acts).at(-1)).bytes).toBe(JSON.stringify(act));
    expect(checkProject(dir).refusals).toEqual([]);
  } finally { server.stop(true); }
});
