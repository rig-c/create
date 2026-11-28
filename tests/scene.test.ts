import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding } from '../src/check.ts';
import { directionHash, objects } from '../src/direction.ts';
import { checkScenes, currentScene, plateRegistration, readScene, sceneReference, sceneRig, validateScene } from '../src/scene.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, sceneCommand, testClock } from './clock.ts';
import { seedRetainedScene } from './numbered-seed.ts';
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

test('retained scene records bind immutable raw-byte plates, optional foreground and fixed layers', () => {
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

test('an uncommitted scene document is ignored by checkScenes', () => {
  const f = sceneFixture();
  mkdirSync(join(f.dir, 'evidence/scene'));
  const bytes = Buffer.from('{"uncommitted":true}\n');
  f.write('evidence/scene/s1.json', bytes);
  expect(findings(f)).toEqual([]);
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

test('SCENE_STAGE_MISSING refuses a model with null stage in sceneRig and validateScene', () => {
  const f = sceneFixture();
  const p = f.load();
  const binding = f.write(f.modelPath, JSON.stringify({ ...f.model, stage: null }));
  const rig = objects(p.versions)[0]!;
  const pkg = rig.review_package as JsonObject;
  (pkg.files as JsonObject[])[0]!.sha256 = binding.sha256!;
  // Preserve the signoff's exact target while exercising this producer-declared stage.
  ((objects(p.signoffs).find(value => value.stage === 'rig-review')!.target as JsonObject).review_package as JsonObject).sha256 = reviewPackageHash(pkg);
  f.save(p);
  reject(f, 'SCENE_STAGE_MISSING', () => sceneRig(f.dir, f.load(), 1));
});

test('SCENE_PLATE_UNREGISTERED refuses unregistered input hashes and broken receipt chains', () => {
  const f = sceneFixture();
  f.writeScene();
  const p = f.load(); const registered = objects(p.inputs); p.inputs = []; f.save(p);
  expect(findings(f).map(v => v.code)).toContain('SCENE_PLATE_UNREGISTERED');
  p.inputs = registered.filter(input => input.path === f.foreground.path);
  p.derived = [{ kind: 'prepared-input', ...f.background, source: { ...f.foreground, sha256: '0'.repeat(64) }, operation: 'Synthetic prepared plate' }];
  f.save(p);
  expect(findings(f).map(v => v.code)).toContain('SCENE_PLATE_UNREGISTERED');
});

test('a receipted fan-in chain accepts every registered source and rejects cycles or missing result hashes', () => {
  const f = sceneFixture();
  const p = f.load();
  const intermediate = f.write('intermediate.png', Buffer.concat([readFileSync(join(f.dir, 'foreground.png')), Buffer.from('\n')]));
  p.inputs = objects(p.inputs).filter(input => input.path === f.foreground.path);
  p.derived = [{ kind: 'prepared-input', ...intermediate, source: f.foreground, operation: 'First synthetic preparation' }, { kind: 'prepared-input', ...f.background, sources: [intermediate, f.foreground], operation: 'Second synthetic preparation' }];
  f.save(p); f.seedHistoricalScene();
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

test('uniform world rects can extend past stage on historical scenes while agent scenes bind the picked rect', () => {
  const f = sceneFixture();
  f.seedHistoricalScene({ x: -128, y: -50, width: 256, height: 256 });
  expect(findings(f)).toEqual([]);
  const g = sceneFixture();
  seedRetainedScene([...g.args(), '--background-rect', '-128,-50,256,256'], testClock.now());
  expect(findings(g).map(v => v.code)).toEqual(['SCENE_CHOICE_MISMATCH']);
});

test('registration.idle is retained exactly, absent for legacy, and raw-byte sealed', () => {
  const f = sceneFixture();
  const p = f.load(); const rig = objects(p.versions)[0]!;
  rig.registration = { idle: f.write('idle-frames.json', '{"spec":"rigc-frames/1","sets":[]}\n') };
  f.save(p); f.seedHistoricalScene();
  expect(((loadScene(f).rig as JsonObject).animation as JsonObject).frames).toEqual((rig.registration as JsonObject).idle);
  expect(findings(f)).toEqual([]);
  plant(f, doc => { delete ((doc.rig as JsonObject).animation as JsonObject).frames; });
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_MALFORMED']);
  plant(f, doc => { ((doc.rig as JsonObject).animation as JsonObject).frames = (rig.registration as JsonObject).idle!; });
  f.write('idle-frames.json', '{}');
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED']);
});

test('default and explicit idle seed byte-identical scenes and project records', () => {
  const implicit = sceneFixture();
  expect(implicit.writeScene().exit).toBe(0);
  const explicit = sceneFixture();
  expect(seedRetainedScene([...explicit.args(), '--animation', 'idle'], testClock.now()).exit).toBe(0);
  for (const path of ['evidence/scene/s1.json', 'project.json']) {
    expect(readFileSync(join(explicit.dir, path))).toEqual(readFileSync(join(implicit.dir, path)));
  }
});

test('a non-idle clip from the bound model validates without idle frame evidence', () => {
  const f = sceneFixture(['idle', 'look']);
  expect(seedRetainedScene([...f.args(), '--animation', 'look'], testClock.now()).exit).toBe(0);
  expect((loadScene(f).rig as JsonObject).animation).toEqual({ name: 'look' });
  expect(findings(f)).toEqual([]);
});

test('unknown animation and a default idle absent from the model refuse in sceneRig', () => {
  const f = sceneFixture(['look']);
  reject(f, 'SCENE_ANIMATION_MISSING', () => f.writeScene());
  for (const name of ['unknown', 'LOOK', ' ']) {
    reject(f, 'SCENE_ANIMATION_MISSING', () => sceneRig(f.dir, f.load(), 1, undefined, name));
  }
  expect(seedRetainedScene([...f.args(), '--animation', 'look'], testClock.now()).exit).toBe(0);
  expect((loadScene(f).rig as JsonObject).animation).toEqual({ name: 'look' });
});

test('non-idle selection reads the sealed model rather than trusting a changed catalog', () => {
  const f = sceneFixture();
  f.write(f.modelPath, JSON.stringify({ ...f.model, animations: [{ name: 'look' }] }));
  reject(f, 'SCENE_MODEL_MISMATCH', () => sceneRig(f.dir, f.load(), 1, undefined, 'look'));
});

test('missing and duplicate animation flags refuse on the current scene writer before publishing bytes', () => {
  const f = sceneFixture();
  const base = ['write', f.dir, '--background', 'background.png', '--citations-file', 'background-citation.json'];
  reject(f, 'SCENE_MALFORMED', () => sceneCommand([...base, '--animation']));
  reject(f, 'SCENE_MALFORMED', () => sceneCommand([...base, '--animation', 'idle', '--animation', 'idle']));
});

test('non-idle omits idle frames while preserving the old reader binding as sealed legacy metadata', () => {
  const f = sceneFixture(['idle', 'look']);
  const p = f.load();
  const registration = { idle: f.write('idle-frames.json', '{"spec":"rigc-frames/1","sets":[]}\n') };
  objects(p.versions)[0]!.registration = registration;
  f.save(p);
  expect(sceneRig(f.dir, p, 1).rig.animation).toEqual({ name: 'idle', frames: registration.idle });
  expect(sceneRig(f.dir, p, 1, undefined, 'look').rig.animation).toEqual({ name: 'look' });
  f.seedHistoricalScene();
  plant(f, doc => { (doc.rig as JsonObject).animation = { name: 'look' }; });
  expect(findings(f)).toEqual([]);
  validateScene(f.dir, f.load(), loadScene(f));
  plant(f, doc => { ((doc.rig as JsonObject).animation as JsonObject).frames = registration.idle; });
  const historicalBytes = readFileSync(join(f.dir, 'evidence/scene/s1.json'));
  expect(findings(f)).toEqual([]);
  validateScene(f.dir, f.load(), loadScene(f));
  expect(readFileSync(join(f.dir, 'evidence/scene/s1.json'))).toEqual(historicalBytes);
  f.write('idle-frames.json', '{}');
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED']);
  f.write('idle-frames.json', '{"spec":"rigc-frames/1","sets":[]}\n');
  for (const frames of [f.write('look-frames.json', '{"spec":"rigc-frames/1","sets":[]}\n'), { ...registration.idle, sha256: '0'.repeat(64) }]) {
    plant(f, doc => { ((doc.rig as JsonObject).animation as JsonObject).frames = frames; });
    expect(findings(f).map(value => value.code)).toEqual(['SCENE_ANIMATION_FRAMES_UNBOUND']);
    expect(checkProject(f.dir).refusals.map(value => value.code)).toContain('SCENE_ANIMATION_FRAMES_UNBOUND');
    reject(f, 'SCENE_ANIMATION_FRAMES_UNBOUND', () => validateScene(f.dir, f.load(), loadScene(f)));
  }
});

test('non-idle frames without registration were already unbound and remain refused', () => {
  const f = sceneFixture(['idle', 'look']);
  expect(seedRetainedScene([...f.args(), '--animation', 'look'], testClock.now()).exit).toBe(0);
  plant(f, doc => { ((doc.rig as JsonObject).animation as JsonObject).frames = f.write('frames.json', '{}'); });
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_ANIMATION_FRAMES_UNBOUND']);
});

test('historical human scene uniform scaling uses relative 1e-9 tolerance', () => {
  const f = sceneFixture(); f.seedHistoricalScene();
  plant(f, doc => { const rect = (doc.plates as JsonObject[])[0]!.rect as JsonObject; rect.width = Number(rect.height) * (1 + 5e-10); });
  expect(findings(f)).toEqual([]);
  plant(f, doc => { const rect = (doc.plates as JsonObject[])[0]!.rect as JsonObject; rect.width = Number(rect.height) * (1 + 2e-9); });
  expect(findings(f).map(value => value.code)).toEqual(['SCENE_PLACEMENT_INVALID']);
});

test('removed numbered scene write refuses before reading a malformed stage record', () => {
  const f = sceneFixture();
  f.save({ ...f.load(), stage: 'no-such-stage' });
  expect(checkProject(f.dir).refusals.map(value => value.code)).toEqual(['STAGE_UNKNOWN']);
  reject(f, 'NUMBERED_WRITER_REMOVED', () => sceneCommand(['write', f.dir, '--rig', '1', '--background', 'background.png', '--citations-file', 'background-citation.json']));
});

test('scene validator refuses a derived candidate without producer receipt', () => {
  const f = sceneFixture(); f.writeScene(); const p = f.load();
  p.inputs = objects(p.inputs).filter(i => i.path !== f.background.path);
  p.derived = [{ kind: 'prepared-input', ...f.background, source: f.foreground, operation: 'Synthetic preparation' }];
  f.save(p);
  expect(findings(f).map(v => v.code)).toContain('SCENE_PLATE_UNREGISTERED');
});

test('scene validator refuses an agent rect differing from the pick even within scale tolerance', () => {
  const f = sceneFixture();
  const rect = f.model.stage;
  seedRetainedScene([...f.args(), '--background-rect', `${rect.x},${rect.y},${rect.width * (1 + 5e-10)},${rect.height}`], testClock.now());
  expect(findings(f).map(v => v.code)).toEqual(['SCENE_CHOICE_MISMATCH']);
});

test('typed scene authors refuse on the current scene writer before writing, including a typed agent', () => {
  for (const by of ['user', 'agent']) {
    const f = sceneFixture();
    reject(f, 'SCENE_AUTHOR_TYPED', () => sceneCommand(['write', f.dir, '--background', 'background.png', '--citations-file', 'background-citation.json', '--by', by]));
  }
});

test('legacy input metadata is insufficient for agent scenes', () => {
  const f = sceneFixture(); f.writeScene(); const p = f.load(); delete objects(p.inputs)[0]!.origin;
  f.save(p);
  expect(findings(f).map(v => v.code)).toEqual(['SCENE_INPUT_RECEIPT_MISSING']);
});
