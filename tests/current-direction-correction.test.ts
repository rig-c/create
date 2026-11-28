import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateCurrentDirectionCorrectionFixture } from '../scripts/generate-current-direction-correction-fixture.ts';
import { collectItems, type Finding } from '../src/check.ts';
import { CAMERA_SCENE_BINDING_SINCE, validateCameraOptions } from '../src/camera-choice.ts';
import { correctionApprovalFindings, currentDirectionIdentity } from '../src/corrections.ts';
import { COMPOSE_CHECK_PATH, COMPOSE_RUN_PATH, CURRENT_DIRECTION_PATH } from '../src/current-direction.ts';
import { outputSetHash, sha256, treeFiles } from '../src/current.ts';
import { DIRECTION_CORRECTION_SPEC, directionPostIdentity } from '../src/direction.ts';
import { objects } from '../src/direction.ts';
import { inspectCurrentPublication, prepareCurrentManifest } from '../src/job-publication.ts';
import { recordCommand } from '../src/record.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkCorrections, checkProject, correctionCommand, directionCommand, signoffCommand, testClock } from './clock.ts';
import { tempDir } from './helpers.ts';
import { seedRetainedDirectionPost } from './numbered-seed.ts';

afterEach(() => testClock.reset());

const FIXTURE_ROOT = join(import.meta.dir, 'fixtures/correction-current-direction');

