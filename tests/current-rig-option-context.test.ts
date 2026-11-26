import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkProject, collectItems } from '../src/check.ts';
import { recordCheckReads } from '../src/check-reads.ts';
import { optionContext, optionContextFiles, optionFile, sha256, validateContext } from '../src/choices.ts';
import { outputSetHash, treeFiles } from '../src/current.ts';
import { readRecordPublished } from '../src/job-publication.ts';
import { OWNER_CHAT_SOURCE } from '../src/owner-chat.ts';
import { recordCommand } from '../src/record.ts';
import { selectSignoffTarget } from '../src/signoff-target.ts';
import { stageIndex } from '../src/stages.ts';
import { TEMPLATES_DIR, type JsonObject } from '../src/templates.ts';
import { interviewAnswerCommand, interviewOptionsCommand, planCommand, signoffCommand, TEST_NOW, testClock } from './clock.ts';
import { arr, fixture, obj, retainSignoffs } from './fixtures.ts';
import { tempDir } from './helpers.ts';
import { sceneFixture } from './scene-fixture.ts';

const stage = 'post-interview';
const fixtureTime = (offsetMs: number): string => new Date(TEST_NOW + offsetMs).toISOString();
const builtAt = fixtureTime(0);
const signedAt = fixtureTime(60_000);
const draftedAt = fixtureTime(120_000);
const afterDraftAt = fixtureTime(180_000);
const selectedAt = fixtureTime(240_000);
const afterSelectionAt = fixtureTime(300_000);
const draftTime = Date.parse(draftedAt);
const selectionTime = Date.parse(selectedAt);
const rebuiltAt = fixtureTime(360_000);
const reapprovedAt = fixtureTime(420_000);
const questionId = 'camera_depth';
const setId = 'current-camera';
const stale = expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE' });

afterEach(() => testClock.reset());

function write(dir: string, path: string, bytes: string) {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return { path, sha256: sha256(Buffer.from(bytes)) };
}

function installRig(dir: string, project: JsonObject = {}, spec = 'rig-run/3', changeRun?: (run: JsonObject) => void) {
  const source = write(dir, 'art/painting.png', 'synthetic painting');
  const full = write(dir, 'art/full/layers.json', '{"layers":[]}');
  const config = write(dir, 'specs/rig/setup.json', '{"paint":"synthetic"}');
  const model = write(dir, 'outputs/rig/check/build/skeleton.model.json', '{"synthetic":"rig"}');
  const report = write(dir, 'outputs/rig/check/check.json', '{"PASS":true}');
  const runPath = spec === 'rig-run/1' ? 'outputs/rig/run.json' : 'outputs/rig/build-run.json';
  const argv = ['build', '--out', '.'];
  const stamp: JsonObject = {
    spec, package: { name: '@rig-c/parts', version: '2.57.0' }, command: spec === 'rig-run/1' ? 'rig' : 'build',
    started_at: fixtureTime(-2000), finished_at: fixtureTime(-1000),
    // The original producer used a differently named, byte-identical config.
    config: { path: '../../staging/config-copy.json', sha256: config.sha256 },
    ...(spec === 'rig-run/3' ? { inputs: [source, full].map((binding, index) => ({ role: index === 0 ? 'source' : 'full', path: `../../${binding.path}`, sha256: binding.sha256 })) } : {}),
    outputs: [{ path: model.path.slice('outputs/rig/'.length), sha256: model.sha256 }],
    ...(spec === 'rig-run/1' ? {} : { argv }),
  };
  changeRun?.(stamp);
  const run = write(dir, runPath, JSON.stringify(stamp));
  const files = treeFiles(dir, 'outputs/rig');
  const rig: JsonObject = {
    at: builtAt, built_by: 'agent', built_with: { '@rig-c/parts': '2.57.0' }, files,
    files_sha256: outputSetHash(files), built_from: spec === 'rig-run/3' ? [full, source, config] : [config], run, report,
    rebuild: spec === 'rig-run/1' ? { recorded: false, note: 'synthetic unrecorded argv' } : { recorded: true, runs: [{ ...run, spec, argv }] },
  };
  project.current = { rig };
  const approve = () => {
    const target = selectSignoffTarget(dir, project, 'rig-review')!;
    const history = Array.isArray(project.signoffs) ? project.signoffs : [];
    project.signoffs = [...history, { stage: 'rig-review', checkpoint: null, by: 'owner', at: signedAt,
      verbatim: 'Approve this rig.', source: OWNER_CHAT_SOURCE, said_at: signedAt, relayed_by: 'operator', target }];
    return target;
  };
  return { project, rig, model, run, config, approve };
}

