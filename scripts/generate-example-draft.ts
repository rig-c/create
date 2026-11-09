import { generatorArgs } from './generator-args.ts';
/** Build the synthetic draft with the installed CPU producer, retaining every output byte. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { EXAMPLE_SOURCE_DATE_EPOCH } from './example-time.ts';
import { generateExampleParts } from './generate-example-parts.ts';

/**
 * The synthetic drafts' one breath track: `body` translatey, period 4, amplitude in rig px.
 * Chosen by running @rig-c/parts 2.36.0 `check` on both drafts below (identical figures on each),
 * against BREATH_VISIBLE's torso_floor 3.809, as the smallest amplitude passing with a margin of at
 * least 5 % of the floor:
 *
 * | amp | torso_heat_mean | torso_floor | BREATH_VISIBLE | margin           |
 * | --- | --------------- | ----------- | -------------- | ---------------- |
 * | 0.5 | 2.306           | 3.809       | FAIL           | -1.503 (-39.5 %) |
 * | 0.6 | 2.645           | 3.809       | FAIL           | -1.164 (-30.6 %) |
 * | 0.7 | 3.267           | 3.809       | FAIL           | -0.542 (-14.2 %) |
 * | 0.8 | 3.948           | 3.809       | PASS           | +0.139 (+3.6 %)  |
 * | 0.9 | 4.259           | 3.809       | PASS           | +0.450 (+11.8 %) |
 * | 1.0 | 4.912           | 3.809       | PASS           | +1.103 (+29.0 %) |
 */
export const EXAMPLE_BREATH_AMP = 0.9;


export function generateExampleDraft(dir: string, parts: Record<string, Uint8Array>): Record<string, Buffer> {
  for (const [path, bytes] of Object.entries(parts)) {
    const file = join(dir, 'input', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const manifest = JSON.parse(Buffer.from(parts['parts.json']!).toString('utf8')) as {
    parts: { name: string; from: string }[];
  };
  const config = {
    key: 'synthetic',
    requirements: 'interview-requirements.json',
    assemble: { rig_scale: 1, plan: manifest.parts.map(part => [part.name, part.from.slice(0, part.from.indexOf(':')), part.from.slice(part.from.indexOf(':') + 1)]) },
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }],
    meshes: {},
    regions: Object.fromEntries(manifest.parts.map(part => [part.name, 'body'])),
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: EXAMPLE_BREATH_AMP, period: 4, phase: 0, base: 0 }] },
  };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(dir, 'interview-requirements.json'), `${JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true } }, null, 2)}\n`);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out'],
  { cwd: dir, env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH }, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`rig exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  // This is check's installed compiler step, retaining its model without running diagnostic renders.
  const compiled = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'),
    'build', '--rig', 'out/rig.json', '--motion', 'out/motion.json', '--out', 'out/check/build',
    '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon'],
  { cwd: dir, env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH }, stdout: 'pipe', stderr: 'pipe' });
  if (compiled.exitCode !== 0) throw new Error(`rigc build exit ${compiled.exitCode}\n${compiled.stdout}\n${compiled.stderr}`);
  const files: Record<string, Buffer> = { 'config.json': readFileSync(join(dir, 'config.json')), 'interview-requirements.json': readFileSync(join(dir, 'interview-requirements.json')) };
  const collect = (path: string): void => {
    for (const entry of readdirSync(join(dir, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) collect(child);
      else files[child] = readFileSync(join(dir, child));
    }
  };
  collect('out');
  return files;
}

/** Build a producer-made torso mesh on the same synthetic parts. */
export function generateExampleMeshDraft(dir: string, parts: Record<string, Uint8Array>): Record<string, Buffer> {
  for (const [path, bytes] of Object.entries(parts)) {
    const file = join(dir, 'input', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const manifest = JSON.parse(Buffer.from(parts['parts.json']!).toString('utf8')) as {
    parts: { name: string; from: string }[];
  };
  const config = {
    key: 'synthetic',
    requirements: 'interview-requirements.json',
    assemble: { rig_scale: 1, plan: manifest.parts.map(part => [part.name, part.from.slice(0, part.from.indexOf(':')), part.from.slice(part.from.indexOf(':') + 1)]) },
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }],
    meshes: { torso: { grid: 16, r: 16, segments: [['body', [64, 8], [64, 72]]] } },
    regions: Object.fromEntries(manifest.parts.filter(part => part.name !== 'torso').map(part => [part.name, 'body'])),
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: EXAMPLE_BREATH_AMP, period: 4, phase: 0, base: 0 }] },
  };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(dir, 'interview-requirements.json'), `${JSON.stringify({ spec: 'spine-parts-requirements/1', fps: 12, requirements: [], setup_painting: { required: true } }, null, 2)}\n`);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out'],
  { cwd: dir, env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH }, stdout: 'pipe', stderr: 'pipe', timeout: 600_000 });
  if (result.exitCode !== 0) throw new Error(`rig exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  // This is check's installed compiler step, retaining its model without running diagnostic renders.
  const compiled = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'),
    'build', '--rig', 'out/rig.json', '--motion', 'out/motion.json', '--out', 'out/check/build',
    '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon'],
  { cwd: dir, env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH }, stdout: 'pipe', stderr: 'pipe', timeout: 600_000 });
  if (compiled.exitCode !== 0) throw new Error(`rigc build exit ${compiled.exitCode}\n${compiled.stdout}\n${compiled.stderr}`);
  const files: Record<string, Buffer> = { 'config.json': readFileSync(join(dir, 'config.json')), 'interview-requirements.json': readFileSync(join(dir, 'interview-requirements.json')) };
  const collect = (path: string): void => {
    for (const entry of readdirSync(join(dir, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) collect(child);
      else files[child] = readFileSync(join(dir, child));
    }
  };
  collect('out');
  return files;
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: generate-example-draft.ts <fresh dir> [--check]');
  const dir = resolve(destination);
  const files = generateExampleDraft(join(dir, 'draft'), generateExampleParts(join(dir, 'producer')));
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(import.meta.dir, '../templates/example-draft', path);
    if (check) {
      if (!readFileSync(file).equals(bytes)) throw new Error(`${path}: producer draft differs`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
  if (check) console.log('example draft producer bytes reproduce byte for byte');
}