function cloneFixture(at = '2026-11-26T09:10:00Z') {
  const dir = join(tempDir(), 'project');
  cpSync(FIXTURE_ROOT, dir, { recursive: true });
  testClock.set(new Date(at));
  const load = (): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const save = (project: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  return { dir, load, save };
}

function findings(dir: string, project?: JsonObject) {
  const ctx = { dir, project: project ?? JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject, refusals: [] as Finding[], warnings: [] as Finding[] };
  checkCorrections(ctx);
  return ctx;
}

function refusesByteIdentical(dir: string, code: string, exitCode: number, run: () => unknown): void {
  const before = readFileSync(join(dir, 'project.json'));
  const files = readdirSync(dir, { recursive: true });
  expect(run).toThrow(expect.objectContaining({ code, exitCode }));
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  expect(readdirSync(dir, { recursive: true })).toEqual(files);
}

function restageAndRecordDirection(dir: string, intentFile: string, revision: number, writeAt: string, recordAt: string): void {
  testClock.set(new Date(writeAt));
  directionCommand(['write', dir, '--file', intentFile]);
  const composeStage = 'derived/compose-input';
  const directionFrom = 'outputs/direction.next';
  const partsScene = 'specs/direction/compose-scene.json';
  const backdropSha = sha256(readFileSync(join(dir, 'inputs/backdrop.png')));
  const model = JSON.stringify({
    spec: 'rigc-compiled/3',
    stage: { x: -32, y: 0, width: 64, height: 48 },
    animations: [{ name: 'idle', duration: 4 }],
    pages: [],
    synthetic_revision: revision,
  }, null, 2) + '\n';
  mkdirSync(join(dir, `${directionFrom}/check/build`), { recursive: true });
  writeFileSync(join(dir, `${directionFrom}/check/build/skeleton.model.json`), model);
  writeFileSync(join(dir, `${directionFrom}/${COMPOSE_CHECK_PATH}`), JSON.stringify({
    spec: 'rig-parts-check/1',
    PASS: true,
    gate_spine_html_green: true,
    build: { model_sha256: sha256(model) },
  }, null, 2) + '\n');
  writeFileSync(join(dir, `${directionFrom}/scene.json`), JSON.stringify({
    spec: 'spine-parts-scene-report/1',
    scene: partsScene,
    canvas: { width: 64, height: 48 },
    characters: [{ id: 'actor', build: `../../${composeStage}`, offset: [0, 0], scale: 1, rig_size: [64, 48], shift: [0, 0] }],
    plates: [{ name: 'backdrop', image: '../../inputs/backdrop.png', at: [0, 0], opaque_backdrop: true, sha256: backdropSha }],
  }, null, 2) + '\n');
  writeFileSync(join(dir, `${directionFrom}/${COMPOSE_RUN_PATH}`), JSON.stringify({
    spec: 'rig-compose-run/1',
    scene: { path: partsScene, sha256: sha256(readFileSync(join(dir, partsScene))) },
    characters: [{
      id: 'actor',
      build: `../../${composeStage}`,
      files: treeFiles(dir, composeStage).map(({ path, sha256: digest }) => ({
        path: path.slice(composeStage.length + 1),
        sha256: digest,
      })),
    }],
    plate: null,
    plates: [{ name: 'backdrop', path: '../../inputs/backdrop.png', sha256: backdropSha }],
  }, null, 2) + '\n');
  expect(recordCommand(['direction', dir, '--from', directionFrom, '--direction', CURRENT_DIRECTION_PATH], Date.parse(recordAt)).exit).toBe(0);
}

function stageCameraReport({ modelMatches = true, track = 'idle', duration = 4, loop = true } = {}) {
  const f = cloneFixture();
  const sourcePath = 'specs/direction/compose-camera.json';
  const from = 'outputs/direction.next';
  const modelPath = 'check/build/skeleton.model.json';
  const read = (path: string): JsonObject => JSON.parse(readFileSync(join(f.dir, path), 'utf8')) as JsonObject;
  const put = (path: string, value: JsonObject): string => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(join(f.dir, path), bytes);
    return sha256(bytes);
  };
  const backdrop = 'backdrop';
  const source = read('specs/direction/compose-scene.json');
  const keys = [{ t: 0, pan: [0, 0], zoom: 1 }, { t: 4, pan: [0, 0], zoom: 1 }];
  source.camera = { backdrop, tracks: { [track]: keys } };
  const sourceSha = put(sourcePath, source);
  expect(sceneCommand(['write', f.dir, '--compose-scene', sourcePath], Date.parse('2026-11-26T09:11:00Z')).exit).toBe(0);
  expect(directionCommand(['write', f.dir, '--file', 'evidence/intent-revised.json']).exit).toBe(0);
  cpSync(join(f.dir, 'outputs/direction'), join(f.dir, from), { recursive: true });
  const modelSha = sha256(readFileSync(join(f.dir, from, modelPath)));
  put(`${from}/${COMPOSE_RUN_PATH}`, { ...read(`${from}/${COMPOSE_RUN_PATH}`), scene: { path: sourcePath, sha256: sourceSha } });
  const reportSha = put(`${from}/scene.json`, { ...read(`${from}/scene.json`), spec: 'spine-parts-scene-report/2', scene: sourcePath,
    camera: { backdrop, model_sha256: modelMatches ? modelSha : '0'.repeat(64),
      tracks: { [track]: { duration, compiled_duration: 4, loop, keys } } } });
  const record = (now = Date.parse('2026-11-26T09:12:00Z')) =>
    recordCommand(['direction', f.dir, '--from', from, '--direction', CURRENT_DIRECTION_PATH], now);
  return { f, record, source, sourcePath, sourceSha, read, put, bindings: {
    report: { path: 'outputs/direction/scene.json', sha256: reportSha },
    model: { path: `outputs/direction/${modelPath}`, sha256: modelSha },
  } };
}

