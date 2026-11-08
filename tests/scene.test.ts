import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding } from '../src/check.ts';
import { directionHash, objects } from '../src/direction.ts';
import { checkScenes, currentScene, plateRegistration, readScene, sceneReference, validateScene } from '../src/scene.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { clockedCli } from './helpers.ts';
import { checkProject, sceneCommand, testClock } from './clock.ts';
import { sceneFixture } from './scene-fixture.ts';

afterEach(() => testClock.reset());
function loadScene(f: ReturnType<typeof sceneFixture>): JsonObject {
  const entry = currentScene(f.load())!;
  return JSON.parse(readFileSync(join(f.dir, String(entry.path)), 'utf8'));
}
function findings(f: ReturnType<typeof sceneFixture>): Finding[] {
  const ctx = { dir: f.dir, project: f.load(), refusals: [] as Finding[] };
  checkScenes(ctx);
  return ctx.refusals;
}
function plant(f: ReturnType<typeof sceneFixture>, edit: (doc: JsonObject) => void): void {
  const p = f.load();
  const entry = currentScene(p)!;
  const doc = loadScene(f);
  edit(doc);
  entry.sha256 = f.write(String(entry.path), JSON.stringify(doc)).sha256!;
  f.save(p);
}
function reject(f: ReturnType<typeof sceneFixture>, code: string, operation: () => unknown): void {
  const bytes = readFileSync(join(f.dir, 'project.json'));
  const files = readdirSync(f.dir, { recursive: true });
  expect(operation).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(bytes);
  expect(readdirSync(f.dir, { recursive: true })).toEqual(files);
}

test('scene writer commits immutable raw-byte bindings, optional foreground and fixed layers', () => {
  const f = sceneFixture();
  const before = f.load();
  expect(f.writeScene().exit).toBe(0);
  const p = f.load();
  const doc = loadScene(f);
  expect(p.stage).toBe(before.stage);
  expect(p.direction_contract).toEqual(before.direction_contract);
  expect(doc.layers).toEqual(['background', 'rig']);
  expect((doc.plates as JsonObject[])[0]!.rect).toEqual(f.model.stage);
  expect((doc.rig as JsonObject).animation).toEqual({ name: 'idle' });
  expect(findings(f)).toEqual([]);
  const entry = currentScene(p)!;
  const first = readFileSync(join(f.dir, String(entry.path)));
  expect(entry.sha256).toBe(directionHash(first));
  expect(readScene(f.dir, p, sceneReference(entry))).toEqual(doc);
  expect(f.writeScene(true).exit).toBe(0);
  expect(loadScene(f).layers).toEqual(['background', 'rig', 'foreground']);
  expect(readFileSync(join(f.dir, String(entry.path)))).toEqual(first);
  expect(findings(f)).toEqual([]);
});

test('an uncommitted scene document is ignored and an occupied destination is preserved', () => {
  const f = sceneFixture();
  mkdirSync(join(f.dir, 'evidence/scene'));
  const bytes = Buffer.from('{"uncommitted":true}\n');
  f.write('evidence/scene/s1.json', bytes);
  expect(findings(f)).toEqual([]);
  reject(f, 'SCENE_FILE_CHANGED', () => f.writeScene());
  expect(readFileSync(join(f.dir, 'evidence/scene/s1.json'))).toEqual(bytes);
});

