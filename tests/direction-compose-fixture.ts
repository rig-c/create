/** Synthetic two-plate composed take; compiled idle intentionally has no loop field. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { directionHash, objects } from '../src/direction.ts';
import { DIRECTION_COMPOSE_SPEC, composeRoot, composeScenePath } from '../src/direction-compose.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { sceneFixture, PLATE_WORDS } from './scene-fixture.ts';
import { directionCommand } from './clock.ts';

/** The producer records consumed bytes, including check.json which Create does not compare. */
export function composeRunFixture(dir: string, project: JsonObject, rigN: number, scene: JsonObject, scenePath = 'compose.scene.json'): JsonObject {
  const rig = objects(project.versions).find(v => v.n === rigN)!;
  const root = `${String((rig.review_package as JsonObject).from)}/`;
  const file = (path: string) => ({ path, sha256: directionHash(readFileSync(join(dir, path))) });
  return { spec: 'rig-compose-run/1', scene: file(scenePath),
    characters: objects(scene.characters).map(c => ({ id: c.id!, build: c.build!, files: [
      { path: 'check/check.json', sha256: directionHash(Buffer.from('synthetic consumed check')) },
      ...objects(rig.outputs).filter(row => typeof row.path === 'string' && row.path.startsWith(root)
        && (['parts.json', 'rig/rig.json', 'rig/motion.json'].includes(row.path.slice(root.length)) || row.path.slice(root.length).startsWith('rig/images/')))
        .map(row => ({ path: String(row.path).slice(root.length), sha256: row.sha256! })),
    ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) })),
    plate: null, plates: objects(scene.plates).map(p => ({ name: p.name!, ...file(String(p.image)) })) };
}

export function composeFixture(placement?: { offset: [number, number]; scale?: number; rigSize: [number, number]; shift: [number, number] }, emptyTracks = false) {
  const f = sceneFixture();
  f.dir = realpathSync(f.dir);
  const put = (path: string, value: JsonObject | string | Buffer): JsonObject => {
    const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`;
    mkdirSync(dirname(join(f.dir, path)), { recursive: true }); writeFileSync(join(f.dir, path), bytes);
    return { path, sha256: directionHash(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) };
  };
  const plates: JsonObject[] = [
    { name: 'back', image: 'background.png', at: [0, 0], opaque_backdrop: true },
    { name: 'front', image: 'foreground.png', at: [2, 3] },
  ];
  const character = placement ? { offset: placement.offset, ...(placement.scale === undefined ? {} : { scale: placement.scale }) } : { offset: [0, 0], scale: 1 };
  const value = { canvas: { width: 64, height: 48 }, plates, order: ['back', 'actor', 'front'], character,
  idle_tracks: emptyTracks ? [] : [
    { bone: 'back', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 2, v: [3, 0] }, { t: 4, v: [0, 0] }] },
    { bone: 'actor:yaw_dial', property: 'rotate', keys: [{ t: 0, v: [-6] }, { t: 2, v: [6] }, { t: 4, v: [-6] }] },
  ] };
  const project = f.load();
  const rig = objects(project.versions)[0]!;
  const pkg = rig.review_package as JsonObject;
  pkg.from = 'outputs/v1/out';
  const frozen = [
    put('outputs/v1/out/parts.json', { synthetic: 'parts' }),
    put('outputs/v1/out/rig/rig.json', { synthetic: 'rig' }),
    put('outputs/v1/out/rig/motion.json', { synthetic: 'motion' }),
    put('outputs/v1/out/rig/images/body.png', 'synthetic encoded image'),
    put('outputs/v1/out/rig/images/depth.png', 'synthetic encoded depth image'),
  ];
  rig.outputs = frozen;
  pkg.files = [...objects(pkg.files), ...frozen.map(row => ({ path: String(row.path).replace('outputs/v1/', ''), sha256: row.sha256! }))];
  const signoff = objects(project.signoffs).find(s => s.stage === 'rig-review')!;
  ((signoff.target as JsonObject).review_package as JsonObject).sha256 = reviewPackageHash(pkg);
  const items = ((project.interview as JsonObject).post as JsonObject).items as JsonObject[];
  const composition = items.find(i => i.id === 'post_composition')!.guide as JsonObject;
  const choice = composition.choice as JsonObject;
  const setBinding = choice.set as JsonObject;
  const set = JSON.parse(readFileSync(join(f.dir, String(setBinding.path)), 'utf8')) as JsonObject;
  objects(objects(set.asks)[0]!.options).find(o => o.id === 'keep')!.fragment = { compose: value };
  choice.set = put(String(setBinding.path), set);
  composition.value = { compose: value };
  const timing = items.find(i => i.id === 'post_timing')!.guide as JsonObject;
  timing.value = { seconds: 4, loop: true, beats: [] };
  f.save(project);
  const scene: JsonObject = { spec: 'spine-parts-scene/1', canvas: value.canvas, plates: value.plates.map(p => ({ ...p, provenance: 'generated' })),
    characters: [{ id: 'actor', build: 'producer-build', ...value.character }], order: value.order,
    animations: { idle: { duration: 4, tracks: value.idle_tracks } } };
  const report: JsonObject = { spec: 'spine-parts-scene-report/1', scene: 'compose.scene.json', canvas: value.canvas,
    characters: [{ id: 'actor', build: 'producer-build', ...value.character, rig_size: placement?.rigSize ?? [64, 48], shift: placement?.shift ?? [0, 0] }],
    plates: value.plates.map((p, i) => ({ ...p, sha256: (i ? f.foreground : f.background).sha256! })) };
  const model: JsonObject = { spec: 'rigc-compiled/3', stage: { x: -32, y: 0, width: 64, height: 48 }, animations: [{ name: 'idle', duration: 4 }], pages: [] };
  put('compose.scene.json', scene); put('compose-out/scene.json', report);
  put('compose-out/check/check.json', { PASS: true, gate_spine_html_green: true });
  const run = composeRunFixture(f.dir, project, 1, scene);
  put('compose-out/compose-run.json', run);
  put('compose-out/check/build/skeleton.model.json', model);
  put('compose-out/check/build/skeleton.atlas', 'synthetic atlas');
  put('compose-out/check/build/page.png', 'synthetic page');
  const n = 2; const root = composeRoot(n);
  const placeholder = (path: string) => ({ path, sha256: '0'.repeat(64) });
  const doc: JsonObject = { schema: DIRECTION_COMPOSE_SPEC, rig: { version: 1 },
    compose: { scene: placeholder(composeScenePath(n)), out: root, report: placeholder(`${root}/scene.json`), check: placeholder(`${root}/check/check.json`), run: placeholder(`${root}/compose-run.json`) },
    model: placeholder(`${root}/check/build/skeleton.model.json`), take: { duration: 4, loop: true },
    citations: { ...(f.doc.citations as JsonObject), composition: { guide: 'post_composition', asks: ['post_composition'], quote: PLATE_WORDS } } };
  const publish = (hooks?: Parameters<typeof directionCommand>[1]) => {
    put('evidence/compose-direction.json', doc);
    return directionCommand(['write', '2', f.dir, '--file', 'evidence/compose-direction.json', '--rig', '1', '--compose-out', 'compose-out', '--compose-scene', 'compose.scene.json'], hooks);
  };
  return { ...f, doc, value, scene, report, model, run, put, publish };
}
