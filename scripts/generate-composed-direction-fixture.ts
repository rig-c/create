/** Seal authored composed-direction inputs under templates/example-composed-*. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { encodePng } from '@rig-c/core/plate';

const repo = realpathSync(join(import.meta.dir, '..'));
const fixtures = {
  default: join(repo, 'templates/example-composed-direction'),
  clip: join(repo, 'templates/example-composed-clip'),
} as const;
export type ComposedVariant = keyof typeof fixtures;
const build = 'evidence/compose-character';
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function inputBytes(variant: ComposedVariant = 'default'): Map<string, Buffer> {
  const clip = variant === 'clip';
  const inputs = new Map<string, Buffer>();
  const json = (path: string, data: unknown): void => { inputs.set(path, jsonBytes(data)); };
  const size = 128;
  const painting = new Uint8Array(size * size * 4);
  const blocks = [
    { name: 'background', tag: 'author:background', x: 0, y: 0, w: 128, h: 128, rgb: [32, 48, 64] },
    { name: 'torso', tag: 'topwear', x: 40, y: 56, w: 48, h: 64, rgb: [64, 144, 192] },
    { name: 'lantern', tag: 'author:lantern', x: 96, y: 72, w: 16, h: 24, rgb: [240, 176, 64] },
    { name: 'face', tag: 'face', x: 44, y: 16, w: 40, h: 32, rgb: [224, 176, 144] },
    { name: 'eye_r', tag: 'eyewhite-r', x: 50, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
    { name: 'eye_l', tag: 'eyewhite-l', x: 70, y: 28, w: 8, h: 8, rgb: [240, 240, 240] },
  ];
  const layers = blocks.map(({ name, tag, x, y, w, h, rgb }) => {
    const rgba = new Uint8Array(w * h * 4);
    const colour = [...rgb, 255];
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      rgba.set(colour, (row * w + col) * 4);
      painting.set(colour, ((row + y) * size + col + x) * 4);
    }
    const filename = `${name}.png`;
    inputs.set(`source/layers/${filename}`, Buffer.from(encodePng(w, h, rgba)));
    return { name: tag, filename, left: x, top: y, right: x + w, bottom: y + h, depth_median: null };
  });
  inputs.set('source/painting.png', Buffer.from(encodePng(size, size, painting)));
  json('source/layers/layers.json', { width: size, height: size, layers });
  const seethrough = { resolution: size, steps: 1, seed: 0, offload: false };
  const assemble = { rig_scale: 1, plan: blocks.map(({ name, tag }) => [name, 'full', tag]) };
  json('source/config.json', { key: 'synthetic-interview-parts', seethrough, assemble });
  json('rig/config.json', { key: 'synthetic', seethrough, assemble, requirements: 'interview-requirements.json',
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }, { name: 'body_yaw_dial', parent: 'root', at: [0, 0] }],
    meshes: { torso: { grid: 16, r: 16, segments: [['body', [64, 8], [64, 72]]] } },
    regions: Object.fromEntries(blocks.filter(block => block.name !== 'torso').map(block => [block.name, 'body'])),
    constraints: [{ name: 'body_turn', type: 'slider', bone: 'body_yaw_dial', animation: 'body_turn', property: 'rotate',
      local: true, loop: false, from: -12, max: 12, to: 0, scale: 0.125 }],
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: 0.9, period: 4, phase: 0, base: 0 }],
      animations_from: 'animations.json' } });
  json('rig/animations.json', { spec: 'rigc-motion/1', animations: { body_turn: { duration: 3,
    tracks: [{ bone: 'body', property: 'rotate', keys: [{ t: 0, v: [-3] }, { t: 1.5, v: [0] }, { t: 3, v: [3] }] }] } } });
  const requirements = { spec: 'spine-parts-requirements/1', fps: 12, requirements: [] };
  json('rig/interview-requirements.json', { ...requirements, setup_painting: { required: true } });
  json('rig/rig-check-requirements.json', { ...requirements, setup_painting: { required: true, rgb_tolerance: 40,
    regions: [{ name: 'whole-painting', box: [0, 0, size, size], max_pixels: 0 }] } });

  inputs.set('plates/background.png', inputs.get('source/layers/background.png')!);
  const rgba = new Uint8Array(20 * 20 * 4);
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    if (Math.abs(x - 9.5) + Math.abs(y - 9.5) < 9) rgba.set([235, 167, 79, 255], (y * 20 + x) * 4);
  }
  inputs.set('plates/foreground.png', Buffer.from(encodePng(20, 20, rgba)));
  const take = { duration: 4, loop: true };
  const compose = {
    canvas: { width: clip ? 96 : size, height: size },
    plates: [{ name: 'backdrop', image: 'inputs/background.png', at: [0, 0], opaque_backdrop: true },
      { name: 'foreground', image: 'inputs/foreground.png', at: [14, 88] }],
    order: ['backdrop', 'actor', 'foreground'],
    character: { offset: clip ? [-16, 0] : [0, 0] },
    idle_tracks: [{ bone: 'foreground', property: 'translate', keys: [{ t: 0, v: [0, 0] }, { t: 2, v: [3, 0] }, { t: 4, v: [0, 0] }] }],
  };
  json('post-composition.json', { compose });
  json('scene.json', { spec: 'spine-parts-scene/1', canvas: compose.canvas,
    plates: compose.plates.map(plate => ({ ...plate, provenance: 'generated' })), order: compose.order,
    characters: [{ id: 'actor', build, ...compose.character, ...(clip ? { canvas_clip: true } : {}) }],
    animations: { idle: { duration: take.duration, tracks: compose.idle_tracks } } });
  json('direction-intent.json', { rig: { version: 1 }, take,
    guides: { camera: 'camera_depth', timing: 'post_timing', composition: 'post_composition' } });
  inputs.set('approval/plan.txt', Buffer.from('Approve the plan for this synthetic figure.\n'));
  inputs.set('approval/parts.txt', Buffer.from('Approve the synthetic parts.\n'));
  inputs.set('approval/rig.txt', Buffer.from('Approve the synthetic rig in its setup pose.\n'));
  return inputs;
}

function files(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return files(root, path);
    if (!entry.isFile()) throw Error(`${path}: expected a regular file`);
    return [path];
  }).sort();
}

function put(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** Check the inventory and return the same bytes the producer will consume. */
export function checkInputFiles(root: string, variant: ComposedVariant = 'default'): Map<string, Buffer> {
  const expected = inputBytes(variant);
  const retained = new Map(files(root).map(path => [path, readFileSync(join(root, path))]));
  const differences = [...new Set([...expected.keys(), ...retained.keys()])].sort().flatMap(path => {
    const actual = retained.get(path);
    const generated = expected.get(path);
    if (generated === undefined) return [`extra ${path}`];
    if (actual === undefined) return [`missing ${path}`];
    return actual.equals(generated) ? [] : [`changed ${path}`];
  });
  if (differences.length) throw Error(`COMPOSED_INPUT_MISMATCH\n${differences.join('\n')}`);
  return retained;
}

