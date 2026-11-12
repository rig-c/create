import { tempDir } from './helpers.ts';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectItems, type Finding } from '../src/check.ts';
import { directionHash, objects } from '../src/direction.ts';
import { checkScenes, currentScene, readScene, sceneReference } from '../src/scene.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_REOPEN_AT } from '../scripts/example-time.ts';
import { fixture, materializeFixture } from './fixtures.ts';
import { sceneFixture } from './scene-fixture.ts';
import { checkProject, directionCommand, reopenCommand, sceneCommand, testClock } from './clock.ts';
import { PARTS_REVIEW_LAPSES } from './fixtures.ts';

afterEach(() => testClock.reset());
function scenes(dir: string, project: JsonObject): Finding[] {
  const ctx = { dir, project, refusals: [] as Finding[] }; checkScenes(ctx); return ctx.refusals;
}

test('signed ruling: reopening the filled example with a scene passes check through the public writer', () => {
  const dir = fixture(() => {}, 'example-project.json');
  testClock.set(EXAMPLE_REOPEN_AT);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings).toEqual([]);
  writeFileSync(join(dir, 'reopen-words.txt'), 'Reopen the synthetic parts for correction.');
  const before = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(reopenCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', join(dir, 'reopen-words.txt')]).exit).toBe(0);
  const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  expect(after.scenes).toEqual(before.scenes);
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings.map(f => [f.code, f.path])).toEqual(PARTS_REVIEW_LAPSES);
});

test('signed ruling: a tampered historical scene refuses SCENE_FILE_CHANGED', () => {
  const f = sceneFixture(); f.writeScene();
  const p = f.load();
  p.reopens = [{ stage: 'rigging', from_stage: 'post', at: '2026-11-07T10:01:00Z', by: 'user', verbatim: 'Revise the rig.', steps_before: [] }];
  f.save(p);
  expect(scenes(f.dir, p)).toEqual([]);
  f.write('evidence/scene/s1.json', '{}');
  expect(scenes(f.dir, p).map(value => value.code)).toEqual(['SCENE_FILE_CHANGED']);
});

test('signed ruling: a historical scene citing a never-accepted rig refuses SCENE_RIG_STALE', () => {
  const f = sceneFixture(); f.writeScene();
  const p = f.load();
  p.reopens = [{ stage: 'rigging', from_stage: 'post', at: '2026-11-07T10:01:00Z', by: 'user', verbatim: 'Revise the rig.', steps_before: [] }];
  objects(p.versions)[0]!.verdicts = [];
  expect(scenes(f.dir, p).map(value => value.code)).toEqual(['SCENE_RIG_STALE']);
});

test('signed ruling: scene write after a reopen binds the new accepted rig as s<N+1>', () => {
  const f = sceneFixture(); f.writeScene();
  const original = readFileSync(join(f.dir, 'evidence/scene/s1.json'));
  const p = f.load();
  p.reopens = [{ stage: 'rigging', from_stage: 'post', at: '2026-11-07T10:01:00Z', by: 'user', verbatim: 'Revise the rig.', steps_before: [] }];
  const rig = structuredClone(objects(p.versions)[0]!);
  rig.n = 2; rig.at = '2026-11-07T10:02:00Z';
  objects(rig.verdicts)[0]!.at = '2026-11-07T10:03:00Z';
  const model = 'derived/review/v2/out/check/build/skeleton.model.json';
  mkdirSync(dirname(join(f.dir, model)), { recursive: true });
  f.write(model, readFileSync(join(f.dir, f.modelPath)));
  p.versions = [...objects(p.versions), rig];
  p.signoffs = [...objects(p.signoffs), { stage: 'rig-review', checkpoint: null, by: 'user', at: '2026-11-07T10:03:00Z', verbatim: 'Accept the updated synthetic rig.',
    target: { version: 2, verdict: 'versions[1].verdicts[0]', review_package: { path: 'versions[1].review_package', sha256: reviewPackageHash(rig.review_package as JsonObject) } } }];
  f.save(p); testClock.set('2026-11-07T10:04:00Z');
  const args = f.args(); args[args.indexOf('--rig') + 1] = '2';
  expect(sceneCommand(args).exit).toBe(0);
  const entry = currentScene(f.load())!;
  expect(entry.n).toBe(2); expect(entry.path).toBe('evidence/scene/s2.json');
  expect((readScene(f.dir, f.load(), sceneReference(entry)).rig as JsonObject).version).toBe(2);
  expect(readFileSync(join(f.dir, 'evidence/scene/s1.json'))).toEqual(original);
  expect(scenes(f.dir, f.load())).toEqual([]);
});

test('historical package identity and past human acceptance stay mandatory after a later bounce', () => {
  const f = sceneFixture(); f.writeScene();
  const p = f.load(); const rig = objects(p.versions)[0]!;
  rig.verdicts = [...objects(rig.verdicts), { review: 'rig-review', verdict: 'bounced', by: 'user', at: '2026-11-07T10:01:00Z', verbatim: 'Revise the rig.' }];
  expect(scenes(f.dir, p)).toEqual([]);
  (rig.review_package as JsonObject).config = { path: 'changed.json', sha256: '0'.repeat(64) };
  expect(scenes(f.dir, p).map(value => value.code)).toEqual(['SCENE_ACCEPTANCE_STALE']);
});

