import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { plantLegacyReopen } from './fixtures.ts';
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { directionHash, directionPostIdentity, objects, readDirection, validateDirectionShape } from '../src/direction.ts';
import { composeInventory, composeRunMatchesAcceptedRig, composeScenePath, readComposeRun } from '../src/direction-compose.ts';
import { prepareLiveManifest, readPublished, REVIEW_REFUSED_JOB_PATH } from '../src/job-publication.ts';
import { composeFixture, composeRunFixture } from './direction-compose-fixture.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import { checkDirections, directionCommand, testClock } from './clock.ts';
import { seedRetainedDirectionPost } from './numbered-seed.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); testClock.reset(); });
function fixture(...args: Parameters<typeof composeFixture>) { const f = composeFixture(...args); roots.push(f.dir); return f; }
function rejected(f: ReturnType<typeof fixture>, code: string, run?: () => unknown) {
  expect(() => {
    if (run) {
      run();
    } else {
      f.publish();
    }
    return readDirection(f.dir, f.load(), 2, true);
  }).toThrow(expect.objectContaining({ code }));
}

test('direction@3 freezes a two-plate idle, fills the rig seal and checks without scene write', () => {
  const f = fixture(); expect(f.publish().exit).toBe(0);
  const p = f.load(); const doc = readDirection(f.dir, p, 2, true);
  expect((doc.rig as JsonObject).acceptance).toBeDefined();
  expect(doc.camera).toBeUndefined(); expect(doc.timing).toBeUndefined(); expect(doc.scene).toBeUndefined(); expect(p.scenes).toBeUndefined();
  expect(directionPostIdentity(f.dir, p, 2).model).toEqual(doc.model);
  expect(directionCommand(['check', '2', f.dir, '--json']).exit).toBe(0);
  const ctx = { dir: f.dir, project: p, refusals: [], warnings: [] }; checkDirections(ctx);
  expect(ctx.refusals).toEqual([]); expect(ctx.warnings).toEqual([]);
  expect(readFileSync(join(f.dir, 'outputs/v2/compose/check/build/skeleton.atlas'), 'utf8')).toBe('synthetic atlas');
});

test.each([
  { binding: 'matching', modelMatches: true },
  { binding: 'mismatched', modelMatches: false },
])('direction@3 validates and publishes a camera report with a $binding model hash', async ({ modelMatches }) => {
  const f = fixture();
  const backdrop = f.value.plates[0]!.name;
  f.scene.camera = { backdrop, tracks: { idle: [{ t: 0, pan: [0, 0], zoom: 1 }, { t: 4, pan: [0, 0], zoom: 1 }] } };
  f.put('compose.scene.json', f.scene);
  f.put('compose-out/compose-run.json', composeRunFixture(f.dir, f.load(), 1, f.scene));
  const modelSha = directionHash(readFileSync(join(f.dir, 'compose-out/check/build/skeleton.model.json')));
  const report = f.put('compose-out/scene.json', { ...f.report, spec: 'spine-parts-scene-report/2',
    camera: { backdrop, model_sha256: modelMatches ? modelSha : '0'.repeat(64) } });
  if (!modelMatches) {
    rejected(f, 'DIRECTION_COMPOSE_CAMERA_MODEL');
    return;
  }

  expect(f.publish().exit).toBe(0);
  const project = f.load();
  const ctx = { dir: f.dir, project, refusals: [], warnings: [] };
  checkDirections(ctx);
  expect(ctx.refusals).toEqual([]);
  expect(ctx.warnings).toContainEqual(expect.objectContaining({
    code: 'SCENE_CAMERA_CHOICE_MISSING', path: 'compose.scene.json',
  }));
  const doc = readDirection(f.dir, project, 2);
  const reportBinding = { path: 'outputs/v2/compose/scene.json', sha256: report.sha256 };
  const modelBinding = { path: 'outputs/v2/compose/check/build/skeleton.model.json', sha256: modelSha };
  expect(composeInventory(project, doc)).toEqual(expect.arrayContaining([reportBinding, modelBinding]));
  const path = prepareLiveManifest(f.dir, project, 2);
  const pub = await readPublished({ root: f.dir,
    record: { path: 'project.json', sha256: directionHash(readFileSync(join(f.dir, 'project.json'))) },
    result: { path, selector: { kind: 'post', version: 2, rigVersion: 1 } },
  });
  const direction = pub.files.find(file => file.path === 'evidence/direction/v2.json')!;
  const directionBytes = readFileSync(join(f.dir, direction.path));
  expect(direction.sha256).toBe(directionHash(directionBytes));
  expect(JSON.parse(directionBytes.toString())).toMatchObject({ compose: { report: reportBinding }, model: modelBinding });
  expect(pub.files).toContainEqual(modelBinding);
  appendFileSync(join(f.dir, reportBinding.path), '\n');
  expect(() => prepareLiveManifest(f.dir, project, 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_HASH' }));
});

test('direction@3 publishes the compose model, atlas and pages without the character package', async () => {
  const { jobPath } = await import('../node_modules/@rig-c/review/src/job-api.ts');
  const f = fixture();
  f.put('compose-out/check/extremes/a:idle/extremes.json', { extremes: [] });
  expect(f.publish().exit).toBe(0);
  const recordBefore = readFileSync(join(f.dir, 'project.json'));
  const p = f.load();
  const docBefore = readDirection(f.dir, p, 2);
  const inventoryBefore = structuredClone(composeInventory(p, docBefore));
  expect(inventoryBefore.map(row => row.path)).toEqual([
    'outputs/v2/compose/check/build/page.png',
    'outputs/v2/compose/check/build/skeleton.atlas',
    'outputs/v2/compose/check/build/skeleton.model.json',
    'outputs/v2/compose/check/check.json',
    'outputs/v2/compose/check/extremes/a:idle/extremes.json',
    'outputs/v2/compose/compose-run.json',
    'outputs/v2/compose/scene.json',
  ]);
  expect(() => jobPath('outputs/v2/compose/check/extremes/a:idle/extremes.json')).toThrow();
  const path = prepareLiveManifest(f.dir, p, 2);
  const manifest = JSON.parse(readFileSync(join(f.dir, path), 'utf8'));
  expect(manifest.model).toBe('outputs/v2/compose/check/build/skeleton.model.json');
  expect(manifest.scene).toBeUndefined();
  const pub = await readPublished({
    root: f.dir,
    record: { path: 'project.json', sha256: directionHash(readFileSync(join(f.dir, 'project.json'))) },
    result: { path, selector: { kind: 'post', version: 2, rigVersion: 1 } },
  });
  expect(pub.files).toEqual([
    { path: 'outputs/v2/compose/check/build/page.png', sha256: directionHash(readFileSync(join(f.dir, 'outputs/v2/compose/check/build/page.png'))) },
    { path: 'outputs/v2/compose/check/build/skeleton.atlas', sha256: directionHash(readFileSync(join(f.dir, 'outputs/v2/compose/check/build/skeleton.atlas'))) },
    { path: 'outputs/v2/compose/check/build/skeleton.model.json', sha256: directionHash(readFileSync(join(f.dir, 'outputs/v2/compose/check/build/skeleton.model.json'))) },
    { path: 'evidence/direction/v2.json', sha256: directionHash(readFileSync(join(f.dir, 'evidence/direction/v2.json'))) },
    { path: 'review-live-v2.json', sha256: directionHash(readFileSync(join(f.dir, 'review-live-v2.json'))) },
  ]);
  for (const file of pub.files) {
    expect(REVIEW_REFUSED_JOB_PATH.test(file.path)).toBe(false);
    expect(jobPath(file.path)).toBe(file.path);
  }
  expect(pub.files.some(file => file.path.startsWith('derived/review/'))).toBe(false);
  expect(pub.parts).toBeNull();
  expect(pub.partIds).toEqual([]);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(recordBefore);
  const pAfter = f.load();
  expect(composeInventory(pAfter, readDirection(f.dir, pAfter, 2))).toEqual(inventoryBefore);
});

test('direction@3 writes and checks a composed idle with empty scene tracks', () => {
  const f = fixture(undefined, true);
  expect(f.publish().exit).toBe(0);
  expect(directionCommand(['check', '2', f.dir, '--json']).exit).toBe(0);
  const ctx = { dir: f.dir, project: f.load(), refusals: [], warnings: [] };
  checkDirections(ctx);
  expect(ctx.refusals).toEqual([]);
  expect(ctx.warnings).toEqual([]);
});

test('DIRECTION_COMPOSE_CHOICE_MISMATCH refuses a scene without animations for an empty-track citation', () => {
  const f = fixture(undefined, true);
  delete f.scene.animations;
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  f.publish();
  expect(() => readDirection(f.dir, f.load(), 2, true)).toThrow(expect.objectContaining({
    code: 'DIRECTION_COMPOSE_CHOICE_MISMATCH',
    message: expect.stringContaining('"animations": {"idle": {"duration": 4, "tracks": []}}'),
  }));
});

test.each([
  { citation: 'empty', emptyTracks: true },
  { citation: 'nonempty', emptyTracks: false },
])('DIRECTION_COMPOSE_CHOICE_MISMATCH refuses a track present on only one side with a $citation citation', ({ emptyTracks }) => {
  const f = fixture(undefined, emptyTracks);
  const tracks = emptyTracks
    ? [{ bone: 'back', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 4, v: [0, 0] }] }]
    : [];
  f.scene.animations = { idle: { duration: 4, tracks } };
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_CHOICE_MISMATCH');
});

