/** Geometric public probe. Model bytes are exclusively the installed rigc build's output. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodePngBytes } from '../node_modules/@rig-c/parts/src/raster/png.ts';

export function buildDirectionProbe(dir: string): {model: Buffer; config: Buffer; still: Buffer} {
  mkdirSync(join(dir, 'evidence/images'), {recursive: true});
  const pixels = new Uint8ClampedArray(8 * 16 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([64, 144, 192, 255], i);
  const still = Buffer.from(encodePngBytes({width: 8, height: 16, data: pixels}));
  writeFileSync(join(dir, 'evidence/images/rectangle.png'), still);
  // core 3.2.1 src/rig.ts RigSliderConstraint; compiled by src/model.ts.
  const rig = {spec: 'rigc-rig/1', name: 'direction-probe', images: 'images',
    skeleton: {x: -4, y: 0, width: 8, height: 16},
    bones: [{name: 'root'}, {name: 'body', parent: 'root', y: 8}, {name: 'yaw_dial', parent: 'root'}],
    slots: [{name: 'rectangle', bone: 'body', attachment: 'rectangle'}],
    skins: {default: {rectangle: {rectangle: {image: 'rectangle.png'}}}},
    constraints: [{type: 'slider', name: 'yaw', bone: 'yaw_dial', property: 'rotate', animation: 'turn', local: true, from: -30, to: 0, scale: 1 / 60, loop: false}]};
  const config = Buffer.from(`${JSON.stringify(rig, null, 2)}\n`);
  writeFileSync(join(dir, 'evidence/rig-config.json'), config);
  writeFileSync(join(dir, 'evidence/motion.json'), `${JSON.stringify({spec: 'rigc-motion/1', archetype: 'direction-probe', cut: 'probe', easings: {}, groups: {}, animations: {turn: {duration: 1, loop: false, tracks: [{bone: 'body', property: 'rotate', keys: [{t: 0, v: [-10]}, {t: 1, v: [10]}]}]}}}, null, 2)}\n`);
  // The binary is installed by parts' declared core dependency; no phantom core import.
  const run = spawnSync(process.execPath, [resolve(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'), 'build', '--rig', 'evidence/rig-config.json', '--motion', 'evidence/motion.json', '--out', 'derived/review/v1/out/check/build', '--copy-images'], {cwd: dir, encoding: 'utf8', timeout: 60_000});
  if (run.status !== 0) throw Error(`probe rigc build failed (${run.status}): ${run.stdout}\n${run.stderr}`);
  return {model: readFileSync(join(dir, 'derived/review/v1/out/check/build/skeleton.model.json')), config, still};
}
