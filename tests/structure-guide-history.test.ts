import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { optionContext } from '../src/choices.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { Refusal } from '../src/refusal.ts';
import { STAGE_ORDER_SPEC, STAGE_VALUES } from '../src/stages.ts';
import { structureSnapshotCommand } from '../src/structure-snapshot.ts';
import type { JsonObject } from '../src/templates.ts';
import { advanceCommand, checkProject, diffClassesCommand, draftRigCommand, interviewAnswerCommand,
  inputCommand, interviewCommand, interviewOptionsCommand, planCommand, rigVersionCommand, signoffCommand, stepStatusCommand, testClock } from './clock.ts';
import { EXAMPLE_DIFF_REPORT } from './diff-fixture.ts';
import { plantLegacyReopen, arr, fixture, obj, rehashSignoffs, step, supersede, waypoint } from './fixtures.ts';
import { withPartsCheck } from './parts-check-fixture.ts';
import { partsPackage, writeReviewedInput } from './parts-package.ts';
import { recordPartsReceipt } from './parts-receipt-fixture.ts';

afterEach(() => testClock.reset());
const read = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, project: JsonObject): void => writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
function put(dir: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes);
}
const words = (dir: string): string[] => ['--by', 'owner', '--verbatim-file', join(dir, 'words.txt')];

function completeParts(dir: string): void {
  for (const id of ['seethrough', 'assemble']) {
    for (const status of ['in-progress', 'at-checkpoint']) stepStatusCommand([id, status, dir, '--by', 'agent']);
    if (id === 'assemble') signoffCommand(['parts', dir, '--checkpoint', id, ...words(dir)]);
    stepStatusCommand([id, 'done', dir, '--by', 'agent']);
  }
}

function approveParts(dir: string, id: string): void {
  const root = `derived/drafts/${id}`;
  put(dir, `${root}/config.json`, JSON.stringify({ meshes: { torso: { density: 10 } } }));
  writeReviewedInput(dir, root);
  put(dir, `${root}/input/recomposite_rig.png`, readFileSync(join(dir, 'derived/parts/rig/recomposite_rig.png')));
  for (const file of ['rig.json', 'motion.json', 'mesh_report.json']) put(dir, `${root}/out/${file}`, '{}');
  draftRigCommand([id, dir, '--config', `${root}/config.json`, '--from', `${root}/out`, '--parts', `${root}/input`]);
  const snapshot = `evidence/structure-${id}.json`;
  structureSnapshotCommand([dir, '--draft', id, '--out', snapshot]);
  recordPartsReceipt(dir, id, testClock.now());
  signoffCommand(['parts-review', dir, '--draft', id, '--structure-file', snapshot, ...words(dir)]);
}

function version(dir: string, n: number, at: string): JsonObject {
  const path = `evidence/production-v${n}/config.json`;
  const bytes = JSON.stringify({ meshes: { torso: { density: 20 } }, requirements: 'requirements.json' });
  put(dir, path, bytes);
  put(dir, `evidence/production-v${n}/requirements.json`, JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true } }));
  return { n, kind: 'rig', at, rig_version: null, review_origin: null, verdicts: [], outputs: [], evidence: [], answers_feedback: [],
    built_with: { '@rig-c/parts': PINNED_PACKAGES['@rig-c/parts'] }, provenance: {
      config: { path, sha256: sha(bytes) }, sections: {
        meshes: [{ entry: 'torso', guide: 'meshes', quote: 'Synthetic approved mesh delta.', asks: ['bend'] }],
      }, structure_delta: [{ entry: '/meshes/torso', snapshot: { density: 10 }, version: { density: 20 } }],
    } };
}