test.each(['rig-run/1', 'rig-run/2', 'rig-run/3'])('post context binds the config from the sealed %s digest', spec => {
  const dir = tempDir();
  const rig = installRig(dir, {}, spec);
  const target = rig.approve();
  const context = optionContext(rig.project, stage, draftTime, dir);
  expect(context).toEqual({ kind: 'current-rig', target, signoff_at: signedAt, run: rig.run, config: rig.config });
  expect(optionContextFiles(context)).toEqual([rig.run, rig.config]);
  const set = { stage, drafted_at: draftedAt, context };
  const { reads } = recordCheckReads(dir, () => validateContext(dir, rig.project, set, selectionTime, true));
  expect(reads).toEqual(expect.arrayContaining([rig.run, rig.config, rig.model]));
});

test.each(['run', 'config', 'model'] as const)('fresh current-rig options refuse changed %s bytes', file => {
  const dir = tempDir();
  const rig = installRig(dir);
  rig.approve();
  const set = { stage, drafted_at: draftedAt, context: optionContext(rig.project, stage, draftTime, dir) };
  write(dir, rig[file].path, 'different bytes');
  expect(() => validateContext(dir, rig.project, set, selectionTime, true)).toThrow(stale);
});

test('current-rig refuses missing, malformed, and ambiguous producer config bindings', () => {
  const dir = tempDir();
  const rig = installRig(dir);
  const builtFrom = (rig.rig.built_from as JsonObject[]).slice();
  const context = () => optionContext(rig.project, stage, draftTime, dir);
  rig.rig.built_from = builtFrom.filter(binding => binding.path !== rig.config.path);
  rig.approve();
  expect(context).toThrow(stale);

  const secondMatch = write(dir, 'art/copy.json', readFileSync(join(dir, rig.config.path), 'utf8'));
  rig.rig.built_from = [...builtFrom, secondMatch];
  rig.approve();
  expect(context).toThrow(stale);

  const malformed = installRig(dir, {}, 'rig-run/3', run => { delete run.inputs; });
  malformed.approve();
  expect(() => optionContext(malformed.project, stage, draftTime, dir)).toThrow(stale);

  const missing = installRig(dir);
  missing.approve();
  rmSync(join(dir, missing.run.path));
  expect(() => optionContext(missing.project, stage, draftTime, dir)).toThrow(stale);
});

test('current-rig needs a live, matching owner approval at drafting and selection', () => {
  const dir = tempDir();
  const rig = installRig(dir);
  expect(() => optionContext(rig.project, stage, draftTime, dir)).toThrow(stale);
  rig.approve();
  expect(() => optionContext(rig.project, stage, Date.parse(builtAt), dir)).toThrow(stale);
  const set = { stage, drafted_at: draftedAt, context: optionContext(rig.project, stage, draftTime, dir) };
  rig.project.reopens = [{ stage: 'rig-review', from_stage: 'post-interview', by: 'owner', at: afterDraftAt,
    verbatim: 'Reopen the rig.', source: OWNER_CHAT_SOURCE, said_at: afterDraftAt, relayed_by: 'operator', steps_before: [] }];
  expect(() => validateContext(dir, rig.project, set, selectionTime, true)).toThrow(stale);
});

