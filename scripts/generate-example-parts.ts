/** A public geometric plate, assembled by the installed producer without image repairs. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const load = createRequire(import.meta.url);
const { encodePng } = load('@rig-c/core/plate') as {
  encodePng: (width: number, height: number, rgba: Uint8Array) => Uint8Array;
};

export function generateExampleParts(dir: string): Record<string, Buffer> {
  mkdirSync(join(dir, 'layers'), { recursive: true });
  const size = 128;
  const plate = new Uint8Array(size * size * 4);
  const blocks = [
    { name: 'background', tag: 'author:background', x: 0, y: 0, w: 128, h: 128, rgb: [32, 48, 64] },
    { name: 'torso', tag: 'topwear', x: 40, y: 56, w: 48, h: 64, rgb: [64, 144, 192] },
    { name: 'lantern', tag: 'author:lantern', x: 96, y: 72, w: 16, h: 24, rgb: [240, 176, 64] },
    { name: 'face', tag: 'face', x: 44, y: 16, w: 40, h: 32, rgb: [224, 176, 144] },
    { name: 'eye_r', tag: 'eyewhite-r', x: 50, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
    { name: 'eye_l', tag: 'eyewhite-l', x: 70, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
  ];
  const layers = blocks.map(block => {
    const rgba = new Uint8Array(block.w * block.h * 4);
    for (let y = 0; y < block.h; y++) for (let x = 0; x < block.w; x++) {
      const colour = [...block.rgb, 255];
      rgba.set(colour, (y * block.w + x) * 4);
      plate.set(colour, ((y + block.y) * size + x + block.x) * 4);
    }
    const filename = `${block.name}.png`;
    writeFileSync(join(dir, 'layers', filename), encodePng(block.w, block.h, rgba));
    return { name: block.tag, filename, left: block.x, top: block.y, right: block.x + block.w, bottom: block.y + block.h, depth_median: null };
  });
  writeFileSync(join(dir, 'layers/layers.json'), JSON.stringify({ width: size, height: size, layers }));
  writeFileSync(join(dir, 'painting.png'), encodePng(size, size, plate));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    key: 'synthetic-interview-parts', seethrough: { resolution: size, steps: 1, seed: 0, offload: false },
    assemble: { rig_scale: 1, plan: blocks.map(block => [block.name, 'full', block.tag]) },
  }));
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'assemble', '--source', 'painting.png', '--full', 'layers', '--config', 'config.json', '--out', 'assembled'],
  { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`assemble exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  const root = join(dir, 'assembled/rig');
  const files: Record<string, Buffer> = { 'parts.json': readFileSync(join(root, 'parts.json')) };
  for (const file of readdirSync(join(root, 'parts'))) files[`parts/${file}`] = readFileSync(join(root, 'parts', file));
  return files;
}

if (import.meta.main) {
  const [destination, flag] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check')) throw new Error('usage: generate-example-parts.ts <fresh dir> [--check]');
  const files = generateExampleParts(resolve(destination));
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(import.meta.dir, '../templates/example-draft/input', path);
    if (flag === '--check') {
      if (!readFileSync(file).equals(bytes)) throw new Error(`${path}: producer fixture differs`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
}