test('camera options bind distinct retained scene files and can include an unkeyed choice', () => {
  const { f, source, sourcePath, sourceSha, put, read, record } = stageCameraReport();
  const project = f.load();
  const answer = collectItems(project, { collection: null }).find(item => item.id === 'post_composition')!.raw as JsonObject;
  const choice = answer.choice as JsonObject;
  const setBinding = choice.set as JsonObject;
  const setPath = String(setBinding.path);
  const set = read(setPath);
  const ask = objects(set.asks)[0]!;
  const options = objects(ask.options).filter(option => option.kind === 'value');
  const keep = options.find(option => option.id === objects(choice.picks)[0]!.option_id)!;
  const other = options.find(option => option !== keep)!;
  const first = { path: sourcePath, sha256: sourceSha };
  const secondPath = 'specs/direction/compose-other-camera.json';
  const second = { path: secondPath, sha256: put(secondPath, { ...source, camera: {
    backdrop: 'backdrop', tracks: { idle: [{ t: 0, pan: [2, 0], zoom: 1 }] },
  } }) };
  const plain = structuredClone(other);
  plain.id = 'plain';
  plain.recommended = false;
  (keep.fragment as JsonObject).compose = { ...((keep.fragment as JsonObject).compose as JsonObject), camera_scene: first };
  (other.fragment as JsonObject).compose = { ...((other.fragment as JsonObject).compose as JsonObject), camera_scene: second };
  ask.options = [...objects(ask.options), plain];
  validateCameraOptions(f.dir, set);
  put(secondPath, { ...source, camera: undefined } as unknown as JsonObject);
  expect(() => validateCameraOptions(f.dir, set)).toThrow(expect.objectContaining({ code: 'INTERVIEW_CAMERA_SCENE_INVALID' }));
  put(secondPath, { ...source, camera: { backdrop: 'backdrop', tracks: { idle: [{ t: 0, pan: [2, 0], zoom: 1 }] } } });
  choice.set = { path: setPath, sha256: put(setPath, set) };
  answer.value = keep.fragment!;
  f.save(project);

  const now = Date.parse(CAMERA_SCENE_BINDING_SINCE);
  const write = (path: string) => sceneCommand(['write', f.dir, '--compose-scene', path], now);
  const before = readFileSync(join(f.dir, 'specs/direction/scene.json'));
  refusesByteIdentical(f.dir, 'SCENE_CAMERA_CHOICE_MISMATCH', 1, () => write(secondPath));
  expect(readFileSync(join(f.dir, 'specs/direction/scene.json'))).toEqual(before);
  expect(write(sourcePath).exit).toBe(0);
  expect(read('specs/direction/scene.json').compose).toEqual(first);
  testClock.set(now);
  expect(directionCommand(['write', f.dir, '--file', 'evidence/intent-revised.json']).exit).toBe(0);
  expect(record(now).exit).toBe(0);
  expect(checkProject(f.dir).refusals.filter(finding => finding.code.startsWith('SCENE_CAMERA_CHOICE_'))).toEqual([]);
  const plainPath = 'specs/direction/compose-scene.json';
  refusesByteIdentical(f.dir, 'SCENE_CAMERA_CHOICE_MISSING', 1, () => write(plainPath));
  expect(read('specs/direction/scene.json').compose).toEqual(first);
  for (const value of [readFileSync(join(f.dir, setPath), 'utf8'), JSON.stringify(answer)]) {
    expect(value).not.toMatch(/"(pan|zoom|t)"\s*:/);
  }

  const legacy = sceneCommand(['write', f.dir, '--compose-scene', plainPath], now - 3000);
  expect(legacy.stderr).toContain('WARN SCENE_CAMERA_CHOICE_MISSING');
  const intentPath = 'evidence/intent-revised.json';
  const directionBytes = readFileSync(join(f.dir, CURRENT_DIRECTION_PATH));
  refusesByteIdentical(f.dir, 'SCENE_CAMERA_CHOICE_MISSING', 1, () =>
    directionCommand(['write', f.dir, '--file', intentPath]));
  expect(readFileSync(join(f.dir, CURRENT_DIRECTION_PATH))).toEqual(directionBytes);
  restageAndRecordDirection(f.dir, intentPath, 2, new Date(now - 2000).toISOString(), new Date(now - 1000).toISOString());
  const legacyReport = checkProject(f.dir);
  expect(legacyReport.warnings).toContainEqual(expect.objectContaining({ code: 'SCENE_CAMERA_CHOICE_MISSING', path: plainPath }));
  expect(legacyReport.refusals.map(finding => finding.code)).not.toContain('SCENE_CAMERA_CHOICE_MISSING');
  cpSync(join(f.dir, 'outputs/direction'), join(f.dir, 'outputs/direction.next'), { recursive: true });
  refusesByteIdentical(f.dir, 'SCENE_CAMERA_CHOICE_MISSING', 1, () => record(now));
  const recorded = f.load();
  ((recorded.current as JsonObject).direction as JsonObject).at = CAMERA_SCENE_BINDING_SINCE;
  expect(checkProject(f.dir, recorded).refusals).toContainEqual(expect.objectContaining({
    code: 'SCENE_CAMERA_CHOICE_MISSING', path: plainPath,
  }));
});