test('scene-first drafting preserves the current-rig context already authored before a later scene', () => {
  const f = sceneFixture();
  const rig = installRig(f.dir, f.load());
  rig.approve();
  f.save(rig.project);
  const context = optionContext(rig.project, stage, draftTime, f.dir);
  expect(context.kind).toBe('current-rig');
  const set = { stage, drafted_at: draftedAt, context };
  testClock.set(afterDraftAt);
  f.seedHistoricalScene();
  const project = f.load();
  expect(optionContext(project, stage, selectionTime, f.dir).kind).toBe('scene');
  expect(() => validateContext(f.dir, project, set, selectionTime, true)).not.toThrow();
  expect(() => validateContext(f.dir, project, { ...set, drafted_at: selectedAt }, selectionTime, true)).toThrow(stale);
});

test('adoption keeps retained numbered options and their check findings while new options require current evidence', () => {
  const dir = fixture(() => {}, 'example-project.json');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const camera = collectItems(project, { collection: null }).find(item => item.id === 'camera_depth')!;
  const { set } = optionFile(dir, obj(obj(camera.raw).choice).set);
  expect(obj(set.context).kind).toBe('rig');
  const before = checkProject(dir, project, { now: selectionTime, readOnly: true });
  const adopted = { ...project, current: {} };
  const after = checkProject(dir, adopted, { now: selectionTime, readOnly: true });
  expect(after.refusals).toEqual(before.refusals);
  expect(after.warnings).toEqual(before.warnings);
  expect(() => validateContext(dir, adopted, set, selectionTime, true)).not.toThrow();
  expect(() => validateContext(dir, adopted, { ...set, id: 'new-numbered-set' }, selectionTime, true)).toThrow(stale);
  expect(optionContext({ ...project, scenes: [] }, stage, selectionTime, dir).kind).toBe('rig');
  expect(() => optionContext({ ...adopted, scenes: [] }, stage, selectionTime, dir)).toThrow(stale);
});

function postProject(): string {
  return fixture(project => {
    project.stage = stage;
    project.scenes = [];
    project.versions = arr(project.versions).filter(version => obj(version).kind === 'rig');
    delete project.direction_contract;
    retainSignoffs(project, signature => stageIndex(String(signature.stage)) < stageIndex(stage));
    for (const step of arr(obj(project.plan).steps).map(obj)) if (step.phase === 'post') step.status = 'pending';
  }, 'example-project.json');
}

function load(dir: string): JsonObject {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
}

function registerCamera(dir: string) {
  const project = load(dir);
  const item = collectItems(project, { collection: null }).find(item => item.id === questionId)!;
  const { set } = optionFile(dir, obj(obj(item.raw).choice).set);
  const context = optionContext(project, stage, draftTime, dir);
  const pending = write(dir, `evidence/interview/${setId}.json`, JSON.stringify({ ...set, id: setId, drafted_at: draftedAt, context }));
  testClock.set(selectionTime);
  expect(JSON.parse(interviewOptionsCommand([questionId, dir, '--file', pending.path]))).toEqual(pending);
  const ask = obj(arr(set.asks)[0]);
  const pick = arr(ask.options).map(obj).find(option => option.recommended === true)!;
  return { pending, context, pick: `${String(ask.id)}=${String(pick.id)}` };
}

function copyPublicationFiles(dir: string, files: readonly { path: string }[]): string {
  const root = tempDir();
  for (const file of files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    cpSync(join(dir, file.path), join(root, file.path));
  }
  return root;
}