test('the scene model texture pages retain raw-byte seals in the same project package', () => {
  const dir = fixture(() => {}, 'example-project.json');
  testClock.set(EXAMPLE_REOPEN_AT);
  const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const doc = readScene(dir, p, sceneReference(currentScene(p)!));
  const rig = doc.rig as JsonObject;
  const version = objects(p.versions).find(value => value.n === rig.version)!;
  const pkg = version.review_package as JsonObject;
  const model = rig.model as JsonObject;
  const compiled = JSON.parse(readFileSync(join(dir, String(model.path)), 'utf8')) as JsonObject;
  expect(objects(compiled.pages).length).toBeGreaterThan(0);
  for (const page of objects(compiled.pages)) {
    const path = `out/check/build/${String(page.name)}`;
    const row = objects(pkg.files).find(value => value.path === path)!;
    expect(row).toBeDefined();
    const bytes = readFileSync(join(dir, `derived/review/v${String(rig.version)}/${path}`));
    expect(row.sha256).toBe(directionHash(bytes));
  }
});

test('legacy rig option contexts retain their exact identity after scene adoption', async () => {
  const { validateContext } = await import('../src/choices.ts');
  const dir = fixture(() => {}, 'example-project.json');
  testClock.set(EXAMPLE_REOPEN_AT);
  const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const item = objects(((p.interview as JsonObject).post as JsonObject).items).find(value => value.id === 'camera_depth')!;
  const binding = ((item.guide as JsonObject).choice as JsonObject).set as JsonObject;
  const set = JSON.parse(readFileSync(join(dir, String(binding.path)), 'utf8')) as JsonObject;
  expect((set.context as JsonObject).kind).toBe('rig');
  expect(currentScene(p)).toBeDefined();
  expect(() => validateContext(dir, p, set, testClock.now(), true)).not.toThrow();
});


for (const writer of ['scene', 'direction'] as const) {
  test(`${writer} writer freezes plate citation option evidence before its project commit`, () => {
    const dir = fixture(() => {}, 'example-project.json');
    testClock.set(EXAMPLE_REOPEN_AT);
    writeFileSync(join(dir, 'reopen-words.txt'), 'Revise the synthetic composition.');
    reopenCommand(['post', dir, '--by', 'user', '--verbatim-file', join(dir, 'reopen-words.txt')]);
    const before = readFileSync(join(dir, 'project.json'));
    const project = JSON.parse(before.toString('utf8')) as JsonObject;
    const item = collectItems(project, { collection: null }).find(value => value.id === 'post_composition')!;
    const binding = (((item.raw as JsonObject).choice as JsonObject).set as JsonObject);
    const evidence = join(dir, String(binding.path));
    const original = readFileSync(evidence);
    expect(checkProject(dir).refusals).toEqual([]);
    const hook = { beforeCommit: () => writeFileSync(evidence, Buffer.concat([original, Buffer.from('\n')])) };
    const code = writer === 'scene' ? 'SCENE_FILE_CHANGED' : 'DIRECTION_SOURCE_CHANGED';
    const operation = writer === 'scene'
      ? () => sceneCommand(['write', '--rig', '2', '--background', 'evidence/scene-background.png', '--citations-file', 'evidence/scene-citations.json', dir], hook)
      : () => directionCommand(['write', '5', dir, '--file', 'evidence/direction-input-v4.json', '--rig', '2'], hook);
    expect(operation).toThrow(expect.objectContaining({ code }));
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
    expect(existsSync(join(dir, writer === 'scene' ? 'evidence/scene/s2.json' : 'evidence/direction/v5.json'))).toBe(false);
  });
}


for (const inherited of [false, true]) {
  test(`scene snapshots retain ${inherited ? 'inherited' : 'member'} post_composition choice history`, () => {
    testClock.set(EXAMPLE_REOPEN_AT);
    const root = tempDir();
    const dir = join(root, 'members', 'synthetic-member');
    mkdirSync(dirname(dir), { recursive: true });
    materializeFixture(dir);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const item = collectItems(project, { collection: null }).find(value => value.id === 'post_composition')!;
    const answer = item.raw as JsonObject;
    const binding = ((answer.choice as JsonObject).set as JsonObject);
    const bytes = readFileSync(join(dir, String(binding.path)));
    const path = 'evidence/interview/composition-history.json';
    writeFileSync(join(dir, path), bytes);
    const historical = structuredClone(answer);
    (historical.choice as JsonObject).set = { path, sha256: directionHash(bytes) };
    if (inherited) {
      writeFileSync(join(root, 'collection.json'), JSON.stringify({ schema: 'rig-create/collection@0', name: 'synthetic-collection', interview: { post: { items: [{ id: 'post_composition', guide: answer, history: [historical] }] } } }));
      item.record.guide = { basis: 'inherited', from: { collection: 'synthetic-collection', question: 'post_composition' } };
    } else {
      item.record.history = [...objects(item.record.history), historical];
    }
    const snapshots = new Map<string, Buffer>();
    readScene(dir, project, sceneReference(currentScene(project)!), snapshots);
    expect(snapshots.get(String(binding.path))).toEqual(bytes);
    expect(snapshots.get(path)).toEqual(bytes);
  });
}