/** The legacy fixture supplies the unrelated interview/plan; only this synthetic cycle is renewed. */
function retainedDelta(): string {
  testClock.set('2026-11-20T00:00:00Z');
  const dir = fixture(p => {
    p.stage = 'parts-review'; p.stage_values = [...STAGE_VALUES]; p.versions = [];
    obj(p.interview).order = { spec: STAGE_ORDER_SPEC, adopted_at: '2026-11-19T00:00:00Z' };
    p.signoffs = arr(p.signoffs).filter(s => ['interview', 'plan-approved', 'parts'].includes(String(obj(s).stage)));
    for (const id of ['bones', 'meshes', 'constraints', 'motion']) supersede(waypoint(p, id), 'guide', null);
    for (const raw of arr(obj(p.plan).steps)) if (!['seethrough', 'assemble'].includes(String(obj(raw).id))) obj(raw).status = 'pending';
    step(p, 'assemble').rests_on = ['assemble']; rehashSignoffs(p);
  });
  cpSync(join(import.meta.dir, '../templates/example-draft/inputs/painting.png'), join(dir, 'painting-source.png'));
  inputCommand(['add', 'painting-source.png', dir, '--painting', '--origin', 'synthetic source painting']);
  const image = readFileSync(join(import.meta.dir, 'fixtures/rig-registration/rig/images/rectangle.png'));
  const manifest = JSON.stringify({ rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: createHash('sha256').update(image).digest('hex'), resample: 'lanczos3-rgb-opaque' },
    parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16, opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] });
  const pkg = partsPackage({ partsDir: 'derived/parts/rig', verdict: 'evidence/parts-review.json',
    input: { 'parts.json': manifest, 'parts/rectangle.png': image, 'painting_in_rig.png': image } });
  for (const [path, bytes] of Object.entries(pkg.files)) put(dir, path, typeof bytes === 'string' ? bytes : Buffer.from(bytes));
  put(dir, 'words.txt', 'Approve this synthetic structure.');
  testClock.set('2026-11-19T00:00:00.500Z'); signoffCommand(['interview', dir, ...words(dir)]);
  testClock.set('2026-11-19T00:00:01Z');
  plantLegacyReopen(dir, 'plan-approved', { by: 'owner', wordsFile: join(dir, 'words.txt') });
  testClock.set('2026-11-19T00:00:02Z'); signoffCommand(['plan-approved', dir, ...words(dir)]);
  advanceCommand(['parts', dir]);
  testClock.set('2026-11-19T00:00:03Z'); completeParts(dir);
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]);
  diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT, '--component', 'p10-n3=in-painting:synthetic', '--component', 'p1000-n3=in-painting:synthetic', '--by', 'agent']);
  testClock.set('2026-11-20T00:00:00Z'); approveParts(dir, 'a');
  const p = read(dir); obj(p.plan).rigging_drafted_at = '2026-11-21T00:00:00Z';
  const old = JSON.parse(readFileSync(join(import.meta.dir, '../templates/legacy-example-project.json'), 'utf8')) as JsonObject;
  for (const id of ['bones', 'meshes', 'constraints', 'motion']) {
    const guide = structuredClone(obj(waypoint(old, id).guide));
    guide.at = '2026-11-21T00:00:00Z'; guide.verbatim = 'Synthetic approved mesh delta.';
    supersede(waypoint(p, id), 'guide', guide);
  }
  save(dir, p); testClock.set('2026-11-22T00:00:00Z'); advanceCommand(['rigging-interview', dir]);
  signoffCommand(['rigging-interview', dir, ...words(dir)]); advanceCommand(['rigging', dir]);
  const built = read(dir); arr(built.versions).push(version(dir, 1, '2026-11-23T00:00:00Z')); save(dir, built);
  expect(checkProject(dir).refusals).toEqual([]);
  return dir;
}

function showQuestion(dir: string, question: string): { path: string; hash: string; set: JsonObject } {
  const set = JSON.parse(readFileSync(join(import.meta.dir, `../templates/example-interview-options/example-${question}.json`), 'utf8')) as JsonObject;
  set.id = `renewed-${question}`; set.drafted_at = testClock.iso();
  set.context = optionContext(read(dir), 'rigging-interview', testClock.now(), dir);
  const path = `evidence/renewed-${question}.json`, bytes = JSON.stringify(set);
  put(dir, path, bytes); interviewOptionsCommand([question, dir, '--file', path]);
  return { path, hash: sha(bytes), set };
}

function prepareRenewal(dir: string): ReturnType<typeof showQuestion> {
  testClock.set('2026-11-24T00:00:00Z');
  plantLegacyReopen(dir, 'parts', { by: 'owner', wordsFile: join(dir, 'words.txt') });
  testClock.set('2026-11-24T01:00:00Z'); completeParts(dir);
  advanceCommand(['parts-review', dir, ...withPartsCheck(dir)]);
  testClock.set('2026-11-25T00:00:00Z'); approveParts(dir, 'b');
  testClock.set('2026-11-26T00:00:00Z'); interviewOptionsCommand(['--adopt', dir]);
  advanceCommand(['rigging-interview', dir]);
  return showQuestion(dir, 'meshes');
}

function answerQuestion(dir: string, shown: ReturnType<typeof showQuestion>): string {
  return interviewAnswerCommand([String(shown.set.question), dir, '--set', shown.path, '--sha256', shown.hash, '--by', 'owner',
    ...arr(shown.set.asks).flatMap(a => ['--pick', `${String(obj(a).id)}=keep`])]);
}