test('DIRECTION_COMPOSE_DURATION refuses a mismatched scene idle duration with empty tracks', () => {
  const f = fixture(undefined, true);
  f.scene.animations = { idle: { duration: 5, tracks: [] } };
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_DURATION');
});

test('JOB_PUBLICATION_INVALID refuses a declared build file whose name contains : before anything is written', async () => {
  const f = fixture();
  f.put('compose-out/check/build/a:idle.png', 'synthetic bad build file');
  expect(f.publish().exit).toBe(0);
  const before = readFileSync(join(f.dir, 'project.json'));
  const p = f.load();
  let failure: unknown;
  try {
    prepareLiveManifest(f.dir, p, 2);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'JOB_PUBLICATION_INVALID' });
  expect((failure as Error).message).toContain('outputs/v2/compose/check/build/a:idle.png');
  expect((failure as Error).message).toContain('[\\:%?#]');
  expect(existsSync(join(f.dir, 'review-live-v2.json'))).toBe(false);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  await expect(
    readPublished({
      root: f.dir,
      record: { path: 'project.json', sha256: directionHash(before) },
      result: { path: 'review-live-v2.json', selector: { kind: 'post', version: 2, rigVersion: 1 } },
    }),
  ).rejects.toMatchObject({
    code: 'JOB_PUBLICATION_INVALID',
    message: expect.stringContaining('outputs/v2/compose/check/build/a:idle.png'),
  });
  const { clockedCli } = await import('./helpers.ts');
  const { jobHostStateRoot, jobPrivateRoot, readWriterBinding } = await import('../src/job-outbox.ts');
  const open = Bun.spawnSync([process.execPath, ...clockedCli(), 'job', 'open', f.dir,
    '--rig', '2', '--reviewer', 'reviewer', '--role', 'owner'], { cwd: f.dir, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(open.exitCode).toBe(1);
  expect(open.stdout.toString()).toBe('');
  expect(open.stderr.toString()).toContain('JOB_PUBLICATION_INVALID:');
  expect(open.stderr.toString()).toContain('outputs/v2/compose/check/build/a:idle.png');
  expect(readWriterBinding(f.dir)).toBeNull();
  expect(existsSync(jobHostStateRoot(f.dir))).toBe(false);
  expect(existsSync(jobPrivateRoot(f.dir))).toBe(false);
  expect(existsSync(join(f.dir, 'review-live-v2.json'))).toBe(false);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

test('explicit rig and uncomposed post preflight still require the parent review package', async () => {
  const { assertRequestedRig } = await import('../src/job-host.ts');
  const { sceneFixture } = await import('./scene-fixture.ts');
  const { DIRECTION_SCENE_SPEC } = await import('../src/direction.ts');
  const { currentScene, sceneReference } = await import('../src/scene.ts');
  const f = sceneFixture();
  roots.push(f.dir);
  expect(f.writeScene().exit).toBe(0);
  const doc = { ...f.doc, schema: DIRECTION_SCENE_SPEC,
    rig: { version: 1, model: f.modelBinding }, scene: sceneReference(currentScene(f.load())!) };
  f.write('evidence/input.json', JSON.stringify(doc));
  expect(seedRetainedDirectionPost(['write', '2', f.dir, '--file', 'evidence/input.json', '--rig', '1'], testClock.now()).exit).toBe(0);
  const project = f.load();
  delete objects(project.versions).find(version => version.n === 1)!.review_package;
  f.save(project);
  for (const version of ['1', '2']) {
    expect(() => assertRequestedRig(f.dir, version)).toThrow(expect.objectContaining({
      code: 'JOB_PUBLICATION_INVALID',
      message: expect.stringContaining('versions[v1].review_package: retained package identity is missing'),
    }));
  }
});

test('direction@3 publishes through the pinned Review inspection and live job host', async () => {
  const { loadReview } = await import('../node_modules/@rig-c/review/src/manifest.ts');
  const { openCreateJob, openDraftPublication } = await import('../src/job-host.ts');
  const { jobHash, jobHostStateRoot, jobPrivateRoot, pendingPublications } = await import('../src/job-outbox.ts');
  const f = fixture();
  f.put('compose-out/check/extremes/a:idle/extremes.json', { extremes: [] });
  let host: Awaited<ReturnType<typeof openCreateJob>> | undefined;
  try {
    host = await openCreateJob(f.dir, { id: 'reviewer', role: 'owner' }, testClock.now());
    f.put('evidence/compose-direction.json', f.doc);
    const seeded = seedRetainedDirectionPost(['write', '2', f.dir, '--file', 'evidence/compose-direction.json', '--rig', '1', '--compose-out', 'compose-out', '--compose-scene', 'compose.scene.json'], testClock.now());
    expect(seeded.exit).toBe(0);
    expect(seeded.stdout).toContain('direction: v2 committed without publishing');
    const recordPath = join(f.dir, 'project.json');
    const committed = readFileSync(recordPath);
    expect(objects(f.load().versions).at(-1)).toMatchObject({ n: 2, kind: 'post', rig_version: 1 });
    expect(host.session.status()).toMatchObject({ generation: 0, publication: null, pending: [] });
    expect(pendingPublications(f.dir)).toEqual([]);
    const manifest = join(f.dir, 'review-live-v2.json');
    expect(existsSync(manifest)).toBe(false);

    const lines = await openDraftPublication(f.dir, host, testClock.now(), undefined, '2');
    const status = host.session.status();
    expect(status).toMatchObject({ generation: 1, pending: [] });
    expect(status.publication).not.toBeNull();
    const publication = status.publication!;
    expect(lines).toEqual([`job: post v2 published (publication ${publication.publicationId})`]);
    const pkg = await loadReview(manifest);
    expect(pkg.scene).toBeUndefined();
    expect(pkg.direction).toEqual({
      file: { path: 'evidence/direction/v2.json', sha256: jobHash(readFileSync(join(f.dir, 'evidence/direction/v2.json'))) },
      model: { path: 'outputs/v2/compose/check/build/skeleton.model.json', sha256: jobHash(readFileSync(join(f.dir, 'outputs/v2/compose/check/build/skeleton.model.json'))) },
      rigVersion: 1, composed: true, camera: { space: 'rig-world-y-up', keys: [] }, take: { duration: 4, loop: true }, timing: [],
    });
    expect(publication.source.projectHash).toBe(jobHash(committed));
    expect(publication.source.selector).toEqual({ kind: 'post', version: 2, rigVersion: 1 });
    expect(publication.source.model).toEqual(pkg.direction?.model);
    expect(publication.source.direction).toEqual(pkg.direction?.file);
    expect(publication.visual).toEqual({ status: 'available' });
    expect(readFileSync(recordPath)).toEqual(committed);
    expect(pendingPublications(f.dir)).toEqual([]);
  } finally {
    host?.stop();
    rmSync(jobPrivateRoot(f.dir), { recursive: true, force: true });
    rmSync(jobHostStateRoot(f.dir), { recursive: true, force: true });
  }
});

for (const [field, value] of [['extra', true], ['camera', {}], ['scene', {}]]) test(`DIRECTION_COMPOSE_SCHEMA rejects closed-document extra ${field}`, () => {
  const f = fixture(); f.doc[String(field)] = value; rejected(f, 'DIRECTION_COMPOSE_SCHEMA');
});

test('SCENE_ACCEPTANCE_STALE refuses an absent rig seal', () => {
  const f = fixture(); const p = f.load(); p.signoffs = objects(p.signoffs).filter(s => s.stage !== 'rig-review'); f.save(p); rejected(f, 'SCENE_ACCEPTANCE_STALE');
});

test('DIRECTION_COMPOSE_PLATE_UNREGISTERED refuses an unregistered plate', () => {
  const f = fixture(); const p = f.load(); p.inputs = []; f.save(p); rejected(f, 'DIRECTION_COMPOSE_PLATE_UNREGISTERED');
});

test('DIRECTION_COMPOSE_CHOICE_MISMATCH refuses order differing from the owner choice', () => {
  const f = fixture(); f.scene.order = ['front', 'actor', 'back']; f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene); saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_CHOICE_MISMATCH');
});

test('COMPOSE_VALUE_INVALID refuses a plain-number scalar track key in the cited compose value', () => {
  const f = fixture();
  const p = f.load();
  const items = ((p.interview as JsonObject).post as JsonObject).items as JsonObject[];
  const composition = items.find(i => i.id === 'post_composition')!.guide as JsonObject;
  const choice = composition.choice as JsonObject;
  const setBinding = choice.set as JsonObject;
  const set = JSON.parse(readFileSync(join(f.dir, String(setBinding.path)), 'utf8')) as JsonObject;
  const badValue = structuredClone(f.value) as JsonObject;
  objects(objects(badValue.idle_tracks)[1]!.keys)[1]!.v = 6;
  objects(objects(set.asks)[0]!.options).find(o => o.id === 'keep')!.fragment = { compose: badValue };
  choice.set = f.put(String(setBinding.path), set);
  composition.value = { compose: badValue };
  f.save(p);
  rejected(f, 'COMPOSE_VALUE_INVALID');
});

test('DIRECTION_COMPOSE_PLACEMENT refuses a nonzero shift for the zero-shift scene', () => {
  const f = fixture(); objects(f.report.characters)[0]!.shift = [1, 0]; f.put('compose-out/scene.json', f.report); rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
});

test.each([
  { label: 'default scale', scale: undefined, shift: [9, 13] },
  { label: 'scale 1.5', scale: 1.5, shift: [24, -7] },
] as const)('direction@3 accepts an off-centre shift at $label', ({ scale, shift }) => {
  const f = fixture({ offset: [11, -5], scale, rigSize: [60, 40], shift: [...shift] });
  expect(f.publish().exit).toBe(0);
  expect(directionCommand(['check', '2', f.dir, '--json']).exit).toBe(0);
});

test.each([
  { axis: 'x', label: 'default scale', scale: undefined, expected: [9, 13], reported: [10, 13] },
  { axis: 'y', label: 'default scale', scale: undefined, expected: [9, 13], reported: [9, 14] },
  { axis: 'x', label: 'scale 1.5', scale: 1.5, expected: [24, -7], reported: [25, -7] },
] as const)('DIRECTION_COMPOSE_PLACEMENT refuses a one-pixel $axis shift mismatch at $label', ({ scale, expected, reported }) => {
  const f = fixture({ offset: [11, -5], scale, rigSize: [60, 40], shift: [...reported] });
  f.publish();
  expect(() => readDirection(f.dir, f.load(), 2, true)).toThrow(expect.objectContaining({
    code: 'DIRECTION_COMPOSE_PLACEMENT',
    message: expect.stringContaining(`outputs/v2/compose/scene.json.characters[0].shift: expected shift ${JSON.stringify(expected)} from the cited placement, reported ${JSON.stringify(reported)}`),
  }));
});

test('DIRECTION_COMPOSE_PLACEMENT refuses a report without rig_size', () => {
  const f = fixture();
  delete objects(f.report.characters)[0]!.rig_size;
  f.put('compose-out/scene.json', f.report);
  rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
});

test('DIRECTION_COMPOSE_PLACEMENT refuses a scene composed one pixel off the owner choice', () => {
  const f = fixture({ offset: [40, 0], rigSize: [64, 48], shift: [41, 0] });
  objects(f.scene.characters)[0]!.offset = [41, 0];
  objects(f.report.characters)[0]!.offset = [41, 0];
  f.put('compose.scene.json', f.scene);
  f.put('compose-out/scene.json', f.report);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
});

test('DIRECTION_COMPOSE_PLACEMENT refuses model stage differing from the cited canvas', () => {
  const f = fixture(); f.model.stage = { x: -64, y: 0, width: 128, height: 48 }; f.put('compose-out/check/build/skeleton.model.json', f.model); rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
});

for (const target of ['take', 'answer']) test(`DIRECTION_COMPOSE_LOOP refuses false ${target} without reading an idle loop field`, () => {
  const f = fixture();
  if (target === 'take') (f.doc.take as JsonObject).loop = false;
  else { const p = f.load(); const items = ((p.interview as JsonObject).post as JsonObject).items as JsonObject[]; ((items.find(i => i.id === 'post_timing')!.guide as JsonObject).value as JsonObject).loop = false; f.save(p); }
  rejected(f, 'DIRECTION_COMPOSE_LOOP');
});

for (const target of ['take', 'model', 'answer']) test(`DIRECTION_COMPOSE_DURATION refuses mismatched ${target}`, () => {
  const f = fixture();
  if (target === 'take') (f.doc.take as JsonObject).duration = 5;
  else if (target === 'model') { objects(f.model.animations)[0]!.duration = 5; f.put('compose-out/check/build/skeleton.model.json', f.model); }
  else { const p = f.load(); const items = ((p.interview as JsonObject).post as JsonObject).items as JsonObject[]; ((items.find(i => i.id === 'post_timing')!.guide as JsonObject).value as JsonObject).seconds = 5; f.save(p); }
  rejected(f, 'DIRECTION_COMPOSE_DURATION');
});

test('DIRECTION_COMPOSE_GREEN reads the producer refusal without recomputing it', () => {
  const f = fixture(); f.put('compose-out/check/check.json', { PASS: false, gate_spine_html_green: true }); rejected(f, 'DIRECTION_COMPOSE_GREEN');
});

test('DIRECTION_COMPOSE_RUN refuses a different producer run spec', () => {
  const f = fixture(); f.put('compose-out/compose-run.json', { spec: 'other/1' }); rejected(f, 'DIRECTION_COMPOSE_RUN');
});

const consumedFiles = (f: ReturnType<typeof fixture>) => objects(objects(f.run.characters)[0]!.files);
function saveRun(f: ReturnType<typeof fixture>) { f.put('compose-out/compose-run.json', f.run); }
function reseal(f: ReturnType<typeof fixture>, p: JsonObject) {
  const pkg = objects(p.versions)[0]!.review_package as JsonObject;
  const signoff = objects(p.signoffs).find(s => s.stage === 'rig-review')!;
  ((signoff.target as JsonObject).review_package as JsonObject).sha256 = reviewPackageHash(pkg);
  f.save(p);
}

const malformedRuns: [string, (run: JsonObject) => void][] = [
  ['missing scene', run => { delete run.scene; }],
  ['missing characters', run => { delete run.characters; }],
  ['missing plate', run => { delete run.plate; }],
  ['missing plates', run => { delete run.plates; }],
  ['unknown top-level field', run => { run.clock = 'not in the contract'; }],
  ['unknown scene field', run => { (run.scene as JsonObject).extra = true; }],
  ['invalid scene hash', run => { (run.scene as JsonObject).sha256 = 'bad'; }],
  ['empty scene path', run => { (run.scene as JsonObject).path = ''; }],
  ['nonobject character', run => { run.characters = [null]; }],
  ['empty characters', run => { run.characters = []; }],
  ['duplicate character', run => { (run.characters as JsonObject[]).push(structuredClone(objects(run.characters)[0]!)); }],
  ['unknown character field', run => { objects(run.characters)[0]!.extra = true; }],
  ['missing build', run => { delete objects(run.characters)[0]!.build; }],
  ['nonarray files', run => { objects(run.characters)[0]!.files = {}; }],
  ['unknown file field', run => { objects(objects(run.characters)[0]!.files)[0]!.extra = true; }],
  ['invalid file hash', run => { objects(objects(run.characters)[0]!.files)[0]!.sha256 = 'bad'; }],
  ['duplicate file', run => { const c = objects(run.characters)[0]!; (c.files as JsonObject[]).push(structuredClone(objects(c.files)[0]!)); }],
  ['unsafe file path', run => { objects(objects(run.characters)[0]!.files)[1]!.path = '../parts.json'; }],
  ['unknown consumed file', run => { objects(objects(run.characters)[0]!.files)[1]!.path = 'unrelated.json'; }],
  ['missing consumed check', run => { const c = objects(run.characters)[0]!; c.files = objects(c.files).filter(f => f.path !== 'check/check.json'); }],
  ['unknown legacy plate field', run => { run.plate = { path: 'background.png', sha256: 'a'.repeat(64), extra: true }; }],
  ['invalid legacy plate hash', run => { run.plate = { path: 'background.png', sha256: 'bad' }; }],
  ['nonarray plates', run => { run.plates = {}; }],
  ['nonobject plate', run => { run.plates = [null]; }],
  ['unknown named plate field', run => { objects(run.plates)[0]!.extra = true; }],
  ['invalid named plate hash', run => { objects(run.plates)[0]!.sha256 = 'bad'; }],
  ['missing plate name', run => { delete objects(run.plates)[0]!.name; }],
  ['duplicate plate name', run => { objects(run.plates)[1]!.name = objects(run.plates)[0]!.name!; }],
];
for (const [name, mutate] of malformedRuns) test(`DIRECTION_COMPOSE_RUN refuses ${name}`, () => {
  const f = fixture(); mutate(f.run); saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN');
});
for (const bytes of ['not JSON', '[]', '{"spec":"rig-compose-run/1"}']) test(`DIRECTION_COMPOSE_RUN refuses incomplete producer bytes ${bytes}`, () => {
  const f = fixture(); f.put('compose-out/compose-run.json', bytes); rejected(f, 'DIRECTION_COMPOSE_RUN');
});

const rigFiles = ['parts.json', 'rig/rig.json', 'rig/motion.json', 'rig/images/body.png', 'rig/images/depth.png'];
for (const path of rigFiles) {
  test(`DIRECTION_COMPOSE_RUN_RIG refuses changed consumed ${path}`, () => {
    const f = fixture(); consumedFiles(f).find(row => row.path === path)!.sha256 = '0'.repeat(64); saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
  });
  if (path.startsWith('rig/images/')) test(`direction@3 permits accepted image ${path} absent from the consumed set`, () => {
    const f = fixture(); objects(f.run.characters)[0]!.files = consumedFiles(f).filter(row => row.path !== path); saveRun(f);
    expect(f.publish().exit).toBe(0); expect(() => readDirection(f.dir, f.load(), 2)).not.toThrow();
  });
  else test(`DIRECTION_COMPOSE_RUN_RIG refuses missing consumed ${path}`, () => {
    const f = fixture(); objects(f.run.characters)[0]!.files = consumedFiles(f).filter(row => row.path !== path); saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
  });
  test(`DIRECTION_COMPOSE_RUN_RIG refuses missing frozen inventory ${path}`, () => {
    const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!;
    rig.outputs = objects(rig.outputs).filter(row => row.path !== `outputs/v1/out/${path}`); f.save(p); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
  });
}
test('DIRECTION_COMPOSE_RUN_RIG refuses an additional consumed image', () => {
  const f = fixture(); (objects(f.run.characters)[0]!.files as JsonObject[]).push({ path: 'rig/images/extra.png', sha256: '0'.repeat(64) });
  saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
test('direction@3 permits an extra unused image in matching frozen and sealed inventories', () => {
  const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!; const pkg = rig.review_package as JsonObject;
  const image = f.put('outputs/v1/out/rig/images/unused.png', 'synthetic unused encoded image');
  rig.outputs = [...objects(rig.outputs), image];
  pkg.files = [...objects(pkg.files), { path: 'out/rig/images/unused.png', sha256: image.sha256! }]; reseal(f, p);
  expect(consumedFiles(f).some(row => row.path === 'rig/images/unused.png')).toBe(false);
  expect(f.publish().exit).toBe(0); expect(() => readDirection(f.dir, f.load(), 2)).not.toThrow();
});
for (const inventory of ['sealed', 'both']) test(`DIRECTION_COMPOSE_RUN_RIG refuses a consumed image absent from ${inventory} inventories`, () => {
  const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!; const pkg = rig.review_package as JsonObject;
  pkg.files = objects(pkg.files).filter(row => row.path !== 'out/rig/images/depth.png');
  if (inventory === 'both') rig.outputs = objects(rig.outputs).filter(row => row.path !== 'outputs/v1/out/rig/images/depth.png');
  reseal(f, p); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
test('DIRECTION_COMPOSE_RUN_RIG refuses differing frozen and sealed image sets even when the image is unused', () => {
  const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!;
  rig.outputs = objects(rig.outputs).filter(row => row.path !== 'outputs/v1/out/rig/images/depth.png'); f.save(p);
  objects(f.run.characters)[0]!.files = consumedFiles(f).filter(row => row.path !== 'rig/images/depth.png'); saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
test('DIRECTION_COMPOSE_RUN_RIG refuses differing frozen and sealed hashes for an unused image', () => {
  const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!;
  objects(rig.outputs).find(row => row.path === 'outputs/v1/out/rig/images/depth.png')!.sha256 = '0'.repeat(64); f.save(p);
  objects(f.run.characters)[0]!.files = consumedFiles(f).filter(row => row.path !== 'rig/images/depth.png'); saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
test('DIRECTION_COMPOSE_RUN_RIG refuses an inventory hash outside the accepted package seal', () => {
  const f = fixture(); const p = f.load(); objects(objects(p.versions)[0]!.outputs)[0]!.sha256 = '0'.repeat(64);
  consumedFiles(f).find(row => row.path === 'parts.json')!.sha256 = '0'.repeat(64); f.save(p); saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
test('DIRECTION_COMPOSE_RUN_RIG refuses mandatory rig files absent from both lists', () => {
  const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!; const pkg = rig.review_package as JsonObject;
  rig.outputs = objects(rig.outputs).filter(row => row.path !== 'outputs/v1/out/parts.json');
  pkg.files = objects(pkg.files).filter(row => row.path !== 'out/parts.json'); reseal(f, p);
  objects(f.run.characters)[0]!.files = consumedFiles(f).filter(row => row.path !== 'parts.json'); saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
for (const field of ['from', 'outputs']) test(`DIRECTION_COMPOSE_RUN_RIG refuses absent accepted ${field}`, () => {
  const f = fixture(); const p = f.load(); const rig = objects(p.versions)[0]!;
  if (field === 'from') delete (rig.review_package as JsonObject).from; else delete rig.outputs;
  reseal(f, p); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
for (const field of ['id', 'build']) test(`DIRECTION_COMPOSE_RUN_RIG refuses a character ${field} differing from the retained scene`, () => {
  const f = fixture(); objects(f.run.characters)[0]![field] = 'different'; saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN_RIG');
});
test('direction@3 compares build bytes across paths and does not compare the consumed check hash', () => {
  const f = fixture(); consumedFiles(f).find(row => row.path === 'check/check.json')!.sha256 = 'f'.repeat(64);
  expect(existsSync(join(f.dir, 'outputs/v1/out/check/check.json'))).toBe(false);
  saveRun(f); expect(f.publish().exit).toBe(0);
  expect(() => readDirection(f.dir, f.load(), 2, true)).not.toThrow();
});
test('composeRunMatchesAcceptedRig compares every character in its binding list', () => {
  const f = fixture(); const rig = objects(f.load().versions)[0]!;
  const second = structuredClone(objects(f.run.characters)[0]!); second.id = 'other'; second.build = 'another-build';
  (f.run.characters as JsonObject[]).push(second);
  const compare = () => composeRunMatchesAcceptedRig(f.dir, readComposeRun(Buffer.from(JSON.stringify(f.run)), 'compose-run.json'),
    [{ id: 'actor', build: 'producer-build', rig }, { id: 'other', build: 'another-build', rig }], 'compose-run.json');
  expect(compare).not.toThrow();
  objects(second.files).find(row => row.path === 'rig/rig.json')!.sha256 = '0'.repeat(64);
  expect(compare).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_RUN_RIG' }));
});
for (const target of ['missing', 'changed']) test(`DIRECTION_COMPOSE_RUN_RIG reads ${target} frozen bytes at check`, () => {
  const f = fixture(); f.publish();
  if (target === 'missing') rmSync(join(f.dir, 'outputs/v1/out/rig/images/depth.png'));
  else f.put('outputs/v1/out/rig/images/depth.png', 'changed');
  expect(() => readDirection(f.dir, f.load(), 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_RUN_RIG' }));
});
test('DIRECTION_COMPOSE_RUN_SCENE compares retained raw scene bytes, including whitespace', () => {
  const f = fixture(); f.put('compose.scene.json', `${JSON.stringify(f.scene, null, 2)}\n`); rejected(f, 'DIRECTION_COMPOSE_RUN_SCENE');
});
test('direction@3 does not reopen the producer scene or build paths', () => {
  const f = fixture(); (f.run.scene as JsonObject).path = 'unavailable-source/scene.json'; saveRun(f);
  expect(f.publish().exit).toBe(0);
  expect(() => readDirection(f.dir, f.load(), 2, true)).not.toThrow();
});
test('direction@3 resolves a nested Parts scene plate without reopening the source', () => {
  const f = fixture();
  const source = 'specs/direction/compose-scene.json';
  for (const plate of objects(f.scene.plates)) plate.image = `../../${String(plate.image)}`;
  const binding = f.put(source, f.scene);
  f.run.scene = binding;
  for (const plate of objects(f.run.plates)) plate.path = `../../${String(plate.path)}`;
  f.report.scene = join(f.dir, source);
  for (const plate of objects(f.report.plates)) plate.image = `../../${String(plate.image)}`;
  f.put('compose-out/scene.json', f.report);
  saveRun(f);
  f.put('evidence/compose-direction.json', f.doc);
  expect(seedRetainedDirectionPost(['write', '2', f.dir, '--file', 'evidence/compose-direction.json', '--rig', '1',
    '--compose-out', 'compose-out', '--compose-scene', source], testClock.now()).exit).toBe(0);
  rmSync(join(f.dir, source));
  expect(directionCommand(['check', '2', f.dir]).exit).toBe(0);
});
for (const target of ['name', 'path', 'hash', 'missing', 'extra', 'legacy']) test(`DIRECTION_COMPOSE_RUN_PLATE refuses ${target} plate binding`, () => {
  const f = fixture();
  if (target === 'name') objects(f.run.plates)[0]!.name = 'different';
  if (target === 'path') objects(f.run.plates)[0]!.path = 'unregistered.png';
  if (target === 'hash') objects(f.run.plates)[0]!.sha256 = '0'.repeat(64);
  if (target === 'missing') f.run.plates = objects(f.run.plates).slice(1);
  if (target === 'extra') (f.run.plates as JsonObject[]).push({ name: 'extra', path: 'background.png', sha256: f.background.sha256! });
  if (target === 'legacy') f.run.plate = { path: 'background.png', sha256: '0'.repeat(64) };
  saveRun(f); rejected(f, 'DIRECTION_COMPOSE_RUN_PLATE');
});
test('direction@3 checks a nonnull legacy run plate against registered bytes too', () => {
  const f = fixture(); f.run.plate = { path: f.background.path!, sha256: f.background.sha256! }; saveRun(f);
  expect(f.publish().exit).toBe(0);
  expect(() => readDirection(f.dir, f.load(), 2, true)).not.toThrow();
});

test('DIRECTION_COMPOSE_INVENTORY refuses an unbound compose file at check', () => {
  const f = fixture(); f.publish(); const p = f.load(); const post = objects(p.versions).find(v => v.n === 2)!;
  post.outputs = objects(post.outputs).filter(o => o.path !== 'outputs/v2/compose/check/build/skeleton.model.json'); f.save(p);
  expect(() => readDirection(f.dir, p, 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_INVENTORY' }));
});

test('DIRECTION_COMPOSE_SCHEMA validates final seals and forbids legacy camera keys', () => {
  const f = fixture(); f.publish(); const doc = readDirection(f.dir, f.load(), 2);
  (doc.rig as JsonObject).acceptance = {}; expect(() => validateDirectionShape(doc)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_SCHEMA' }));
});

test('direction@3 retains a bounced post citation when the owner re-answers composition', async () => {
  const { fixture: filled } = await import('./fixtures.ts');
  const { cpSync, writeFileSync } = await import('node:fs');
  const { collectItems } = await import('../src/check.ts');
  const { optionContext } = await import('../src/choices.ts');
  const { checkProject, signoffCommand, inputCommand, advanceCommand, planCommand, interviewAnswerCommand,
    interviewCommand, interviewOptionsCommand, assertDirectionApproval, stepStatusCommand } = await import('./clock.ts');
  const f = fixture();
  const dir = filled(() => {}, 'example-numbered/example-project.json'); roots.push(dir);
  testClock.set(EXAMPLE_NOW);
  writeFileSync(join(dir, 'words.txt'), 'Revise the synthetic composed take.');
  plantLegacyReopen(dir, 'post-interview', { by: 'user', wordsFile: join(dir, 'words.txt') });
  const load = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const save = (p: JsonObject) => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  for (const name of ['background.png', 'foreground.png']) {
    cpSync(join(f.dir, name), join(dir, name));
    inputCommand(['add', name, dir, '--origin', 'synthetic plate']);
  }
  const p = load();
  const accepted = objects(p.versions).find(v => v.n === 2)!;
  const pkg = accepted.review_package as JsonObject;
  accepted.outputs = [...objects(accepted.outputs), ...objects(pkg.files).filter(row => typeof row.path === 'string' && row.path.startsWith('out/')
    && (['parts.json', 'rig/rig.json', 'rig/motion.json'].includes(row.path.slice(4)) || row.path.startsWith('out/rig/images/')))
    .map(row => ({ path: `${String(pkg.from)}/${String(row.path).slice(4)}`, sha256: row.sha256! }))];
  const context = optionContext(p, 'post-interview', testClock.now(), dir);
  const items = collectItems(p, { collection: null });
  for (const [id, value] of [['post_composition', { compose: f.value }], ['post_timing', { seconds: 4, loop: true, beats: [] }]] as const) {
    const item = items.find(i => i.id === id)!; const old = structuredClone(item.raw as JsonObject);
    const answer = item.raw as JsonObject; const oldChoice = answer.choice as JsonObject;
    const set = JSON.parse(readFileSync(join(dir, String((oldChoice.set as JsonObject).path)), 'utf8')) as JsonObject;
    set.id = `composed-${id}`; set.context = context; set.drafted_at = testClock.iso();
    const selected = objects(objects(set.asks)[0]!.options).find(o => o.id === 'keep')!; selected.fragment = value as unknown as JsonObject;
    const path = `evidence/interview/composed-${id}.json`; const bytes = Buffer.from(JSON.stringify(set)); writeFileSync(join(dir, path), bytes);
    item.record.history = [...objects(item.record.history), old];
    answer.at = testClock.iso(); answer.value = value as unknown as JsonObject;
    answer.choice = { ...oldChoice, set: { path, sha256: directionHash(bytes) } };
  }
  save(p);
  const plan = p.plan as JsonObject;
  const retained = [...objects(plan.replaced)];
  for (const id of ['timing', 'composition']) {
    const step = objects(plan.steps).find(candidate => candidate.id === id)!;
    testClock.set(testClock.now() + 1_000);
    expect(planCommand(['remove', id, dir, '--by', 'agent']).exit).toBe(0);
    retained.push(expect.objectContaining({ step, action: 'removed' }));
    testClock.set(testClock.now() + 1_000);
    expect(planCommand(['add', id, dir, '--by', 'agent', '--phase', String(step.phase), '--order', String(step.order),
      '--does', String(step.does), '--produces', String(step.produces), '--rests-on', (step.rests_on as string[]).join(','),
      '--bar', String(step.bar), '--checkpoint-proposed', String(step.checkpoint_proposed)]).exit).toBe(0);
  }
  expect((load().plan as JsonObject).replaced).toEqual(retained);
  testClock.set(EXAMPLE_NOW + 60_000);
  signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  advanceCommand(['post', dir]);
  cpSync(join(f.dir, 'compose-out'), join(dir, 'compose-out'), { recursive: true }); cpSync(join(f.dir, 'compose.scene.json'), join(dir, 'compose.scene.json'));
  writeFileSync(join(dir, 'compose-out/compose-run.json'), JSON.stringify(composeRunFixture(dir, load(), 2, f.scene)));
  const doc = structuredClone(f.doc); doc.rig = { version: 2 };
  const citations = doc.citations as JsonObject;
  for (const [key, id] of [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']]) citations[key!] = { guide: id!, asks: [id!], quote: (items.find(i => i.id === id)!.raw as JsonObject).verbatim! };
  writeFileSync(join(dir, 'evidence/composed-direction.json'), JSON.stringify(doc));
  seedRetainedDirectionPost(['write', '5', dir, '--file', 'evidence/composed-direction.json', '--rig', '2', '--compose-out', 'compose-out', '--compose-scene', 'compose.scene.json'], testClock.now());
  expect(checkProject(dir).refusals).toEqual([]);
  const { checkProject: recordedCheck } = await import('../src/check.ts');
  const recorded = recordedCheck(dir, undefined, { now: testClock.now(), readOnly: true, recordReads: true });
  expect(recorded.refusals).toEqual([]);
  expect(recorded.reads!.map(row => row.path)).toContain('outputs/v5/compose/check/build/page.png');
  expect(recorded.reads!.map(row => row.path)).toContain('evidence/compose-src/v5/scene.json');
  expect(recorded.reads!.map(row => row.path)).toContain('outputs/v2/out/rig/images/face.png');
  const { nextProject } = await import('../src/next.ts');
  const moves = nextProject(dir, testClock.now());
  expect(JSON.stringify(moves)).not.toContain('scenes[n=1]');
  expect(JSON.stringify(moves)).not.toContain('rig-create scene write');

  for (const step of objects((load().plan as JsonObject).steps).filter(step => step.phase === 'post' && step.status !== 'done')) {
    for (const status of ['in-progress', 'at-checkpoint', 'done']) {
      testClock.set(testClock.now() + 1_000);
      stepStatusCommand([String(step.id), status, dir, '--by', 'agent']);
    }
  }
  testClock.set(testClock.now() + 1_000);
  advanceCommand(['direction-review', dir]);
  const bounced = load();
  objects(bounced.versions).find(version => version.n === 5)!.verdicts = [{
    review: 'direction-review', verdict: 'bounced', by: 'user', at: testClock.iso(), verbatim: 'Revise the composed post.', on_items: [],
  }];
  save(bounced);
  const composition = collectItems(bounced, { collection: null }).find(item => item.id === 'post_composition')!;
  const priorAnswer = composition.raw as JsonObject;
  const setBinding = (priorAnswer.choice as JsonObject).set as JsonObject;
  const set = JSON.parse(readFileSync(join(dir, String(setBinding.path)), 'utf8')) as JsonObject;
  testClock.set(testClock.now() + 1_000);
  set.id = 'revised-composition';
  set.drafted_at = testClock.iso();
  set.context = optionContext(bounced, 'post-interview', testClock.now(), dir);
  const pick = objects(objects(set.asks)[0]!.options).find(option => option.id === 'keep')!;
  pick.label = 'Use the composition for the revised post';
  const setPath = 'evidence/interview/revised-composition.json';
  const bytes = Buffer.from(JSON.stringify(set));
  writeFileSync(join(dir, setPath), bytes);
  interviewOptionsCommand(['post_composition', dir, '--file', setPath]);
  const baseline = checkProject(dir).refusals;
  testClock.set(testClock.now() + 1_000);
  const answer = JSON.parse(interviewAnswerCommand(['post_composition', dir, '--set', setPath, '--sha256', directionHash(bytes),
    '--by', 'user', '--pick', 'post_composition=keep'])) as JsonObject;
  expect(answer.verbatim).not.toBe(priorAnswer.verbatim);
  expect(checkProject(dir).refusals.map(finding => finding.code)).toEqual(['SIGNOFF_ANSWERS_STALE']);
  expect(directionCommand(['check', '5', dir]).exit).toBe(0);
  expect(() => assertDirectionApproval(dir, load(), 'direction-review', 5)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_CITATION' }));

  testClock.set(testClock.now() + 1_000);
  signoffCommand(['post-interview', dir, '--by', 'user', '--steps', 'composition', '--verbatim-file', join(dir, 'words.txt')]);
  const checked = interviewCommand(['--check', dir, '--json']);
  expect(checked.exit).toBe(0);
  expect(JSON.parse(checked.stdout).refusals).toEqual(baseline);

  const writeArgs = ['write', '6', dir, '--file', 'evidence/composed-direction.json', '--rig', '2',
    '--compose-out', 'compose-out', '--compose-scene', 'compose.scene.json', '--answers', '5:0'];
  const before = readFileSync(join(dir, 'project.json'));
  seedRetainedDirectionPost(writeArgs, testClock.now());
  expect(() => readDirection(dir, load(), 6, true)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_CITATION' }));
  writeFileSync(join(dir, 'project.json'), before);
  rmSync(join(dir, 'outputs/v6'), { recursive: true, force: true });
  rmSync(join(dir, 'evidence/compose-src/v6'), { recursive: true, force: true });
  rmSync(join(dir, 'evidence/direction/v6.json'), { force: true });
  citations.composition = { guide: 'post_composition', asks: ['post_composition'], quote: answer.verbatim! };
  writeFileSync(join(dir, 'evidence/composed-direction.json'), JSON.stringify(doc));
  expect(seedRetainedDirectionPost(writeArgs, testClock.now()).exit).toBe(0);
  expect(checkProject(dir).refusals).toEqual([]);
}, 30_000);

for (const field of ['canvas', 'plates', 'character', 'tracks']) test(`DIRECTION_COMPOSE_CHOICE_MISMATCH binds the exact owner ${field}`, () => {
  const f = fixture();
  if (field === 'canvas') { f.scene.canvas = { width: 63, height: 48 }; f.report.canvas = f.scene.canvas; f.put('compose-out/scene.json', f.report); }
  if (field === 'plates') { objects(f.scene.plates)[0]!.at = [-1, 0]; objects(f.report.plates)[0]!.at = [-1, 0]; f.put('compose-out/scene.json', f.report); }
  if (field === 'character') { objects(f.scene.characters)[0]!.scale = 0.5; objects(f.report.characters)[0]!.scale = 0.5; f.put('compose-out/scene.json', f.report); }
  if (field === 'tracks') { const idle = (f.scene.animations as JsonObject).idle as JsonObject; objects(objects(idle.tracks)[0]!.keys)[1]!.v = [4, 0]; }
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene); saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_CHOICE_MISMATCH');
});

test('DIRECTION_COMPOSE_CITATION refuses composition words outside the recorded choice', () => {
  const f = fixture(); ((f.doc.citations as JsonObject).composition as JsonObject).quote = 'Unrecorded words'; rejected(f, 'DIRECTION_COMPOSE_CITATION');
});

test('SCENE_CHOICE_MISSING refuses unchosen composition values even when the text matches', () => {
  const f = fixture(); const p = f.load(); const items = ((p.interview as JsonObject).post as JsonObject).items as JsonObject[];
  delete (items.find(i => i.id === 'post_composition')!.guide as JsonObject).choice; f.save(p); rejected(f, 'SCENE_CHOICE_MISSING');
});

test('direction@3 accepts a resolved delegated composition through the existing authority reader', () => {
  const f = fixture(); const p = f.load(); const items = ((p.interview as JsonObject).post as JsonObject).items as JsonObject[];
  const answer = items.find(i => i.id === 'post_composition')!.guide as JsonObject; const choice = answer.choice as JsonObject;
  const set = JSON.parse(readFileSync(join(f.dir, String((choice.set as JsonObject).path)), 'utf8')) as JsonObject;
  const option = objects(objects(set.asks)[0]!.options).find(o => o.id === 'auto')!;
  const shown = { label: option.label!, effect: option.effect! };
  choice.set = f.put(String((choice.set as JsonObject).path), set); choice.picks = [{ ask: 'post_composition', option_id: 'auto', shown }];
  answer.delegated = true; answer.asks = [{ id: 'post_composition', state: 'delegated' }]; answer.verbatim = `${shown.label}\n${shown.effect}`; delete answer.value;
  answer.agent_decision = { by: 'agent', at: answer.at!, reasoning: 'Use the synthetic two-plate composition.', value: { compose: f.value }, fragments: [{ ask: 'post_composition', fragment: { compose: f.value } }] };
  ((f.doc.citations as JsonObject).composition as JsonObject) = { guide: 'post_composition', asks: ['post_composition'], delegated: true };
  f.save(p); expect(f.publish().exit).toBe(0);
  expect(() => readDirection(f.dir, f.load(), 2, true)).not.toThrow();
});

test('DIRECTION_COMPOSE_HASH detects changed frozen model bytes at check', () => {
  const f = fixture(); f.publish(); f.put('outputs/v2/compose/check/build/skeleton.model.json', 'changed');
  expect(() => readDirection(f.dir, f.load(), 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_HASH' }));
});

test('DIRECTION_COMPOSE_FILE detects a missing compose scene input at check', () => {
  const f = fixture(); f.publish(); rmSync(join(f.dir, composeScenePath(2)));
  expect(() => readDirection(f.dir, f.load(), 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_FILE' }));
});

test('DIRECTION_COMPOSE_INVENTORY binds atlas and pages as well as the model', () => {
  const f = fixture(); f.publish(); const p = f.load(); const post = objects(p.versions).find(v => v.n === 2)!;
  post.outputs = objects(post.outputs).filter(o => o.path !== 'outputs/v2/compose/check/build/page.png'); f.save(p);
  expect(() => readDirection(f.dir, p, 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_INVENTORY' }));
});

function enableCanvasClip(f: ReturnType<typeof fixture>, bounds: [number, number, number, number] = [-8, -6, 68, 48], clippedBounds: [number, number, number, number] = [0, 0, 64, 48]) {
  objects(f.scene.characters)[0]!.canvas_clip = true;
  f.put('compose.scene.json', f.scene);
  Object.assign(objects(f.report.characters)[0]!, { canvas_clip: true, bounds, clipped_bounds: clippedBounds });
  f.put('compose-out/scene.json', f.report);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  objects(f.run.characters)[0]!.placement = { canvas_clip: true, bounds, clipped_bounds: clippedBounds };
  saveRun(f);
}

test('direction@3 accepts scene canvas_clip: true with compose-run placement and carries clipped_bounds into the direction record', () => {
  const f = fixture();
  enableCanvasClip(f, [-12, -8, 70, 52], [0, 0, 64, 48]);
  expect(f.publish().exit).toBe(0);
  const p = f.load();
  const doc = readDirection(f.dir, p, 2, true);
  expect((doc.compose as JsonObject).clipped_bounds).toEqual([0, 0, 64, 48]);
  expect(directionCommand(['check', '2', f.dir, '--json']).exit).toBe(0);
  const ctx = { dir: f.dir, project: p, refusals: [], warnings: [] };
  checkDirections(ctx);
  expect(ctx.refusals).toEqual([]);
  expect(ctx.warnings).toEqual([]);
});

test('direction@3 scene without canvas_clip omits compose.clipped_bounds', () => {
  const f = fixture();
  expect(f.publish().exit).toBe(0);
  const doc = readDirection(f.dir, f.load(), 2, true);
  expect('clipped_bounds' in (doc.compose as JsonObject)).toBe(false);
});

test('DIRECTION_COMPOSE_RUN refuses compose-run placement without scene canvas_clip opt-in', () => {
  const f = fixture();
  objects(f.run.characters)[0]!.placement = { canvas_clip: true, bounds: [-8, -6, 64, 48], clipped_bounds: [0, 0, 64, 48] };
  saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_RUN');
});

test('DIRECTION_COMPOSE_RUN refuses scene canvas_clip opt-in without compose-run placement', () => {
  const f = fixture();
  objects(f.scene.characters)[0]!.canvas_clip = true;
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_RUN');
});

for (const badClip of [false, null, 1, 'true']) test(`DIRECTION_COMPOSE_SCHEMA refuses canvas_clip: ${JSON.stringify(badClip)} and names canvas_clip`, () => {
  const f = fixture();
  objects(f.scene.characters)[0]!.canvas_clip = badClip;
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  f.publish();
  expect(() => readDirection(f.dir, f.load(), 2, true)).toThrow(expect.objectContaining({
    code: 'DIRECTION_COMPOSE_SCHEMA',
    message: expect.stringContaining('canvas_clip'),
  }));
});

test('direction@3 permits Parts scene character annotations such as accept and note', () => {
  const f = fixture();
  Object.assign(objects(f.scene.characters)[0]!, { accept: ['mesh'], note: 'synthetic scene character note' });
  f.put('compose.scene.json', f.scene);
  f.run = composeRunFixture(f.dir, f.load(), 1, f.scene);
  saveRun(f);
  expect(f.publish().exit).toBe(0);
  expect(() => readDirection(f.dir, f.load(), 2, true)).not.toThrow();
});

const malformedPlacements: [string, (c: JsonObject) => void][] = [
  ['wrong placement key order (bounds first)', c => { c.placement = { bounds: [-8, -6, 68, 48], canvas_clip: true, clipped_bounds: [0, 0, 64, 48] }; }],
  ['wrong placement key order (clipped_bounds before bounds)', c => { c.placement = { canvas_clip: true, clipped_bounds: [0, 0, 64, 48], bounds: [-8, -6, 68, 48] }; }],
  ['placement before files on character', c => {
    const { id, build, files, placement } = c;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, { id, build, placement, files });
  }],
  ['extra placement key', c => { (c.placement as JsonObject).extra = true; }],
  ['false placement.canvas_clip', c => { (c.placement as JsonObject).canvas_clip = false; }],
  ['short placement.bounds', c => { (c.placement as JsonObject).bounds = [0, 0, 64]; }],
  ['short placement.clipped_bounds', c => { (c.placement as JsonObject).clipped_bounds = [0, 0, 64]; }],
];
for (const [name, mutate] of malformedPlacements) test(`DIRECTION_COMPOSE_RUN refuses ${name}`, () => {
  const f = fixture();
  enableCanvasClip(f);
  mutate(objects(f.run.characters)[0]!);
  saveRun(f);
  rejected(f, 'DIRECTION_COMPOSE_RUN');
});

test('DIRECTION_COMPOSE_PLACEMENT refuses a direction record whose compose.clipped_bounds differs from compose-run placement', () => {
  const f = fixture();
  enableCanvasClip(f, [-12, -8, 70, 52], [0, 0, 64, 48]);
  expect(f.publish().exit).toBe(0);
  const dirPath = 'evidence/direction/v2.json';
  const doc = JSON.parse(readFileSync(join(f.dir, dirPath), 'utf8')) as JsonObject;
  (doc.compose as JsonObject).clipped_bounds = [0, 0, 60, 48];
  const binding = f.put(dirPath, `${JSON.stringify(doc, null, 2)}\n`);
  const p = f.load();
  const post = objects(p.versions).find(v => v.n === 2)!;
  (post.provenance as JsonObject).config = binding;
  (post.provenance as JsonObject).direction = binding;
  post.outputs = [binding, ...objects(post.outputs).slice(1)];
  f.save(p);
  expect(() => readDirection(f.dir, f.load(), 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_PLACEMENT' }));
});