test('scene and direction writes date the missing keyed camera choice', () => {
  const { f, sourcePath } = stageCameraReport();
  const cutoff = Date.parse(CAMERA_SCENE_BINDING_SINCE);
  const args = ['write', f.dir, '--compose-scene', sourcePath];
  const sceneFile = join(f.dir, 'specs/direction/scene.json');
  const before = readFileSync(sceneFile);
  expect(sceneCommand(args, cutoff - 1).stderr).toContain('WARN SCENE_CAMERA_CHOICE_MISSING');
  expect(readFileSync(sceneFile)).toEqual(before);
  refusesByteIdentical(f.dir, 'SCENE_CAMERA_CHOICE_MISSING', 1, () => sceneCommand(args, cutoff));
  testClock.set(cutoff);
  refusesByteIdentical(f.dir, 'SCENE_CAMERA_CHOICE_MISSING', 1,
    () => directionCommand(['write', f.dir, '--file', 'evidence/intent-revised.json']));
  expect(readFileSync(sceneFile)).toEqual(before);
});

test.each([
  { binding: 'matching', modelMatches: true },
  { binding: 'mismatched', modelMatches: false },
])('current direction records and publishes a camera report with a $binding model hash', ({ modelMatches }) => {
  const { f, record, bindings } = stageCameraReport({ modelMatches });
  if (!modelMatches) {
    refusesByteIdentical(f.dir, 'DIRECTION_COMPOSE_CAMERA_MODEL', 1, record);
    return;
  }

  expect(record().exit).toBe(0);
  const project = f.load();
  const checked = checkProject(f.dir, project);
  expect(checked.warnings.map(finding => finding.code)).toContain('SCENE_CAMERA_CHOICE_MISSING');
  expect(checked.refusals.map(finding => finding.code)).not.toContain('SCENE_CAMERA_CHOICE_MISSING');
  expect(((project.current as JsonObject).direction as JsonObject).files).toEqual(expect.arrayContaining(Object.values(bindings).map(binding => expect.objectContaining(binding))));
  const publication = inspectCurrentPublication(f.dir, project, 'direction', sha256(readFileSync(join(f.dir, 'project.json'))));
  expect(publication.closureFiles).toEqual(expect.arrayContaining(Object.values(bindings)));
  const written = prepareCurrentManifest(f.dir, project, 'direction', sha256(readFileSync(join(f.dir, 'project.json'))));
  expect(written.closurePaths).toContain(bindings.report.path);
  const manifestBytes = readFileSync(join(f.dir, written.path));
  expect(manifestBytes.equals(publication.manifestBytes)).toBe(true);
  const manifest = JSON.parse(manifestBytes.toString()) as JsonObject;
  expect(manifest.model).toBe(bindings.model.path);
  expect(manifest.sceneReport).toEqual({
    path: bindings.report.path, sha256: sha256(readFileSync(join(f.dir, bindings.report.path))),
  });
  const fields = Object.keys(manifest);
  expect(fields[fields.indexOf('model') + 1]).toBe('sceneReport');
});

test.each([
  { variant: '/1', baseline: '4fba40fd473369917436bebc605c250524e709811ad6724bc32912eccf242b4b' },
  { variant: '/2 without an idle track', baseline: 'c6ff475c57f6d6b64a19776628f657b8a37bc989a8a76603873d3c3fe537814c' },
])('current direction manifest keeps its existing bytes for $variant', ({ variant, baseline }) => {
  const f = (() => {
    if (variant === '/1') return cloneFixture();
    const camera = stageCameraReport({ track: 'alternate' });
    expect(camera.record().exit).toBe(0);
    return camera.f;
  })();
  const publication = inspectCurrentPublication(f.dir, f.load(), 'direction', sha256(readFileSync(join(f.dir, 'project.json'))));
  expect(JSON.parse(publication.manifestBytes.toString())).not.toHaveProperty('sceneReport');
  expect(sha256(publication.manifestBytes)).toBe(baseline);
});