test('meshes choice renewal preserves approved v1 structure delta and interview check stays green', () => {
  const dir = retainedDelta(), frozenV1 = JSON.stringify(arr(read(dir).versions)[0]);
  const revise = (id: string): void => {
    testClock.set(testClock.now() + 1000);
    expect(planCommand(['revise', id, dir, '--by', 'agent', '--reason', 'Review the renewed synthetic answer.']).exit).toBe(0);
  };
  const before = obj(waypoint(read(dir), 'meshes').guide);
  const shown = prepareRenewal(dir);
  testClock.set('2026-11-26T00:00:01Z');
  const answer = JSON.parse(answerQuestion(dir, shown)) as JsonObject;
  expect(answer.at).toBe(testClock.iso());
  expect(arr(waypoint(read(dir), 'meshes').history)).toContainEqual(before);
  expect(JSON.stringify(arr(read(dir).versions)[0])).toBe(frozenV1);
  revise('meshes');
  const result = interviewCommand(['--check', dir, '--json']);
  expect(JSON.parse(result.stdout).refusals).toEqual([]);
  expect(result.exit).toBe(0);
  for (const question of ['bones', 'constraints', 'motion']) {
    testClock.set(testClock.now() + 1000);
    answerQuestion(dir, showQuestion(dir, question));
    revise(question);
  }
  testClock.set('2026-11-27T00:00:00Z');
  expect(signoffCommand(['rigging-interview', dir, ...words(dir)]).exit).toBe(0);
  advanceCommand(['rigging', dir]);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(interviewCommand(['--check', dir, '--json']).exit).toBe(0);
  expect(JSON.stringify(arr(read(dir).versions)[0])).toBe(frozenV1);
});

test('a post-renewal rig without B approval remains refused and rig registration leaves bytes unchanged', () => {
  const dir = retainedDelta(), shown = prepareRenewal(dir);
  testClock.set('2026-11-26T00:00:01Z'); answerQuestion(dir, shown);
  // A later build must not borrow the retained A approval to cover the new B answer.
  const p = read(dir); arr(p.versions).push(version(dir, 2, '2026-11-26T00:00:02Z')); save(dir, p);
  testClock.set('2026-11-26T00:00:03Z');
  expect(checkProject(dir).refusals.filter(f => f.code === 'STRUCTURE_DECISIONS_CONFLICT').map(f => f.path))
    .toEqual(['versions[v2].provenance.config']);
  cpSync(join(import.meta.dir, 'fixtures/rig-registration'), join(dir, 'source'), { recursive: true });
  put(dir, 'source/config.json', JSON.stringify({ key: 'synthetic', meshes: { torso: { density: 20 } }, requirements: 'requirements.json' }));
  put(dir, 'source/requirements.json', JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } }));
  put(dir, 'source/adapter.json', '[]');
  cpSync(join(dir, 'derived/drafts/b/input'), join(dir, 'source/parts'), { recursive: true });
  put(dir, 'source/at-source.json', JSON.stringify({ finished_at: '2026-11-26T00:00:02Z' }));
  put(dir, 'source/citations.json', JSON.stringify({ meshes: [{ entry: 'torso', guide: 'meshes', quote: 'Synthetic meshes answer after viewing the approved parts and structure.', asks: ['bend'] }] }));
  put(dir, 'source/run.json', JSON.stringify({ spec: 'rigc-run/1', package: { name: 'rig-c', version: '3.4.1' }, command: 'build', started_at: '2026-11-26T00:00:02.000Z', finished_at: '2026-11-26T00:00:02.000Z', inputs: [{ role: 'rig', path: 'rig/rig.json', sha256: '1'.repeat(64) }, { role: 'motion', path: 'rig/motion.json', sha256: '2'.repeat(64) }], outputs: [{ path: 'build/skeleton.model.json', sha256: '2'.repeat(64) }] }));
  const before = readFileSync(join(dir, 'project.json'));
  try {
    rigVersionCommand(['3', dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle',
      '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json',
      '--toolchain-lock', 'source/package-lock.json', '--run-record', 'source/run.json', '--at-source', 'source/at-source.json',
      '--at-pointer', '/finished_at', '--citations', 'source/citations.json', '--by', 'registrant']);
    throw Error('expected refusal');
  }
  catch (error) { expect(error).toBeInstanceOf(Refusal); expect((error as Refusal).code).toBe('STRUCTURE_DECISIONS_CONFLICT'); }
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});
