/** Synthetic authoring fixtures. Plates are registered through input add. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { directionHash, objects } from '../src/direction.ts';
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
  const args = (foreground = false) => ['write', '--rig', '1', '--background', 'background.png', ...(foreground ? ['--foreground', 'foreground.png'] : []), '--citations-file', foreground ? 'citations.json' : 'background-citation.json', '--by', 'user', dir];
  const writeScene = (foreground = false) => sceneCommand(args(foreground));
  return { ...f, dir, model, modelPath, modelBinding, background, foreground, write, args, writeScene };
}
