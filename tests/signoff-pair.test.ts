import { afterEach, expect, test } from 'bun:test';
import { prepareJobRecordSource } from '@rig-c/review/job-host';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding } from '../src/check.ts';
import { recordVerdict } from '../src/feedback.ts';
import { DIRECTION_SCENE_SPEC, objects, validateDirectionScene } from '../src/direction.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { currentJobIdentity, type RecordPlanContext } from '../src/job-publication.ts';
import { decodeReviewAct, reviewActFindings, reviewActSignoff, reviewActVerdict, signoffActIdentity } from '../src/review-act.ts';
import { checkScenes, currentScene, sceneReference } from '../src/scene.ts';
import { signoffCommand } from '../src/signoff.ts';
import { ingestedVerdictPairFinding, samePublicationReviewPair, SIGNOFF_PAIR_SINCE, signoffPairFinding } from '../src/signoff-pair.ts';
import { checkSignoffTarget, outputsHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { arr, fixture, obj, withdrawSignature } from './fixtures.ts';
import { sceneFixture } from './scene-fixture.ts';
import { tempDir } from './helpers.ts';
import { stepHash } from '../src/step-hash.ts';

afterEach(() => testClock.reset());
const jobId = 'synthetic-pair-job';
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));

function act(kind: 'signoff' | 'review-verdict', version: number, stage: string, at: string): JsonObject {
  return { schema: 'rig-review/act@2', kind, jobId, actId: kind === 'signoff' ? 'sign' : 'verdict', askId: `ask-${kind}`, publicationId: 'publication-one', at,
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: { sourceHash: '1'.repeat(64), projectHash: '2'.repeat(64), package: { id: 'synthetic-package', revision: 'one' },
      selector: stage === 'rig-review' ? { kind: 'rig', version } : { kind: 'post', version, rigVersion: 1 },
      model: { path: 'synthetic.model.json', sha256: '3'.repeat(64) },
      direction: stage === 'rig-review' ? null : { path: 'direction.json', sha256: '4'.repeat(64) },
      optionSet: null, appliedResult: null, plan: null,
      parts: { enumeratorVersion: '2.34.0', manifest: { path: 'parts.json', sha256: '5'.repeat(64) }, images: [] } },
    value: kind === 'signoff' ? { stage, decision: 'approved', words: 'Approve the stage.' } : { stage, verdict: 'approved', words: 'Accept the version.' } };
}
function verdictReceipt(project: JsonObject, raw: JsonObject, version: JsonObject, verdictIndex = 0): void {
  const bytes = JSON.stringify(raw); const decoded = decodeReviewAct(bytes);
  arr(version.verdicts)[verdictIndex] = reviewActVerdict(decoded);
  project.review_acts = [...(project.review_acts as JsonObject[] ?? []), { schema: 'rig-create/review-act@1', jobId: raw.jobId!, actId: raw.actId!,
    bytes, sha256: jobHash(bytes), version: version.n!, verdict: verdictIndex, version_hash: '6'.repeat(64), added_evidence: [] }];
}
function signatureReceipt(project: JsonObject, raw: JsonObject, signature: JsonObject): void {
  const bytes = JSON.stringify(raw); const decoded = decodeReviewAct(bytes, 'signoff');
  Object.assign(signature, reviewActSignoff(decoded));
  project.review_acts = [...(project.review_acts as JsonObject[] ?? []), { schema: 'rig-create/review-act@1', kind: 'signoff', jobId: raw.jobId!, actId: raw.actId!, stage: signature.stage!,
    bytes, sha256: jobHash(bytes), version_hash: jobHash(JSON.stringify(signoffActIdentity(decoded))),
    ...(decoded.schema === 'rig-review/act@4' && decoded.value.stage === 'direction-review'
      ? { record_sha256: decoded.source.projectHash, target_version: obj(signature.target).version!, verdict: obj(signature.target).verdict! } : {}) }];
}
function bind(dir: string): void {
  const identity = currentJobIdentity({ root: dir, stateDir: 'unused-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, dir);
  writePrivateJson(join(realpathSync(dir), JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId,
    origin: 'http://127.0.0.1:43123', fetchCapability: 'synthetic-read-grant' }, true);
  const p = load(dir); p.review_job = { jobId, origin: 'http://127.0.0.1:43123' }; save(dir, p);
}
function ingestSetup() {
  const dir = fixture(); bind(dir);
  const signedAt = withdrawSignature(dir, 'rig-review');
  const p = load(dir); const version = obj(arr(p.versions)[1]);
  const verdict = act('review-verdict', 2, 'rig-review', new Date(Date.parse(signedAt) + 60_000).toISOString());
  verdictReceipt(p, verdict, version); save(dir, p);
  const signature = act('signoff', 2, 'rig-review', signedAt);
  const ingest = () => signoffCommand(['rig-review', realpathSync(dir), '--from-review', 'sign'], Date.parse('2026-11-20T00:00:00Z'), {
    fetch: () => ({ bytes: JSON.stringify(signature) }),
  });
  return { dir, signature, verdict, ingest };
}

test('same-publication human signoff before accepted verdict ingests with its receipt, then replays byte-identically', () => {
  const f = ingestSetup();
  expect(f.ingest().exit).toBe(0);
  const p = load(f.dir); const signature = obj(arr(p.signoffs).at(-1));
  expect(reviewActFindings(p)).toEqual([]);
  expect(samePublicationReviewPair(p, signature, obj(arr(p.versions)[1]), 0)).toBe(true);
  expect(checkProject(f.dir).refusals.map(f => f.code)).not.toContain('SIGNOFF_PAIR_MISMATCH');
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(f.ingest().exit).toBe(0);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

test('different-publication earlier signoff refuses ingest by name and leaves the record byte-identical', () => {
  const f = ingestSetup(); f.signature.publicationId = 'publication-two';
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(f.ingest).toThrow(expect.objectContaining({ code: 'SIGNOFF_PAIR_MISMATCH' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

test('a signoff cannot target a different version from its immutable displayed version', () => {
  const f = ingestSetup(); obj(obj(f.signature.source).selector).version = 1;
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(f.ingest).toThrow(expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

test.each(['changes-requested', 'pending'])('a same-publication %s verdict never authorizes a signoff', verdict => {
  const f = ingestSetup(); const p = load(f.dir); p.review_acts = [];
  obj(f.verdict.value).verdict = verdict;
  verdictReceipt(p, f.verdict, obj(arr(p.versions)[1])); save(f.dir, p);
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(f.ingest).toThrow(expect.objectContaining({ code: 'SIGNOFF_TARGET_STALE' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

test('unaffected chronological signoff writer preserves the existing serialized record exactly', () => {
  const f = ingestSetup(); const p = load(f.dir); const version = obj(arr(p.versions)[1]);
  const signedAt = String(f.signature.at); f.verdict.at = new Date(Date.parse(signedAt) - 60_000).toISOString();
  p.review_acts = []; verdictReceipt(p, f.verdict, version); save(f.dir, p);
  expect(f.ingest().exit).toBe(0);
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(f.ingest().exit).toBe(0);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

function scenePair() {
  const f = sceneFixture(); const p = f.load();
  const signature = objects(p.signoffs).find(s => s.stage === 'rig-review')!;
  const version = objects(p.versions)[0]!;
  const signed = act('signoff', 1, 'rig-review', String(signature.at));
  const accepted = act('review-verdict', 1, 'rig-review', new Date(Date.parse(String(signature.at)) + 60_000).toISOString());
  verdictReceipt(p, accepted, version); signatureReceipt(p, signed, signature); f.save(p);
  expect(reviewActFindings(p)).toEqual([]);
  return { ...f, p, signature, version };
}

test('scene write accepts an earlier same-publication signoff and direction reads the same accepted scene', () => {
  const f = scenePair();
  expect(f.writeScene().exit).toBe(0);
  const p = f.load(); const entry = currentScene(p)!;
  const scene = JSON.parse(readFileSync(join(f.dir, String(entry.path)), 'utf8')) as JsonObject;
  const ctx = { dir: f.dir, project: p, refusals: [] as Finding[] }; checkScenes(ctx);
  expect(ctx.refusals).toEqual([]);
  const direction = { schema: DIRECTION_SCENE_SPEC, scene: sceneReference(entry), rig: { version: 1, model: obj(scene.rig).model! } };
  expect(() => validateDirectionScene(f.dir, p, direction, true)).not.toThrow();
  const errors: Finding[] = []; const warnings: Finding[] = [];
  checkSignoffTarget(f.dir, p, f.signature, 'signoffs[0]', errors, warnings);
  expect(errors).toEqual([]); expect(warnings).toEqual([]);
});

test.each(['job', 'publication', 'version', 'authority', 'bytes', 'duplicate', 'duplicate-signoff', 'unmapped'])('pair exception rejects invalid %s identity or authority', plant => {
  const f = scenePair(); const receipts = arr(f.p.review_acts).map(obj); const receipt = receipts[0]!;
  const raw = JSON.parse(String(receipt.bytes)) as JsonObject;
  if (plant === 'job') { raw.jobId = 'another-job'; receipt.jobId = raw.jobId; }
  if (plant === 'publication') raw.publicationId = 'another-publication';
  if (plant === 'version') obj(obj(raw.source).selector).version = 2;
  if (plant === 'authority') obj(raw.authority).actor = 'agent';
  if (plant === 'duplicate') arr(f.p.review_acts).push(structuredClone(receipt));
  if (plant === 'duplicate-signoff') arr(f.p.signoffs).push(structuredClone(f.signature));
  if (plant === 'unmapped') f.p.review_acts = [];
  if (plant === 'job') arr(f.version.verdicts)[0] = reviewActVerdict(decodeReviewAct(JSON.stringify(raw)));
  receipt.bytes = JSON.stringify(raw);
  if (plant !== 'bytes') receipt.sha256 = jobHash(String(receipt.bytes)); else receipt.sha256 = 'f'.repeat(64);
  expect(samePublicationReviewPair(f.p, f.signature, f.version, 0)).toBe(false);
  f.save(f.p);
  expect(f.writeScene).toThrow(expect.objectContaining({ code: 'SCENE_RIG_STALE' }));
});

test.each(['rig-review', 'direction-review'])('shared %s check dates legacy mismatch by the real signature, ingest always refuses', stage => {
  const at = Date.parse(SIGNOFF_PAIR_SINCE);
  const signature: JsonObject = { stage, checkpoint: null, by: 'user', at: new Date(at).toISOString(),
    target: { version: 1, verdict: 'versions[0].verdicts[0]' } };
  const version: JsonObject = { n: 1, kind: stage === 'rig-review' ? 'rig' : 'post',
    pre_interview: stage === 'rig-review', outputs: [{ path: 'rig.json', sha256: 'a'.repeat(64) }],
    provenance: { config: { path: 'post.json', sha256: 'b'.repeat(64) } },
    verdicts: [{ review: stage, verdict: 'accepted', by: 'user', at: new Date(at + 60_000).toISOString() }] };
  Object.assign(obj(signature.target), stage === 'rig-review'
    ? { outputs: { path: 'versions[0].outputs', sha256: outputsHash(arr(version.outputs)) } }
    : { post_config: obj(version.provenance).config });
  const p = { versions: [version], signoffs: [signature] };
  const check = () => {
    const errors: Finding[] = []; const warnings: Finding[] = [];
    checkSignoffTarget('', p, signature, 'signoffs[0]', errors, warnings);
    return { errors, warnings };
  };
  expect(signoffPairFinding(p, signature, 'signoffs[0]')?.code).toBe('SIGNOFF_PAIR_MISMATCH');
  expect(check().errors.map(f => f.code)).toEqual(['SIGNOFF_PAIR_MISMATCH']);
  expect(ingestedVerdictPairFinding(p, 1, 0)?.code).toBe('SIGNOFF_PAIR_MISMATCH');
  signature.at = new Date(at - 1).toISOString();
  expect(signoffPairFinding(p, signature, 'signoffs[0]')?.code).toBe('SIGNOFF_PAIR_MISMATCH_LEGACY');
  expect(check().errors).toEqual([]);
  expect(check().warnings.map(f => f.code)).toEqual(['SIGNOFF_PAIR_MISMATCH_LEGACY']);
  expect(ingestedVerdictPairFinding(p, 1, 0)?.code).toBe('SIGNOFF_PAIR_MISMATCH');
  signature.at = new Date(at + 60_000).toISOString();
  expect(signoffPairFinding(p, signature, 'signoffs[0]')).toBeUndefined();
  expect(check()).toEqual({ errors: [], warnings: [] });
  const signed = act('signoff', 1, stage, new Date(at).toISOString());
  const accepted = act('review-verdict', 1, stage, new Date(at + 60_000).toISOString());
  signatureReceipt(p, signed, signature); verdictReceipt(p, accepted, version);
  expect(reviewActFindings(p)).toEqual([]);
  expect(check()).toEqual({ errors: [], warnings: [] });
});

test('review ingest refuses completing a legacy cross-publication pair before writing the verdict', () => {
  const dir = fixture(); const p = load(dir); const version = obj(arr(p.versions)[1]);
  const signature = objects(p.signoffs).find(s => s.stage === 'rig-review')!;
  const index = arr(version.verdicts).length;
  obj(signature.target).verdict = `versions[1].verdicts[${index}]`;
  save(dir, p);
  const before = readFileSync(join(dir, 'project.json'));
  expect(() => recordVerdict(dir, { version: 2, review: 'rig-review', verdict: 'accepted', by: 'user',
    at: new Date(Date.parse(String(signature.at)) + 60_000).toISOString(), verbatim: 'Accept', source: 'synthetic review',
    items: [], quotes: {}, values: {} }, Date.parse('2026-11-20T00:00:00Z'))).toThrow(expect.objectContaining({ code: 'SIGNOFF_PAIR_MISMATCH' }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

async function recordDirectionPair() {
  const dir = realpathSync(tempDir());
  const at = SIGNOFF_PAIR_SINCE;
  const version: JsonObject = { n: 2, kind: 'post', at, provenance: { config: { path: 'post.json', sha256: 'a'.repeat(64) } }, verdicts: [] };
  const signature: JsonObject = { target: { version: 2, verdict: 'versions[0].verdicts[0]', post_config: obj(version.provenance).config! } };
  const step: JsonObject = { id: 'camera', phase: 'post', status: 'done' };
  const p: JsonObject = { schema: 'rig-create/project@0', plan: { steps: [step] }, versions: [version], signoffs: [signature] };
  const verdict = act('review-verdict', 2, 'direction-review', new Date(Date.parse(at) + 60_000).toISOString());
  verdictReceipt(p, verdict, version); save(dir, p);
  const record = { path: 'project.json' as const, sha256: jobHash(readFileSync(join(dir, 'project.json'))) };
  const context: RecordPlanContext = { label: 'Synthetic direction record',
    parts: { name: '@rig-c/parts', version: '2.37.0', integrity: 'synthetic' }, inputs: [], files: [record],
    plan: { steps: [{ id: 'camera', hash: stepHash(step) }] }, subjects: [{ kind: 'signoff', stage: 'direction-review' }] };
  const info = statSync(dir);
  const retained = await prepareJobRecordSource({ root: { path: dir, dev: info.dev, ino: info.ino },
    stateRoot: join(dir, '.record-snapshots'), fingerprint: 'synthetic',
    request: { freeze: { kind: 'producer-held', holdId: 'synthetic-hold', record }, result: { kind: 'plan' } },
    readRecordPublished: (() => context) as unknown as NonNullable<Parameters<typeof prepareJobRecordSource>[0]['readRecordPublished']> });
  const signed: JsonObject = { schema: 'rig-review/act@4', kind: 'signoff', jobId, actId: 'sign-record', askId: 'ask-record',
    publicationId: verdict.publicationId!, at, authority: verdict.authority!, source: retained.source as unknown as JsonObject,
    value: { stage: 'direction-review', decision: 'approved', words: 'Approve the direction record.' } };
  signatureReceipt(p, signed, signature);
  expect(obj(signed.source).selector).toBeUndefined();
  expect(reviewActFindings(p)).toEqual([]);
  return { p, version, signature, signed };
}

test('sealed record @4 direction pair resolves its post through the validated compact receipt, without a selector', async () => {
  const f = await recordDirectionPair();
  expect(samePublicationReviewPair(f.p, f.signature, f.version, 0)).toBe(true);
  expect(signoffPairFinding(f.p, f.signature, 'signoffs[0]', true)).toBeUndefined();
  expect(ingestedVerdictPairFinding(f.p, 2, 0)).toBeUndefined();
  const errors: Finding[] = []; const warnings: Finding[] = [];
  checkSignoffTarget('', f.p, f.signature, 'signoffs[0]', errors, warnings);
  expect(errors).toEqual([]); expect(warnings).toEqual([]);
});

test.each(['record_sha256', 'target_version', 'verdict', 'publication'])('record @4 direction pair refuses altered %s mapping', async field => {
  const f = await recordDirectionPair(); const receipt = obj(arr(f.p.review_acts).at(-1));
  if (field === 'publication') {
    f.signed.publicationId = 'another-publication'; receipt.bytes = JSON.stringify(f.signed); receipt.sha256 = jobHash(String(receipt.bytes));
  } else receipt[field] = field === 'target_version' ? 99 : field === 'verdict' ? 'versions[0].verdicts[9]' : 'f'.repeat(64);
  expect(samePublicationReviewPair(f.p, f.signature, f.version, 0)).toBe(false);
  expect(signoffPairFinding(f.p, f.signature, 'signoffs[0]', true)?.code).toBe('SIGNOFF_PAIR_MISMATCH');
  if (field !== 'publication') expect(reviewActFindings(f.p).map(f => f.code)).toContain('REVIEW_ACT_LEDGER_INVALID');
});