test.each([
  { field: 'duration', duration: 3.999999, loop: true },
  { field: 'loop', duration: 4, loop: false },
])('current direction publication refuses an idle camera track with mismatched authored $field', ({ field, duration, loop }) => {
  const { f, record } = stageCameraReport({ duration, loop });
  expect(record().exit).toBe(0);
  refusesByteIdentical(f.dir, 'DIRECTION_TAKE_MISMATCH', 1, () =>
    prepareCurrentManifest(f.dir, f.load(), 'direction', sha256(readFileSync(join(f.dir, 'project.json')))));
  expect(() => inspectCurrentPublication(f.dir, f.load(), 'direction', sha256(readFileSync(join(f.dir, 'project.json')))))
    .toThrow(expect.objectContaining({ message: expect.stringContaining(`camera.tracks.idle.${field}`) }));
});

test('current direction publication refuses a changed scene report seal and a sealed report for a different model', () => {
  const { f, record, bindings } = stageCameraReport();
  expect(record().exit).toBe(0);
  const path = join(f.dir, bindings.report.path);
  const report = readFileSync(path, 'utf8');
  const publish = () => prepareCurrentManifest(f.dir, f.load(), 'direction', sha256(readFileSync(join(f.dir, 'project.json'))));
  writeFileSync(path, report.slice(0, -1) + ' ');
  refusesByteIdentical(f.dir, 'JOB_PUBLICATION_INVALID', 1, publish);

  // Seal the new bytes to isolate the report-to-model binding from the report's file seal.
  writeFileSync(path, report.replace(bindings.model.sha256, '0'.repeat(64)));
  const project = f.load();
  const direction = (project.current as JsonObject).direction as JsonObject;
  const files = treeFiles(f.dir, 'outputs/direction');
  direction.files = files;
  direction.files_sha256 = outputSetHash(files);
  f.save(project);
  refusesByteIdentical(f.dir, 'DIRECTION_COMPOSE_CAMERA_MODEL', 1, publish);
});

test('current-direction correction fixture reproduces byte-for-byte through writers and passes check', () => {
  const generated = generateCurrentDirectionCorrectionFixture(join(tempDir(), 'fresh'));
  for (const [path, bytes] of Object.entries(generated)) {
    const committed = join(FIXTURE_ROOT, path);
    expect(existsSync(committed)).toBe(true);
    expect(readFileSync(committed).equals(bytes)).toBe(true);
  }
  const f = cloneFixture();
  const project = f.load();
  const record = (project.corrections as JsonObject[])[0]!;
  expect(record.schema).toBe(DIRECTION_CORRECTION_SPEC);
  expect(record.on).toMatchObject({
    kind: 'current.direction',
    direction: { path: CURRENT_DIRECTION_PATH },
  });
  expect(record.outcome).toEqual(currentDirectionIdentity(project));
  expect((record.on as JsonObject).record_sha256).not.toBe((record.outcome as JsonObject).record_sha256);
  expect(((record.on as JsonObject).direction as JsonObject).sha256).not.toBe(((record.outcome as JsonObject).direction as JsonObject).sha256);
  expect(findings(f.dir)).toEqual({ dir: f.dir, project, refusals: [], warnings: [] });
});

