/** create#297: a retained rig registration feeds scene and direction readers through its record bindings. */
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Finding } from '../src/check.ts';
import { DIRECTION_SCENE_SPEC, directionHash, directionIdleBytes, objects } from '../src/direction.ts';
import { checkScenes, currentScene, sceneReference } from '../src/scene.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkDirections, checkProject, directionCommand, testClock } from './clock.ts';
import { seedRetainedDirectionPost, seedRetainedRigVersion, seedRetainedScene } from './numbered-seed.ts';
import { sceneFixture } from './scene-fixture.ts';

afterEach(() => testClock.reset());
const frozen = join(import.meta.dir, 'fixtures/rig-registration');
const FRAMES = 'outputs/v1/idle/frames.json';

/** The scene fixture's rig v1, replaced by the same rig seeded from frozen producer bytes. */
function registered() {
  const f = sceneFixture();
  const put = (path: string, value: unknown): void => {
    mkdirSync(dirname(join(f.dir, path)), { recursive: true });
    writeFileSync(join(f.dir, path), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  };
  cpSync(frozen, join(f.dir, 'source'), { recursive: true });
  put('source/config.json', { key: 'synthetic', requirements: 'requirements.json' });
  put('source/requirements.json', { spec: 'spine-parts-requirements/1', fps: 4, requirements: [], setup_painting: { required: true } });
  put('source/adapter.json', []);
  put('source/at-source.json', { finished_at: '2026-11-04T07:00:00.000Z' });
  put('source/check.json', { spec: 'rig-parts-check/1', bar_outcomes: { gate: { status: 'PASS' } },
    build: { model_sha256: directionHash(readFileSync(join(f.dir, 'source/build/skeleton.model.json'))) } });
  const painting = readFileSync(join(f.dir, 'source/rig/images/rectangle.png'));
  put('source/parts/parts.json', { rig_size: [8, 16], scale_rig_per_source: 1, ghost_px: {},
    painting_in_rig: { path: 'painting_in_rig.png', sha256: directionHash(painting), resample: 'lanczos3-rgb-opaque' },
    parts: [{ name: 'rectangle', from: 'painting:rectangle', x: 0, y: 0, w: 8, h: 16,
      opaque_px: 128, projected_core_px: 128, source_px_taken: 128, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }] });
  writeFileSync(join(f.dir, 'source/parts/painting_in_rig.png'), painting);
  mkdirSync(join(f.dir, 'source/parts/parts'), { recursive: true });
  cpSync(join(f.dir, 'source/rig/images/rectangle.png'), join(f.dir, 'source/parts/parts/rectangle.png'));
  const accepted = objects(f.load().versions)[0]!;
  const p = f.load(); const stage = p.stage!; p.versions = []; p.stage = 'rig-review'; f.save(p);
  rmSync(join(f.dir, 'derived/review/v1'), { recursive: true, force: true });
  testClock.set('2026-11-04T07:30:00Z');
  seedRetainedRigVersion(['1', f.dir, '--parts', 'source/parts', '--rig', 'source/rig', '--build', 'source/build', '--idle', 'source/idle',
    '--config', 'source/config.json', '--path-adapter', 'source/adapter.json', '--compile-report', 'source/compile-report.json',
    '--check-report', 'source/check.json',
    '--toolchain-lock', 'source/package-lock.json', '--at-source', 'source/at-source.json', '--at-pointer', '/finished_at', '--by', 'registrant'], testClock.now());
  const q = f.load(); const rig = objects(q.versions)[0]!;
  rig.verdicts = accepted.verdicts!; rig.evidence = accepted.evidence!; q.stage = stage;
  const signoff = objects(q.signoffs).find(value => value.stage === 'rig-review')!;
  signoff.target = { version: 1, verdict: 'versions[0].verdicts[0]', review_package: { path: 'versions[0].review_package', sha256: reviewPackageHash(rig.review_package as JsonObject) } };
  f.save(q);
  testClock.set('2026-11-07T10:00:00Z');
  const model = { path: 'derived/review/v1/out/check/build/skeleton.model.json', sha256: directionHash(readFileSync(join(f.dir, 'derived/review/v1/out/check/build/skeleton.model.json'))) };
  const author = (scene = sceneReference(currentScene(f.load())!), version = 1): JsonObject => ({ ...f.doc, schema: DIRECTION_SCENE_SPEC, rig: { version, model }, scene });
  const publish = (doc: JsonObject, n = 2, rigN = 1) => {
    f.write('evidence/input.json', JSON.stringify(doc));
    return seedRetainedDirectionPost(['write', String(n), f.dir, '--file', 'evidence/input.json', '--rig', String(rigN)], testClock.now());
  };
  const png = readFileSync(join(f.dir, String(f.background.path)));
  f.designateScene({ x: -4, y: 0, width: 8, height: 8 * png.readUInt32BE(20) / png.readUInt32BE(16) });
  const writeScene = () => seedRetainedScene([...f.args().slice(0, -1), '--background-rect', `-4,0,8,${8 * png.readUInt32BE(20) / png.readUInt32BE(16)}`, f.dir], testClock.now());
  return { ...f, put, model, author, publish, writeScene };
}
function refusals(f: ReturnType<typeof registered>): Finding[] {
  const ctx = { dir: f.dir, project: f.load(), refusals: [] as Finding[] };
  checkScenes(ctx); checkDirections(ctx);
  return ctx.refusals;
}
/** A scene document edited in place, resealed by its committed entry, so the post reaches its own frames read. */
function plantFrames(f: ReturnType<typeof registered>, frames: JsonObject): JsonObject {
  const p = f.load(); const entry = currentScene(p)!;
  const doc = JSON.parse(readFileSync(join(f.dir, String(entry.path)), 'utf8')) as JsonObject;
  ((doc.rig as JsonObject).animation as JsonObject).frames = frames;
  entry.sha256 = f.write(String(entry.path), JSON.stringify(doc)).sha256!;
  f.save(p);
  return sceneReference(entry);
}

test('retained registration, scene and direction posts chain through the registered idle frames', () => {
  const f = registered();
  const rig = objects(f.load().versions)[0]!;
  expect(((rig.registration as JsonObject).idle as JsonObject).path).toBe(FRAMES);
  expect((rig.registration as JsonObject).check_report).toHaveProperty('spec', 'rig-parts-check/1');
  expect(f.writeScene().exit).toBe(0);
  const scene = JSON.parse(readFileSync(join(f.dir, String(currentScene(f.load())!.path)), 'utf8')) as JsonObject;
  expect(((scene.rig as JsonObject).animation as JsonObject).frames).toEqual((rig.registration as JsonObject).idle);
  expect(f.publish(f.author()).exit).toBe(0);
  expect(refusals(f)).toEqual([]);
  expect(directionCommand(['check', '2', f.dir]).exit).toBe(0);
  expect(checkProject(f.dir).refusals.filter(value => value.code.startsWith('DIRECTION_') || value.code.startsWith('SCENE_'))).toEqual([]);
});

test('an outputs path the record does not bind refuses in scene and direction readers', () => {
  const f = registered(); f.writeScene();
  const stray = f.write('outputs/v1/idle/stray.json', '{"spec":"rigc-frames/1","sets":[]}\n');
  const scene = plantFrames(f, stray);
  f.publish(f.author(scene));
  expect(refusals(f).map(value => value.code)).toEqual(['SCENE_MALFORMED', 'DIRECTION_IDLE_UNBOUND']);
});

test('frames bound to a different rig version refuse in scene and direction readers', () => {
  const f = registered(); f.writeScene();
  f.put('outputs/v2/idle/frames.json', readFileSync(join(f.dir, FRAMES)).toString());
  const scene = plantFrames(f, { path: 'outputs/v2/idle/frames.json', sha256: directionHash(readFileSync(join(f.dir, FRAMES))) });
  f.publish(f.author(scene));
  expect(refusals(f).map(value => value.code)).toEqual(['SCENE_MALFORMED', 'DIRECTION_IDLE_VERSION']);
});

test('frames whose bytes differ from the registration sha256 refuse on check', () => {
  const f = registered(); f.writeScene();
  const original = readFileSync(join(f.dir, FRAMES));
  const changed = Buffer.concat([original, Buffer.from(' ')]);
  expect(f.publish(f.author()).exit).toBe(0);
  writeFileSync(join(f.dir, FRAMES), changed);
  expect(refusals(f).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED', 'DIRECTION_IDLE_HASH']);
});

test('absent frames refuse in scene, direction and registration checks', () => {
  const f = registered(); f.writeScene();
  expect(f.publish(f.author()).exit).toBe(0);
  rmSync(join(f.dir, 'outputs'), { recursive: true });
  expect(refusals(f).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED', 'DIRECTION_FILE']);
  expect(checkProject(f.dir).refusals.map(value => value.code)).toContain('RIG_REGISTRATION_FILE_INVALID');
});

test('idle PNGs are bound through the version outputs inventory', () => {
  const f = registered();
  const project = f.load(); const rig = objects(project.versions)[0]!;
  const png = objects(rig.outputs).find(value => /\/idle\/.*\/f\d+\.png$/.test(String(value.path)))!;
  expect(directionIdleBytes(f.dir, project, 1, { path: png.path!, sha256: png.sha256! })).toEqual(readFileSync(join(f.dir, String(png.path))));
  expect(() => directionIdleBytes(f.dir, project, 1, { path: png.path!, sha256: '0'.repeat(64) })).toThrow(expect.objectContaining({ code: 'DIRECTION_IDLE_UNBOUND' }));
  expect(() => directionIdleBytes(f.dir, project, 2, { path: png.path!, sha256: png.sha256! })).toThrow(expect.objectContaining({ code: 'DIRECTION_IDLE_VERSION' }));
  expect(() => directionIdleBytes(f.dir, project, 1, { path: 'outputs/v1/out/rig/rig.json', sha256: png.sha256! })).toThrow(expect.objectContaining({ code: 'DIRECTION_FILE' }));
});
