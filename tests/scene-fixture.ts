/** Synthetic authoring fixtures. Plates are registered through input add. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHOICE_SPEC, OPTIONS_SPEC } from '../src/choices.ts';
import { directionHash, objects } from '../src/direction.ts';
import { plateRegistration, pngDimensions, scenePath, sceneRig } from '../src/scene.ts';
import { reviewPackageHash } from '../src/signoff-target.ts';
import type { JsonObject } from '../src/templates.ts';
import { directionFixture } from './direction-fixture.ts';
import { tempDir } from './helpers.ts';
import { inputCommand, sceneCommand, testClock } from './clock.ts';

export const PLATE_WORDS = 'Place the background behind the rig and the foreground in front.';
export function sceneFixture() {
  const dir = join(tempDir(), 'project');
  const f = directionFixture(dir);
  const modelPath = 'derived/review/v1/out/check/build/skeleton.model.json';
  const model = { spec: 'rigc-compiled/3', stage: { x: -64, y: 5, width: 128, height: 128 }, animations: [{ name: 'idle' }], pages: [] };
  const write = (path: string, bytes: string | Buffer): JsonObject => {
    writeFileSync(join(dir, path), bytes);
    return { path, sha256: directionHash(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) };
  };
  const modelBinding = write(modelPath, JSON.stringify(model));
  const png = readFileSync(join(import.meta.dir, '../templates/example-chain/inputs/painting.png'));
  const background = write('background.png', png);
  // Distinct raw-byte identity without changing the producer's IHDR dimensions.
  const foreground = write('foreground.png', Buffer.concat([png, Buffer.from('\n')]));
  const citation = { guide: 'post_composition', asks: ['post_composition'], quote: PLATE_WORDS };
  write('citations.json', JSON.stringify({ background: citation, foreground: citation }));
  write('background-citation.json', JSON.stringify({ background: citation }));
  testClock.set('2026-11-07T10:00:00Z');
  // The direction fixture predates inputs[]; start an empty list for the writer.
  f.save({ ...f.load(), inputs: [] });
  for (const path of [background.path, foreground.path]) inputCommand(['add', String(path), dir, '--origin', 'synthetic plate']);
  const p = f.load();
  const rig = objects(p.versions)[0]!;
  const pkg = rig.review_package as JsonObject;
  (pkg.files as JsonObject[])[0]!.sha256 = modelBinding.sha256!;
  const signoff = objects(p.signoffs).find(value => value.stage === 'rig-review')!;
  signoff.target = { version: 1, verdict: 'versions[0].verdicts[0]', review_package: { path: 'versions[0].review_package', sha256: reviewPackageHash(pkg) } };
  const post = (p.interview as JsonObject).post as JsonObject;
  (post.items as JsonObject[]).push({ id: 'post_composition', config: [], text: 'Choose the composition.', guide: { delegated: false, by: 'user', at: '2026-11-04T08:00:00Z', verbatim: PLATE_WORDS, value: 'plates', asks: [{ id: 'post_composition', state: 'user' }] } });
  f.save(p);
  let serial = 0;
  const designate = (hasForeground: boolean, rect = model.stage, backgroundPath = background.path!): void => {
    const p = f.load();
    const item = (((p.interview as JsonObject).post as JsonObject).items as JsonObject[]).find(i => i.id === 'post_composition')!;
    const old = item.guide as JsonObject;
    const value = { scene: { background: { path: backgroundPath, rect }, ...(hasForeground ? { foreground: { path: foreground.path!, rect } } : {}) } };
    const path = `evidence/scene-choice-${++serial}.json`;
    const shown = { label: PLATE_WORDS, effect: 'Use the recorded scene placement.' };
    const set = { schema: OPTIONS_SPEC, id: `scene-${serial}`, question: 'post_composition', stage: 'post-interview', drafted_by: 'agent', drafted_at: testClock.iso(), context: { kind: 'rig', rig_version: 1, signoff_at: signoff.at!, config: modelBinding, parts: { path: 'parts', files: [background, foreground] } }, assembly: { rule: 'single' }, asks: [{ id: 'post_composition', prompt: 'Choose composition', options: [{ id: 'keep', kind: 'value', ...shown, fragment: value, recommended: true, reason: 'Synthetic layout' }, { id: 'alternative', kind: 'value', ...shown, fragment: value, recommended: false }, { id: 'other', kind: 'other', ...shown, recommended: false }, { id: 'auto', kind: 'auto', ...shown, recommended: false }] }] };
    const binding = write(path, JSON.stringify(set));
    if (old.choice && (p.scenes as JsonObject[] | undefined)?.length) item.history = [...(item.history as JsonObject[] ?? []), old];
    item.guide = { ...old, at: testClock.iso(), value, verbatim: `${shown.label}\n${shown.effect}`, choice: { spec: CHOICE_SPEC, set: binding, picks: [{ ask: 'post_composition', option_id: 'keep', shown }] } };
    f.save(p);
  };
  designate(false);
  const args = (hasForeground = false) => ['write', '--rig', '1', '--background', 'background.png', ...(hasForeground ? ['--foreground', 'foreground.png'] : []), '--citations-file', hasForeground ? 'citations.json' : 'background-citation.json', dir];
  const writeScene = (foreground = false) => { if (foreground) designate(true); return sceneCommand(args(foreground)); };
  const seedHistoricalScene = (rect = model.stage): void => {
    const p = f.load();
    const binding = sceneRig(dir, p, 1);
    const n = (p.scenes as JsonObject[] | undefined)?.length ?? 0;
    const doc = { schema: 'rig-create/scene@1', n: n + 1, rig: binding.rig, frame: { space: 'rig-world-y-up', stage: model.stage }, plates: [{ role: 'background', ...background, ...pngDimensions(png, 'background.png'), rect, registered: plateRegistration(p, background), citation }], layers: ['background', 'rig'] };
    mkdirSync(join(dir, 'evidence/scene'), { recursive: true });
    const file = write(scenePath(n + 1), JSON.stringify(doc));
    p.scenes = [...(p.scenes as JsonObject[] ?? []), { n: n + 1, ...file, at: testClock.iso(), by: 'user' }];
    f.save(p);
  };
  return { ...f, dir, model, modelPath, modelBinding, background, foreground, write, args, writeScene, seedHistoricalScene, designateScene: (rect: typeof model.stage, path?: string) => designate(false, rect, path) };
}