test('recording without --version binds current.direction, gates direction-review signoff, and resolves after current.direction changes', () => {
  const f = cloneFixture('2026-11-26T09:10:00Z');
  const openingExpected = currentDirectionIdentity(f.load());
  const recorded = correctionCommand([
    'record', f.dir, '--id', 'second-pass', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'), '--json',
  ]);
  expect(recorded.exit).toBe(0);
  const openRecord = JSON.parse(recorded.stdout) as JsonObject;
  expect(openRecord.schema).toBe(DIRECTION_CORRECTION_SPEC);
  expect(openRecord.on).toEqual(openingExpected);
  expect(openRecord.outcome).toBeNull();
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings.map(w => w.code)).toEqual(['CORRECTION_OPEN']);
  expect(correctionApprovalFindings(f.load(), 'direction-review').map(x => x.code)).toEqual(['CORRECTION_PENDING']);

  // Relaying a direction-review signoff while the correction is open refuses byte-identically.
  writeFileSync(join(f.dir, 'approve.txt'), 'Approve the current direction.\n');
  testClock.set(new Date('2026-11-26T09:11:00Z'));
  refusesByteIdentical(f.dir, 'CORRECTION_PENDING', 1, () => signoffCommand([
    'direction-review', f.dir, '--by', 'owner', '--owner-chat', join(f.dir, 'approve.txt'),
    '--said-at', '2026-11-26T09:10:30Z', '--relayed-by', 'operator',
  ]));

  // Resolving before current.direction changes refuses with CORRECTION_OUTCOME and leaves project.json byte-identical.
  testClock.set(new Date('2026-11-26T09:12:00Z'));
  refusesByteIdentical(f.dir, 'CORRECTION_OUTCOME', 1, () => correctionCommand([
    'resolve', 'second-pass', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
  ]));

  // Re-recording the exact same direction spec without changing its sha256 also cannot resolve the correction.
  expect(recordCommand(['direction', f.dir, '--from', 'outputs/direction', '--direction', CURRENT_DIRECTION_PATH], Date.parse('2026-11-26T09:13:00Z')).exit).toBe(0);
  testClock.set(new Date('2026-11-26T09:14:00Z'));
  refusesByteIdentical(f.dir, 'CORRECTION_OUTCOME', 1, () => correctionCommand([
    'resolve', 'second-pass', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
  ]));

  // Updating current.direction with a changed direction spec allows resolve without --version, and a further rebuild keeps earlier records valid.
  restageAndRecordDirection(f.dir, 'evidence/intent-initial.json', 3, '2026-11-26T09:15:00Z', '2026-11-26T09:16:00Z');
  const closingExpected = currentDirectionIdentity(f.load());
  testClock.set(new Date('2026-11-26T09:17:00Z'));
  const resolved = correctionCommand([
    'resolve', 'second-pass', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'), '--json',
  ]);
  expect(resolved.exit).toBe(0);
  const closedRecord = JSON.parse(resolved.stdout) as JsonObject;
  expect(closedRecord.outcome).toEqual(closingExpected);
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings).toEqual([]);

  // A subsequent rebuild of current.direction preserves both earlier closed corrections without refusal.
  restageAndRecordDirection(f.dir, 'evidence/intent-revised.json', 4, '2026-11-26T09:18:00Z', '2026-11-26T09:19:00Z');
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings).toEqual([]);

  // Owner chat signoff now succeeds.
  testClock.set(new Date('2026-11-26T09:20:00Z'));
  expect(signoffCommand([
    'direction-review', f.dir, '--by', 'owner', '--owner-chat', join(f.dir, 'approve.txt'),
    '--said-at', '2026-11-26T09:19:30Z', '--relayed-by', 'operator',
  ]).exit).toBe(0);
  expect(findings(f.dir).refusals).toEqual([]);
});

