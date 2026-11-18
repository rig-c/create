import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { directionHash, directionPostIdentity, objects, readDirection, validateDirectionShape } from '../src/direction.ts';
import { composeRunMatchesAcceptedRig, readComposeRun } from '../src/direction-compose.ts';
import { prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { composeFixture, composeRunFixture } from './direction-compose-fixture.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import { checkDirections, directionCommand, testClock } from './clock.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); testClock.reset(); });
function fixture() { const f = composeFixture(); roots.push(f.dir); return f; }
function rejected(f: ReturnType<typeof fixture>, code: string, run = () => f.publish()) {
  const before = readFileSync(join(f.dir, 'project.json'));
  const paths = ['outputs', 'outputs/v2', 'outputs/v2/compose', 'evidence', 'evidence/compose-src', 'evidence/compose-src/v2', 'evidence/direction', 'evidence/direction/v2.json'];
  const existed = paths.map(path => existsSync(join(f.dir, path)));
  expect(run).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  for (const [index, path] of paths.entries()) expect(existsSync(join(f.dir, path))).toBe(existed[index]!);
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

test('direction@3 publishes the compose model, atlas and pages without the character package', async () => {
  const f = fixture(); f.publish(); const p = f.load();
  const path = prepareLiveManifest(f.dir, p, 2); const manifest = JSON.parse(readFileSync(join(f.dir, path), 'utf8'));
  expect(manifest.model).toBe('outputs/v2/compose/check/build/skeleton.model.json'); expect(manifest.scene).toBeUndefined();
  const pub = await readPublished({ root: f.dir, record: { path: 'project.json', sha256: directionHash(readFileSync(join(f.dir, 'project.json'))) }, result: { path, selector: { kind: 'post', version: 2, rigVersion: 1 } } });
  expect(pub.files.map(f => f.path)).toContain('outputs/v2/compose/check/build/skeleton.atlas');
  expect(pub.files.map(f => f.path)).toContain('outputs/v2/compose/check/build/page.png');
  expect(pub.files.some(f => f.path.startsWith('derived/review/'))).toBe(false);
  expect(pub.parts).toBeNull(); expect(pub.partIds).toEqual([]);
});

for (const [field, value] of [['extra', true], ['camera', {}], ['scene', {}]]) test(`DIRECTION_COMPOSE_SCHEMA rejects closed-document extra ${field}`, () => {
  const f = fixture(); f.doc[String(field)] = value; rejected(f, 'DIRECTION_COMPOSE_SCHEMA');
});

test('SCENE_ACCEPTANCE_STALE refuses an absent rig seal without writing', () => {
  const f = fixture(); const p = f.load(); p.signoffs = objects(p.signoffs).filter(s => s.stage !== 'rig-review'); f.save(p); rejected(f, 'SCENE_ACCEPTANCE_STALE');
});

test('DIRECTION_COMPOSE_PLATE_UNREGISTERED refuses an unregistered plate', () => {
  const f = fixture(); const p = f.load(); p.inputs = []; f.save(p); rejected(f, 'DIRECTION_COMPOSE_PLATE_UNREGISTERED');
});

test('DIRECTION_COMPOSE_CHOICE_MISMATCH refuses order differing from the owner choice', () => {
  const f = fixture(); f.scene.order = ['front', 'actor', 'back']; f.put('compose.scene.json', f.scene); rejected(f, 'DIRECTION_COMPOSE_CHOICE_MISMATCH');
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

test('DIRECTION_COMPOSE_PLACEMENT refuses a nonzero producer shift', () => {
  const f = fixture(); objects(f.report.characters)[0]!.shift = [1, 0]; f.put('compose-out/scene.json', f.report); rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
});

for (const path of ['outputs', 'outputs/v2', 'evidence/compose-src', 'outputs/v2/compose', 'evidence/compose-src/v2', 'evidence/direction']) test(`refused compose write preserves pre-existing ${path} and its contents`, () => {
  const f = fixture();
  mkdirSync(join(f.dir, path), { recursive: true });
  f.put(`${path}/keep.txt`, 'Existing directory contents');
  objects(f.report.characters)[0]!.shift = [1, 0]; f.put('compose-out/scene.json', f.report);
  const immutableRoot = path === 'outputs/v2/compose' || path === 'evidence/compose-src/v2';
  rejected(f, immutableRoot ? 'DIRECTION_COMPOSE_FILE' : 'DIRECTION_COMPOSE_PLACEMENT');
  expect(readFileSync(join(f.dir, path, 'keep.txt'), 'utf8')).toBe('Existing directory contents');
});

test('refused compose write releases its version directories for a corrected retry', () => {
  const f = fixture();
  objects(f.report.characters)[0]!.shift = [1, 0]; f.put('compose-out/scene.json', f.report);
  rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
  objects(f.report.characters)[0]!.shift = [0, 0]; f.put('compose-out/scene.json', f.report);
  expect(f.publish().exit).toBe(0);
});

test('refused compose write preserves another version added under its new shared parent', () => {
  const f = fixture(); const before = readFileSync(join(f.dir, 'project.json'));
  expect(() => f.publish({ beforeCommit: () => {
    f.put('outputs/v3/keep.txt', 'Another writer owns this version');
    f.put('compose-out/check/build/page.png', 'changed');
  } })).toThrow(expect.objectContaining({ code: 'DIRECTION_SOURCE_CHANGED' }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  expect(existsSync(join(f.dir, 'outputs/v2'))).toBe(false);
  expect(existsSync(join(f.dir, 'evidence/compose-src'))).toBe(false);
  expect(readFileSync(join(f.dir, 'outputs/v3/keep.txt'), 'utf8')).toBe('Another writer owns this version');
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
for (const [name, mutate] of malformedRuns) test(`DIRECTION_COMPOSE_RUN refuses ${name} without writing`, () => {
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
  // producer-build differs from the accepted outputs/v1/out; check/check.json is not frozen there.
  expect(existsSync(join(f.dir, 'outputs/v1/out/check/check.json'))).toBe(false);
  saveRun(f); expect(f.publish().exit).toBe(0);
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
test('DIRECTION_SOURCE_CHANGED snapshots accepted rig bytes before committing', () => {
  const f = fixture(); rejected(f, 'DIRECTION_SOURCE_CHANGED', () => f.publish({ beforeCommit: () => f.put('outputs/v1/out/rig/images/depth.png', 'changed') }));
});
test('DIRECTION_COMPOSE_RUN_SCENE compares retained raw scene bytes, including whitespace', () => {
  const f = fixture(); f.put('compose.scene.json', `${JSON.stringify(f.scene, null, 2)}\n`); rejected(f, 'DIRECTION_COMPOSE_RUN_SCENE');
});
test('direction@3 does not reopen the producer scene or build paths', () => {
  const f = fixture(); (f.run.scene as JsonObject).path = 'unavailable-source/scene.json'; saveRun(f);
  expect(f.publish().exit).toBe(0);
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
});

test('DIRECTION_SOURCE_CHANGED rolls back compose and scene if source bytes move before commit', () => {
  const f = fixture(); rejected(f, 'DIRECTION_SOURCE_CHANGED', () => f.publish({ beforeCommit: () => f.put('compose-out/check/build/page.png', 'changed') }));
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

test('direction@3 integrates into the filled project with zero check refusals', async () => {
  const { fixture: filled } = await import('./fixtures.ts');
  const { cpSync, writeFileSync } = await import('node:fs');
  const { collectItems } = await import('../src/check.ts');
  const { optionContext } = await import('../src/choices.ts');
  const { checkProject, reopenCommand, signoffCommand, inputCommand, advanceCommand } = await import('./clock.ts');
  const f = fixture();
  const dir = filled(() => {}, 'example-project.json'); roots.push(dir);
  testClock.set('2026-11-21T08:00:00Z');
  writeFileSync(join(dir, 'words.txt'), 'Revise the synthetic composed take.');
  reopenCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  const load = () => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const save = (p: JsonObject) => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);
  for (const name of ['background.png', 'foreground.png']) {
    cpSync(join(f.dir, name), join(dir, name));
    inputCommand(['add', name, dir, '--origin', 'synthetic plate']);
  }
  const p = load();
  // This legacy synthetic example retains the files but inventories only its old export pair.
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
  save(p); testClock.set('2026-11-21T08:01:00Z');
  signoffCommand(['post-interview', dir, '--by', 'user', '--verbatim-file', join(dir, 'words.txt')]);
  advanceCommand(['post', dir]);
  cpSync(join(f.dir, 'compose-out'), join(dir, 'compose-out'), { recursive: true }); cpSync(join(f.dir, 'compose.scene.json'), join(dir, 'compose.scene.json'));
  writeFileSync(join(dir, 'compose-out/compose-run.json'), JSON.stringify(composeRunFixture(dir, load(), 2, f.scene)));
  const doc = structuredClone(f.doc); doc.rig = { version: 2 };
  const citations = doc.citations as JsonObject;
  for (const [key, id] of [['camera', 'camera_depth'], ['timing', 'post_timing'], ['composition', 'post_composition']]) citations[key!] = { guide: id!, asks: [id!], quote: (items.find(i => i.id === id)!.raw as JsonObject).verbatim! };
  writeFileSync(join(dir, 'evidence/composed-direction.json'), JSON.stringify(doc));
  directionCommand(['write', '5', dir, '--file', 'evidence/composed-direction.json', '--rig', '2', '--compose-out', 'compose-out', '--compose-scene', 'compose.scene.json']);
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
});

for (const field of ['canvas', 'plates', 'character', 'tracks']) test(`DIRECTION_COMPOSE_CHOICE_MISMATCH binds the exact owner ${field}`, () => {
  const f = fixture();
  if (field === 'canvas') { f.scene.canvas = { width: 63, height: 48 }; f.report.canvas = f.scene.canvas; f.put('compose-out/scene.json', f.report); }
  if (field === 'plates') { objects(f.scene.plates)[0]!.at = [-1, 0]; objects(f.report.plates)[0]!.at = [-1, 0]; f.put('compose-out/scene.json', f.report); }
  if (field === 'character') { objects(f.scene.characters)[0]!.scale = 0.5; objects(f.report.characters)[0]!.scale = 0.5; f.put('compose-out/scene.json', f.report); }
  if (field === 'tracks') { const idle = (f.scene.animations as JsonObject).idle as JsonObject; objects(objects(idle.tracks)[0]!.keys)[1]!.v = [4, 0]; }
  f.put('compose.scene.json', f.scene); rejected(f, 'DIRECTION_COMPOSE_CHOICE_MISMATCH');
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
});

test('DIRECTION_COMPOSE_HASH detects changed frozen model bytes at check', () => {
  const f = fixture(); f.publish(); f.put('outputs/v2/compose/check/build/skeleton.model.json', 'changed');
  expect(() => readDirection(f.dir, f.load(), 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_HASH' }));
});

test('DIRECTION_COMPOSE_FILE refuses a missing compose producer record before writing', () => {
  const f = fixture(); rmSync(join(f.dir, 'compose-out/compose-run.json')); rejected(f, 'DIRECTION_COMPOSE_FILE');
});

test('DIRECTION_COMPOSE_INVENTORY binds atlas and pages as well as the model', () => {
  const f = fixture(); f.publish(); const p = f.load(); const post = objects(p.versions).find(v => v.n === 2)!;
  post.outputs = objects(post.outputs).filter(o => o.path !== 'outputs/v2/compose/check/build/page.png'); f.save(p);
  expect(() => readDirection(f.dir, p, 2)).toThrow(expect.objectContaining({ code: 'DIRECTION_COMPOSE_INVENTORY' }));
});

test('DIRECTION_PATCH directs composed revisions through a new compose write', () => {
  const f = fixture(); f.publish(); f.put('evidence/patch.json', { schema: 'rig-review-direction-patch/1', source_post: 2 });
  expect(() => directionCommand(['patch', '3', f.dir, '--patch-file', 'evidence/patch.json'])).toThrow(expect.objectContaining({ code: 'DIRECTION_PATCH' }));
});

for (const target of ['scene-source', 'frozen-extra', 'registered-plate']) test(`DIRECTION_SOURCE_CHANGED refuses a concurrent ${target} edit before committing`, () => {
  const f = fixture(); rejected(f, 'DIRECTION_SOURCE_CHANGED', () => f.publish({ beforeCommit: () => {
    if (target === 'scene-source') rmSync(join(f.dir, 'compose.scene.json'));
    if (target === 'frozen-extra') f.put('outputs/v2/compose/extra.json', '{}');
    if (target === 'registered-plate') rmSync(join(f.dir, 'background.png'));
  } }));
});