test('the option writer and both publication phases accept the sealed current-rig context', () => {
  const dir = postProject();
  const recordPath = join(dir, 'project.json');
  const project = load(dir);
  const rig = installRig(dir, project);
  rig.approve();
  writeFileSync(recordPath, JSON.stringify(project));
  const { pending } = registerCamera(dir);

  const record = { path: 'project.json' as const, sha256: sha256(readFileSync(recordPath)) };
  const result = { kind: 'option-set' as const, questionId, setId };
  const inventory = readRecordPublished({ root: dir, record, result, phase: 'inventory' }, selectionTime);
  expect(inventory.files).toEqual(expect.arrayContaining([pending, rig.run, rig.config, rig.model]));
  const root = copyPublicationFiles(dir, inventory.files);
  expect(readRecordPublished({ root, record, result, phase: 'retained', parts: inventory.parts }, selectionTime)).toEqual(inventory);
  for (const binding of [rig.run, rig.config]) {
    const path = join(dir, binding.path);
    const bytes = readFileSync(path);
    writeFileSync(path, 'different bytes');
    try {
      expect(() => readRecordPublished({ root: dir, record, result, phase: 'inventory' }, selectionTime)).toThrow(expect.objectContaining({
        code: 'JOB_RECORD_INCOMPLETE', message: expect.stringContaining(`${binding.path} differs from its retained bytes`),
      }));
    } finally {
      writeFileSync(path, bytes);
    }
  }
});

function stageProducerRig(dir: string, config: string, replacement = false): string[] {
  const producer = join(TEMPLATES_DIR, 'example-draft');
  const next = 'outputs/rig.next';
  cpSync(join(producer, 'out'), join(dir, next), { recursive: true });
  write(dir, config, readFileSync(join(producer, 'config.json'), 'utf8'));
  const modelHash = sha256(readFileSync(join(dir, next, 'check/build/skeleton.model.json')));
  write(dir, `${next}/check/check.json`, JSON.stringify({ spec: 'rig-parts-check/1', bar_outcomes: {}, build: { model_sha256: modelHash }, PASS: true }));
  if (replacement) {
    const changed = write(dir, `${next}/mesh_report.json`, '{"rebuilt":true}');
    const stampPath = `${next}/run.json`;
    const stamp = JSON.parse(readFileSync(join(dir, stampPath), 'utf8')) as JsonObject;
    obj(arr(stamp.outputs).find(row => obj(row).path === 'mesh_report.json')).sha256 = changed.sha256;
    write(dir, stampPath, JSON.stringify(stamp));
  }
  return ['rig', dir, '--from', next, '--config', config];
}

function signRig(dir: string, at: string): void {
  testClock.set(at);
  const words = write(dir, 'rig-approval.txt', 'Approve the displayed rig.\n');
  expect(signoffCommand(['rig-review', dir, '--by', 'owner', '--owner-chat', join(dir, words.path), '--said-at', at, '--relayed-by', 'operator']).exit).toBe(0);
}

function realRigOptions() {
  const dir = postProject();
  const config = 'specs/rig/original.json';
  expect(recordCommand(stageProducerRig(dir, config), Date.parse(builtAt)).exit).toBe(0);
  signRig(dir, signedAt);
  const registered = registerCamera(dir);
  const answer = () => interviewAnswerCommand([questionId, dir, '--by', 'owner', '--set', registered.pending.path,
    '--sha256', registered.pending.sha256, '--pick', registered.pick]);
  return { dir, config, registered, answer };
}