test('missing, malformed or spec-unbound current.direction and invalid flag combinations refuse byte-identically', () => {
  const f = cloneFixture('2026-11-26T09:10:00Z');

  // --model-file without --version is a usage refusal (exit 2).
  refusesByteIdentical(f.dir, 'CORRECTION_USAGE', 2, () => correctionCommand([
    'record', f.dir, '--id', 'bad-flag', '--path', 'described', '--stage', 'direction-review',
    '--model-file', 'outputs/direction/check/build/skeleton.model.json', '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]));

  // Omitting selector flags on rig-review or made path remains a usage refusal (exit 2).
  refusesByteIdentical(f.dir, 'CORRECTION_USAGE', 2, () => correctionCommand([
    'record', f.dir, '--id', 'rig-missing-selector', '--path', 'described', '--stage', 'rig-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]));

  // Passing --version or --model-file when resolving a current.direction correction is a usage refusal (exit 2).
  correctionCommand([
    'record', f.dir, '--id', 'open-current', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]);
  for (const extra of [['--version', '1'], ['--model-file', 'outputs/direction/check/build/skeleton.model.json'], ['--draft', 'd1']]) {
    refusesByteIdentical(f.dir, 'CORRECTION_USAGE', 2, () => correctionCommand([
      'resolve', 'open-current', f.dir, ...extra, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
    ]));
  }

  // Missing current.direction refuses record with CORRECTION_SOURCE and resolve with CORRECTION_OUTCOME.
  const withoutDirection = f.load();
  withoutDirection.corrections = [];
  delete (withoutDirection.current as JsonObject).direction;
  f.save(withoutDirection);
  refusesByteIdentical(f.dir, 'CORRECTION_SOURCE', 1, () => correctionCommand([
    'record', f.dir, '--id', 'no-current', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]));

  // Unbound specs/direction/direction.json in current.direction.built_from refuses before writing.
  const restored = cloneFixture('2026-11-26T09:10:00Z');
  const missingSpec = restored.load();
  missingSpec.corrections = [];
  const dirNode = (missingSpec.current as JsonObject).direction as JsonObject;
  dirNode.built_from = (dirNode.built_from as JsonObject[]).filter(row => row.path !== CURRENT_DIRECTION_PATH);
  restored.save(missingSpec);
  refusesByteIdentical(restored.dir, 'CORRECTION_SOURCE', 1, () => correctionCommand([
    'record', restored.dir, '--id', 'unbound-spec', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(restored.dir, 'words.txt'),
  ]));
});

test('check refuses tampered on or outcome hashes and schema downgrades on current.direction records', () => {
  const f = cloneFixture('2026-11-26T09:10:00Z');
  correctionCommand([
    'record', f.dir, '--id', 'tamper-open', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'),
  ]);

  // One-byte edits to open record_sha256 or direction.sha256 refuse with DIRECTION_CORRECTION_OUTCOME.
  for (const mutate of [
    (on: JsonObject) => { const h = String(on.record_sha256); on.record_sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
    (on: JsonObject) => { const d = on.direction as JsonObject; const h = String(d.sha256); d.sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
    (on: JsonObject) => { (on.direction as JsonObject).path = 'specs/direction/other.json'; },
  ]) {
    const candidate = f.load();
    mutate((candidate.corrections as JsonObject[]).at(-1)!.on as JsonObject);
    expect(findings(f.dir, candidate).refusals.map(r => r.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  }

  // One-byte edits to closed outcome record_sha256 or direction.sha256 also refuse with DIRECTION_CORRECTION_OUTCOME.
  for (const mutate of [
    (outcome: JsonObject) => { const h = String(outcome.record_sha256); outcome.record_sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
    (outcome: JsonObject) => { const d = outcome.direction as JsonObject; const h = String(d.sha256); d.sha256 = (h[0] === '0' ? '1' : '0') + h.slice(1); },
  ]) {
    const candidate = f.load();
    mutate((candidate.corrections as JsonObject[])[0]!.outcome as JsonObject);
    expect(findings(f.dir, candidate).refusals.map(r => r.code)).toContain('DIRECTION_CORRECTION_OUTCOME');
  }

  // Downgrading a current.direction correction to @1 refuses with CORRECTION_MALFORMED.
  const downgraded = f.load();
  (downgraded.corrections as JsonObject[]).at(-1)!.schema = 'rig-create/correction@1';
  expect(findings(f.dir, downgraded).refusals.map(r => r.code)).toContain('CORRECTION_MALFORMED');
});

test('adopted current.direction binds its legacy direction document on record and resolves against canonical current.direction; --version keeps working', () => {
  const dir = join(tempDir(), 'adopted');
  cpSync(join(import.meta.dir, '../templates/example-numbered/example-direction'), dir, { recursive: true });
  // Keep --version working unchanged on numbered posts.
  testClock.set(new Date('2026-11-06T10:00:00Z'));
  const numbered = correctionCommand([
    'record', dir, '--id', 'legacy-versioned', '--path', 'described', '--stage', 'direction-review',
    '--version', '3', '--by', 'user', '--verbatim-file', join(dir, 'words.txt'), '--json',
  ]);
  expect(numbered.exit).toBe(0);
  const p0 = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(JSON.parse(numbered.stdout).on).toEqual(directionPostIdentity(dir, p0, 3));
  testClock.set(new Date('2026-11-06T10:05:00Z'));
  expect(seedRetainedDirectionPost(['write', '4', dir, '--file', 'evidence/input.json', '--rig', '1'], testClock.now()).exit).toBe(0);
  testClock.set(new Date('2026-11-06T10:10:00Z'));
  expect(correctionCommand([
    'resolve', 'legacy-versioned', dir, '--version', '4', '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'),
  ]).exit).toBe(0);

  // Adopt direction in place on a synthetic composed post, record a correction without --version, then rebuild canonical current.direction and resolve.
  const f = cloneFixture('2026-11-26T09:10:00Z');
  const project = f.load();
  const canonicalDirection = structuredClone((project.current as JsonObject).direction as JsonObject);
  const v4DocPath = 'evidence/direction/v4.json';
  mkdirSync(dirname(join(f.dir, v4DocPath)), { recursive: true });
  writeFileSync(join(f.dir, v4DocPath), '{"synthetic":"legacy direction v4"}\n');
  const v4Sha = sha256(readFileSync(join(f.dir, v4DocPath)));
  const composeFilePath = 'outputs/v4/compose/scene.json';
  mkdirSync(dirname(join(f.dir, composeFilePath)), { recursive: true });
  const composeBytes = Buffer.from('{"spec":"spine-parts-scene-report/1"}\n');
  writeFileSync(join(f.dir, composeFilePath), composeBytes);
  const composeSha = sha256(composeBytes);
  project.versions = [{
    n: 4,
    kind: 'post',
    rig_version: 1,
    at: '2026-11-26T08:30:00.000Z',
    built_by: 'agent',
    built_with: { create: 'direction@3' },
    outputs: [
      { path: v4DocPath, sha256: v4Sha },
      { path: composeFilePath, sha256: composeSha, bytes: composeBytes.length },
    ],
    provenance: { config: { path: v4DocPath, sha256: v4Sha }, direction: { path: v4DocPath, sha256: v4Sha }, sections: {} },
  }];
  project.corrections = [];
  delete (project.current as JsonObject).direction;
  f.save(project);

  expect(recordCommand(['direction', f.dir, '--adopt'], Date.parse('2026-11-26T09:11:00Z')).exit).toBe(0);
  testClock.set(new Date('2026-11-26T09:12:00Z'));
  const adoptedRecord = correctionCommand([
    'record', f.dir, '--id', 'from-adopted', '--path', 'described', '--stage', 'direction-review',
    '--by', 'owner', '--verbatim-file', join(f.dir, 'words.txt'), '--json',
  ]);
  expect(adoptedRecord.exit).toBe(0);
  expect((JSON.parse(adoptedRecord.stdout) as JsonObject).on).toMatchObject({
    kind: 'current.direction',
    direction: { path: v4DocPath, sha256: v4Sha },
  });

  // Replace adopted current.direction with a fresh canonical current.direction and resolve without --version.
  const afterAdopt = f.load();
  afterAdopt.versions = [];
  (afterAdopt.current as JsonObject).direction = { ...canonicalDirection, at: '2026-11-26T09:15:00.000Z' };
  f.save(afterAdopt);
  testClock.set(new Date('2026-11-26T09:16:00Z'));
  expect(correctionCommand([
    'resolve', 'from-adopted', f.dir, '--by', 'agent', '--reasoning-file', join(f.dir, 'reasoning.txt'),
  ]).exit).toBe(0);
  expect(findings(f.dir).refusals).toEqual([]);
  expect(findings(f.dir).warnings).toEqual([]);
  expect(checkProject(f.dir).refusals.filter(r => r.path.startsWith('corrections') || r.path.startsWith('current') || r.path.startsWith('signoffs'))).toEqual([]);
});
