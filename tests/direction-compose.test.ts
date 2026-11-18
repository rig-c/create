import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { directionHash, directionPostIdentity, objects, readDirection, validateDirectionShape } from '../src/direction.ts';
import { composeRunMatchesAcceptedRig } from '../src/direction-compose.ts';
import { prepareLiveManifest, readPublished } from '../src/job-publication.ts';
import { composeFixture } from './direction-compose-fixture.ts';
import { checkDirections, directionCommand, testClock } from './clock.ts';
import type { JsonObject } from '../src/templates.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); testClock.reset(); });
function fixture() { const f = composeFixture(); roots.push(f.dir); return f; }
function rejected(f: ReturnType<typeof fixture>, code: string, run = () => f.publish()) {
  const before = readFileSync(join(f.dir, 'project.json'));
  expect(run).toThrow(expect.objectContaining({ code }));
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  expect(existsSync(join(f.dir, 'outputs/v2/compose'))).toBe(false);
  expect(existsSync(join(f.dir, 'evidence/compose-src/v2'))).toBe(false);
  expect(existsSync(join(f.dir, 'evidence/direction/v2.json'))).toBe(false);
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
  expect(composeRunMatchesAcceptedRig()).toBe('not yet applicable');
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

test('DIRECTION_COMPOSE_PLACEMENT refuses a nonzero producer shift', () => {
  const f = fixture(); objects(f.report.characters)[0]!.shift = [1, 0]; f.put('compose-out/scene.json', f.report); rejected(f, 'DIRECTION_COMPOSE_PLACEMENT');
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