test('a rebuilt rig can publish a plan based on the answered current-rig set', () => {
  const f = realRigOptions();
  const answer = JSON.parse(f.answer()) as JsonObject;
  expect(obj(answer.choice).set).toEqual(f.registered.pending);
  testClock.set(afterSelectionAt);
  expect(planCommand(['revise', 'camera', f.dir, '--by', 'agent', '--reason', 'Reviewed the new camera choice.']).exit).toBe(0);
  const nextConfig = 'specs/rig/replacement.json';
  const next = stageProducerRig(f.dir, nextConfig, true);
  testClock.set(rebuiltAt);
  expect(recordCommand(next, testClock.now()).exit).toBe(0);
  rmSync(join(f.dir, f.config));

  const project = load(f.dir);
  const rig = obj(obj(project.current).rig);
  const run = obj(rig.run);
  expect(rig.files_sha256).not.toBe(obj(f.registered.context.target).files_sha256);
  expect(run.sha256).not.toBe(obj(f.registered.context.run).sha256);
  const check = checkProject(f.dir, undefined, { now: testClock.now(), readOnly: true });
  expect(check.refusals.map(finding => finding.code)).toEqual(['SIGNOFF_TARGET_STALE']);

  signRig(f.dir, reapprovedAt);
  const published = load(f.dir);
  const step = arr(obj(published.plan).steps).map(obj).find(step => step.id === 'camera');
  expect(step?.rests_on).toContain(questionId);
  const item = collectItems(published, { collection: null }).find(item => item.id === questionId)!;
  expect(obj(obj(item.raw).choice).set).toEqual(f.registered.pending);

  const record = { path: 'project.json' as const, sha256: sha256(readFileSync(join(f.dir, 'project.json'))) };
  const result = { kind: 'plan' as const };
  const publication = readRecordPublished({ root: f.dir, record, result, phase: 'inventory' }, testClock.now());
  expect(publication.plan.steps.map(step => step.id)).toContain('camera');
  expect(publication.files).toContainEqual(f.registered.pending);
  expect(publication.files).toContainEqual({ path: String(run.path), sha256: String(run.sha256) });
  expect(publication.files.some(file => file.path === f.config)).toBe(false);
  expect(publication.files).not.toContainEqual(f.registered.context.run);
  const root = copyPublicationFiles(f.dir, publication.files);
  expect(readRecordPublished({ root, record, result, phase: 'retained', parts: publication.parts }, testClock.now())).toEqual(publication);
});

test('pending current-rig options fail on a different rig and keep the real record gate closed', () => {
  const f = realRigOptions();
  const project = load(f.dir);
  const rig = obj(obj(project.current).rig);
  rig.at = rebuiltAt;
  const now = Date.parse(rebuiltAt);
  const finding = expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE', path: 'interview.post.items[camera_depth].guide.pending_options' });
  expect(checkProject(f.dir, project, { now }).refusals).toContainEqual(finding);

  const before = readFileSync(join(f.dir, 'project.json'));
  const next = stageProducerRig(f.dir, 'specs/rig/replacement.json', true);
  expect(() => recordCommand(next, now)).toThrow(stale);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  writeFileSync(join(f.dir, 'project.json'), JSON.stringify(project));
  testClock.set(rebuiltAt);
  expect(f.answer).toThrow(stale);
});

test('a retained answer refuses tampering with its sealed context and bound approval', () => {
  const f = realRigOptions();
  f.answer();
  const project = load(f.dir);
  const camera = collectItems(project, { collection: null }).find(item => item.id === questionId)!;
  const choice = obj(obj(camera.raw).choice);
  const { set } = optionFile(f.dir, choice.set);
  const target = obj(obj(set.context).target);
  const findings = () => checkProject(f.dir, project, { now: Date.parse(rebuiltAt) }).refusals;
  const staleAnswer = expect.objectContaining({ code: 'INTERVIEW_OPTIONS_STALE', path: camera.path });
  for (const at of [afterSelectionAt, afterDraftAt]) {
    project.reopens = [{ stage: 'rig-review', from_stage: stage, by: 'owner', at, verbatim: 'Reopen the rig.',
      source: OWNER_CHAT_SOURCE, said_at: at, relayed_by: 'operator', steps_before: [] }];
    if (Date.parse(at) > selectionTime) expect(findings()).not.toContainEqual(staleAnswer);
    else expect(findings()).toContainEqual(staleAnswer);
  }
  delete project.reopens;
  const approval = arr(project.signoffs).map(obj).find(s => s.at === signedAt)!;
  const relayedBy = approval.relayed_by!;
  delete approval.relayed_by;
  expect(findings()).toContainEqual(staleAnswer);
  approval.relayed_by = relayedBy;

  target.record_sha256 = 'a'.repeat(64);
  const tampered = write(f.dir, f.registered.pending.path, JSON.stringify(set));
  expect(findings()).toContainEqual(expect.objectContaining({ code: 'INTERVIEW_OPTIONS_FILE', path: camera.path }));
  choice.set = tampered;
  expect(findings()).toContainEqual(staleAnswer);
});