const controls: [string, (doc: JsonObject) => void][] = [
  ['SCENE_MALFORMED', doc => { doc.extra = true; }],
  ['SCENE_RIG_STALE', doc => { (doc.rig as JsonObject).version = 999; }],
  ['SCENE_ACCEPTANCE_STALE', doc => { (((doc.rig as JsonObject).acceptance as JsonObject).review_package as JsonObject).sha256 = '0'.repeat(64); }],
  ['SCENE_MODEL_MISMATCH', doc => { ((doc.rig as JsonObject).model as JsonObject).sha256 = '0'.repeat(64); }],
  ['SCENE_ANIMATION_MISSING', doc => { ((doc.rig as JsonObject).animation as JsonObject).name = 'unknown'; }],
  ['SCENE_STAGE_MISMATCH', doc => { ((doc.frame as JsonObject).stage as JsonObject).y = 0; }],
  ['SCENE_PLATE_CONFLICT', doc => { doc.plates = []; }],
  ['SCENE_PLATE_CHANGED', doc => { (doc.plates as JsonObject[])[0]!.sha256 = '0'.repeat(64); }],
  ['SCENE_PLATE_DIMENSIONS', doc => { (doc.plates as JsonObject[])[0]!.width = 999; }],
  ['SCENE_PLACEMENT_INVALID', doc => { ((doc.plates as JsonObject[])[0]!.rect as JsonObject).width = 2; }],
  ['SCENE_PLATE_UNREGISTERED', doc => { ((doc.plates as JsonObject[])[0]!.registered as JsonObject).ref = 'inputs[99]'; }],
  ['SCENE_CITATION_MISSING', doc => { delete (doc.plates as JsonObject[])[0]!.citation; }],
  ['SCENE_LAYER_ORDER', doc => { doc.layers = ['rig', 'background']; }],
];
for (const [code, edit] of controls) {
  test(`${code} is asserted through the shared validator and project checker`, () => {
    const f = sceneFixture(); f.writeScene(); plant(f, edit);
    expect(findings(f).map(value => value.code)).toContain(code);
    expect(checkProject(f.dir).refusals.map(value => value.code)).toContain(code);
    reject(f, code, () => validateScene(f.dir, f.load(), loadScene(f)));
  });
}
for (const action of ['missing', 'changed']) {
  test(`SCENE_FILE_CHANGED detects ${action} committed document bytes`, () => {
    const f = sceneFixture(); f.writeScene();
    if (action === 'missing') rmSync(join(f.dir, 'evidence/scene/s1.json'));
    else f.write('evidence/scene/s1.json', '{}');
    expect(findings(f).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED']);
  });
}

test('SCENE_STAGE_MISSING refuses a model with null stage before writing', () => {
  const f = sceneFixture();
  const p = f.load();
  const binding = f.write(f.modelPath, JSON.stringify({ ...f.model, stage: null }));
  const rig = objects(p.versions)[0]!;
  const pkg = rig.review_package as JsonObject;
  (pkg.files as JsonObject[])[0]!.sha256 = binding.sha256!;
  // Preserve the signoff's exact target while exercising this producer-declared stage.
  ((objects(p.signoffs).find(value => value.stage === 'rig-review')!.target as JsonObject).review_package as JsonObject).sha256 = reviewPackageHash(pkg);
  f.save(p);
  reject(f, 'SCENE_STAGE_MISSING', () => f.writeScene());
});

test('SCENE_PLATE_UNREGISTERED refuses unregistered input hashes and broken receipt chains', () => {
  const f = sceneFixture();
  const p = f.load(); const registered = objects(p.inputs); p.inputs = []; f.save(p);
  reject(f, 'SCENE_PLATE_UNREGISTERED', () => f.writeScene());
  p.inputs = registered.filter(input => input.path === f.foreground.path);
  p.derived = [{ kind: 'prepared-input', ...f.background, source: { ...f.foreground, sha256: '0'.repeat(64) }, operation: 'Synthetic prepared plate' }];
  f.save(p); reject(f, 'SCENE_PLATE_UNREGISTERED', () => f.writeScene());
});

test('a receipted fan-in chain accepts every registered source and rejects cycles or missing result hashes', () => {
  const f = sceneFixture();
  const p = f.load();
  const intermediate = f.write('intermediate.png', Buffer.concat([readFileSync(join(f.dir, 'foreground.png')), Buffer.from('\n')]));
  p.inputs = objects(p.inputs).filter(input => input.path === f.foreground.path);
  p.derived = [{ kind: 'prepared-input', ...intermediate, source: f.foreground, operation: 'First synthetic preparation' }, { kind: 'prepared-input', ...f.background, sources: [intermediate, f.foreground], operation: 'Second synthetic preparation' }];
  f.save(p); expect(f.writeScene().exit).toBe(0);
  expect(((loadScene(f).plates as JsonObject[])[0]!.registered as JsonObject).ref).toBe('derived[1]');
  expect(findings(f)).toEqual([]);
  const derived = p.derived as JsonObject[];
  derived[0]!.source = f.background;
  expect(plateRegistration(p, f.background)).toBeNull();
  derived[0]!.source = f.foreground;
  delete derived[1]!.sha256;
  expect(plateRegistration(p, f.background)).toBeNull();
});

for (const path of ['rig', 'rig.acceptance', 'rig.acceptance.signoff', 'rig.acceptance.review_package', 'rig.model', 'rig.animation', 'frame', 'frame.stage', 'plates.0', 'plates.0.rect', 'plates.0.registered', 'plates.0.citation']) {
  test(`SCENE_MALFORMED closes nested keys at ${path}`, () => {
    const f = sceneFixture(); f.writeScene();
    plant(f, doc => {
      let value: unknown = doc;
      for (const part of path.split('.')) value = (value as Record<string, unknown>)[part];
      (value as JsonObject).unexpected = true;
    });
    expect(findings(f).map(value => value.code)).toEqual(['SCENE_MALFORMED']);
  });
}

test('declared foreground missing, changed or wrong-sized refuses while absent foreground succeeds', () => {
  for (const mode of ['missing', 'changed', 'dimensions']) {
    const f = sceneFixture(); f.writeScene(true);
    if (mode === 'missing') rmSync(join(f.dir, 'foreground.png'));
    if (mode === 'changed') f.write('foreground.png', '{}');
    if (mode === 'dimensions') plant(f, doc => { (doc.plates as JsonObject[])[1]!.height = 2; });
    expect(findings(f).map(value => value.code)).toEqual([mode === 'dimensions' ? 'SCENE_PLATE_DIMENSIONS' : 'SCENE_PLATE_CHANGED']);
  }
});

test('uniform world rects can extend past stage and reject nonfinite or anisotropic CLI values', () => {
  const f = sceneFixture();
  expect(sceneCommand([...f.args(), '--background-rect', '-128,-50,256,256']).exit).toBe(0);
  for (const rect of ['0,0,0,128', '0,0,128,64', 'NaN,0,128,128', '0,Infinity,128,128', '0,,128,128']) reject(f, 'SCENE_PLACEMENT_INVALID', () => sceneCommand([...f.args(), '--background-rect', rect]));
});

test('a failed commit restores published document and all writer-created paths', () => {
  const f = sceneFixture();
  const original = readFileSync(join(f.dir, 'project.json'));
  const files = readdirSync(f.dir, { recursive: true });
  expect(() => sceneCommand(f.args(), { beforeCommit: () => { throw Error('injected fault'); } })).toThrow('injected fault');
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(original);
  expect(readdirSync(f.dir, { recursive: true })).toEqual(files);
});

test('source races and a shared direction lock refuse before the project commit', () => {
  const f = sceneFixture();
  const original = readFileSync(join(f.dir, 'project.json'));
  expect(() => sceneCommand(f.args(), { beforeCommit: () => { f.write('background.png', 'changed'); } })).toThrow(expect.objectContaining({ code: 'SCENE_FILE_CHANGED' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(original);
  expect(readdirSync(join(f.dir, 'evidence'))).not.toContain('scene');
  f.write('.direction.lock', 'busy');
  reject(f, 'SCENE_MALFORMED', () => f.writeScene());
});

test('project-relative paths reject symlinks and traversal', () => {
  const f = sceneFixture();
  symlinkSync(join(f.dir, 'background.png'), join(f.dir, 'linked.png'));
  for (const path of ['linked.png', '../background.png', '/background.png']) {
    const args = f.args(); args[args.indexOf('--background') + 1] = path;
    reject(f, 'SCENE_PLATE_CHANGED', () => sceneCommand(args));
  }
});

test('CLI entry point writes a scene using only its documented flags', () => {
  const f = sceneFixture();
  const result = Bun.spawnSync([process.execPath, ...clockedCli(), 'scene', ...f.args()], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect(findings(f)).toEqual([]);
});

test('registration.idle is retained exactly, absent for legacy, and raw-byte sealed', () => {
  const f = sceneFixture();
  const p = f.load(); const rig = objects(p.versions)[0]!;
  rig.registration = { idle: f.write('idle-frames.json', '{"spec":"rigc-frames/1","sets":[]}\n') };
  f.save(p); expect(f.writeScene().exit).toBe(0);
  expect(((loadScene(f).rig as JsonObject).animation as JsonObject).frames).toEqual((rig.registration as JsonObject).idle);
  expect(findings(f)).toEqual([]);
  plant(f, doc => { delete ((doc.rig as JsonObject).animation as JsonObject).frames; });
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_MALFORMED']);
  plant(f, doc => { ((doc.rig as JsonObject).animation as JsonObject).frames = (rig.registration as JsonObject).idle!; });
  f.write('idle-frames.json', '{}');
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED']);
});

test('uniform scaling uses relative 1e-9 tolerance', () => {
  const f = sceneFixture(); f.writeScene();
  plant(f, doc => { const rect = (doc.plates as JsonObject[])[0]!.rect as JsonObject; rect.width = Number(rect.height) * (1 + 5e-10); });
  expect(findings(f)).toEqual([]);
  plant(f, doc => { const rect = (doc.plates as JsonObject[])[0]!.rect as JsonObject; rect.width = Number(rect.height) * (1 + 2e-9); });
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_PLACEMENT_INVALID']);
});

test('the scene writer is refused on a record whose stage check stopped early', () => {
  const f = sceneFixture();
  f.save({ ...f.load(), stage: 'no-such-stage' });
  expect(checkProject(f.dir).refusals.map(value => value.code)).toEqual(['STAGE_UNKNOWN']);
  reject(f, 'STAGE_UNKNOWN', () => f.writeScene());
});