function checkFixture(variant: ComposedVariant = 'default'): Map<string, Buffer> {
  const fixture = fixtures[variant];
  const expected = new Set(['README.md', 'inputs']);
  for (const entry of readdirSync(fixture, { withFileTypes: true })) {
    if (!expected.delete(entry.name) || (entry.name === 'inputs' ? !entry.isDirectory() : !entry.isFile())) {
      throw Error(`COMPOSED_INPUT_MISMATCH: unexpected fixture entry ${entry.name}`);
    }
  }
  if (expected.size) throw Error(`COMPOSED_INPUT_MISMATCH: missing fixture entries ${[...expected].join(', ')}`);
  return checkInputFiles(join(fixture, 'inputs'), variant);
}

function existingPath(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function physicalPath(path: string): string {
  return existingPath(path) ? realpathSync(path) : join(physicalPath(dirname(path)), basename(path));
}

if (import.meta.main) {
  const raw = process.argv.slice(2);
  let variant: ComposedVariant = 'default';
  let bad: string | undefined;
  const positional: string[] = [];
  for (const arg of raw) {
    if (arg === '--clip') {
      if (variant === 'clip') { bad ??= arg; break; }
      variant = 'clip';
    } else positional.push(arg);
  }
  const [mode, ...extra] = positional;
  bad ??= !mode ? '(missing destination)' : !['--check', '--write-inputs'].includes(mode) ? mode : extra[0];
  if (bad !== undefined) {
    const error = new Error(`${basename(import.meta.path)}: invalid argument ${JSON.stringify(bad)}.\n`
      + 'usage: generate-composed-direction-fixture.ts [--clip] (--check | --write-inputs)');
    error.name = 'GENERATOR_ARGS_INVALID';
    throw error;
  }
  const label = variant === 'clip' ? 'Clipped composed direction inputs' : 'Composed direction inputs';
  if (mode === '--check') console.log(`${label}: ${checkFixture(variant).size} files match byte for byte`);
  else {
    const root = join(fixtures[variant], 'inputs');
    if (physicalPath(root) !== root) throw Error('COMPOSED_INPUT_MISMATCH: input directory resolves through a symlink');
    if (existsSync(root)) files(root);
    for (const [path, bytes] of inputBytes(variant)) put(join(root, path), bytes);
    console.log(`${label}: wrote ${checkFixture(variant).size} files`);
  }
}
