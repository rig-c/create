/** Synthetic two-plate composed take; compiled idle intentionally has no loop field. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { directionHash, objects } from '../src/direction.ts';
import { DIRECTION_COMPOSE_SPEC, composeRoot, composeScenePath } from '../src/direction-compose.ts';
import type { JsonObject } from '../src/templates.ts';
import { sceneFixture, PLATE_WORDS } from './scene-fixture.ts';
import { directionCommand } from './clock.ts';

export function composeFixture() {
  const f = sceneFixture();
  f.dir = realpathSync(f.dir);
  const put = (path: string, value: JsonObject | string): JsonObject => {
    const bytes = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
    mkdirSync(dirname(join(f.dir, path)), { recursive: true }); writeFileSync(join(f.dir, path), bytes);
    return { path, sha256: directionHash(Buffer.from(bytes)) };
  };
  const value = { canvas: { width: 64, height: 48 }, plates: [
    { name: 'back', image: 'background.png', at: [0, 0], opaque_backdrop: true },
    { name: 'front', image: 'foreground.png', at: [2, 3] },
  ], order: ['back', 'actor', 'front'], character: { offset: [0, 0], scale: 1 },
  idle_tracks: [{ bone: 'back', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 2, v: [3, 0] }, { t: 4, v: [0, 0] }] }] };
  const project = f.load();
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
    characters: [{ id: 'actor', build: 'producer-build', ...value.character, shift: [0, 0] }],
    plates: value.plates.map((p, i) => ({ ...p, sha256: (i ? f.foreground : f.background).sha256! })) };
  const model: JsonObject = { spec: 'rigc-compiled/3', stage: { x: -32, y: 0, width: 64, height: 48 }, animations: [{ name: 'idle', duration: 4 }], pages: [] };
  put('compose.scene.json', scene); put('compose-out/scene.json', report);
  put('compose-out/check/check.json', { PASS: true, gate_spine_html_green: true });
  put('compose-out/compose-run.json', { spec: 'rig-compose-run/1' });
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
  return { ...f, doc, value, scene, report, model, put, publish };
}
