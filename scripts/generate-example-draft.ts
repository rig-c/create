/** Build the synthetic draft with the installed CPU producer, retaining every output byte. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateExampleParts } from './generate-example-parts.ts';

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
    assemble: { rig_scale: 1, plan: manifest.parts.map(part => [part.name, part.from.slice(0, part.from.indexOf(':')), part.from.slice(part.from.indexOf(':') + 1)]) },
    bones: [{ name: 'body', parent: 'root', at: [64, 64] }],
    meshes: {},
    regions: Object.fromEntries(manifest.parts.map(part => [part.name, 'body'])),
    motion: { duration: 4, tracks: [{ bone: 'body', prop: 'translatey', amp: 0.5, period: 4, phase: 0, base: 0 }] },
  };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out'],
  { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`rig exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  // This is check's installed compiler step, retaining its model without running diagnostic renders.
  const compiled = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/core/bin/rigc.cjs'),
    'build', '--rig', 'out/rig.json', '--motion', 'out/motion.json', '--out', 'out/check/build',
    '--profile', 'rig-play', '--pack', '--page-edges', 'free', '--pack-shape', 'polygon'],
  { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (compiled.exitCode !== 0) throw new Error(`rigc build exit ${compiled.exitCode}\n${compiled.stdout}\n${compiled.stderr}`);
  const files: Record<string, Buffer> = { 'config.json': readFileSync(join(dir, 'config.json')) };
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
  const [destination, flag] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check')) throw new Error('usage: generate-example-draft.ts <fresh dir> [--check]');
  const dir = resolve(destination);
  const files = generateExampleDraft(join(dir, 'draft'), generateExampleParts(join(dir, 'producer')));
  for (const [path, bytes] of Object.entries(files)) {
    const file = join(import.meta.dir, '../templates/example-draft', path);
    if (flag === '--check') {
      if (!readFileSync(file).equals(bytes)) throw new Error(`${path}: producer draft differs`);
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
  }
}
