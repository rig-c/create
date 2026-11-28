import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { mock } from 'bun:test';
import type { JsonObject } from '../src/templates.ts';

const composeOutput = 'outputs/direction';

/** Reuse the worked example's playback and check bytes at the Parts process boundary. */
function replayCompose(scenePath: string, output: string): void {
  const read = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8')) as JsonObject;
  const write = (file: string, value: JsonObject) => fs.writeFileSync(join(output, file), `${JSON.stringify(value)}\n`);
  const sceneBytes = fs.readFileSync(scenePath);
  const scene = read(scenePath);
  const [character] = scene.characters as JsonObject[];
  const [plate] = scene.plates as JsonObject[];
  const run = read(join(composeOutput, 'compose-run.json'));
  const report = read(join(composeOutput, 'scene.json'));
  const [runCharacter] = run.characters as JsonObject[];
  const [reportCharacter] = report.characters as JsonObject[];
  const [runPlate] = run.plates as JsonObject[];
  const [reportPlate] = report.plates as JsonObject[];
  run.scene = { path: scenePath, sha256: createHash('sha256').update(sceneBytes).digest('hex') };
  runCharacter!.build = character!.build!;
  report.scene = scenePath;
  reportCharacter!.build = character!.build!;
  reportCharacter!.offset = character!.offset!;
  if (character!.canvas_clip === true) {
    runCharacter!.placement = { canvas_clip: true, bounds: [0, 0, 128, 128], clipped_bounds: [0, 0, 128, 128] };
    reportCharacter!.clipped_bounds = [0, 0, 128, 128];
  }
  runPlate!.path = plate!.image!;
  reportPlate!.image = plate!.image!;
  for (const path of ['check/build', 'check/check.json', 'rig/motion.json']) {
    const destination = join(output, path);
    fs.mkdirSync(dirname(destination), { recursive: true });
    fs.cpSync(join(composeOutput, path), destination, { recursive: true });
  }
  write('compose-run.json', run);
  write('scene.json', report);
}

const fixture = process.env.RIG_CREATE_CANDIDATE_REFUSAL_FIXTURE;
const root = process.cwd();
const storage = join(root, 'scratch/candidates');

if (fixture && basename(process.argv[1] ?? '') === 'candidate-runtime.ts') {
  const { plant, now } = JSON.parse(fs.readFileSync(join(fixture, 'request.json'), 'utf8')) as { plant: string; now: number };
  const trace = (event: string) => fs.appendFileSync(join(fixture, 'trace'), `${event}\n`);
  let firstRow: string | undefined;
  const flipTrailingByte = (row: string, rel: string) => {
    const file = join(row, rel);
    const bytes = fs.readFileSync(file);
    if (bytes.at(-1) !== 10) throw Error(`expected a trailing LF in ${rel}`);
    bytes[bytes.length - 1] = 32;
    fs.writeFileSync(file, bytes);
    trace(`planted one byte in ${rel}`);
  };
  Date.now = () => now;
  const { lstatSync, renameSync, statfsSync } = fs;
  mock.module('node:fs', () => ({
    ...fs,
    lstatSync: (path: string, options?: Parameters<typeof lstatSync>[1]) => {
      const stat = lstatSync(path, options);
      if (plant === 'cap' && path === join(storage, 'ballast') && stat) {
        Object.assign(stat, { blocks: 300 * 1024 ** 2 / 512 });
      }
      return stat;
    },
    statfsSync: (path: string, options?: Parameters<typeof statfsSync>[1]) => {
      if (path !== storage) return statfsSync(path, options);
      trace('disk floor sampled');
      // Fix the available space for every run, including the positive floor control.
      return { bsize: 4096n, bavail: plant === 'disk' ? 1n : 1024n ** 2n };
    },
    renameSync: (from: string, to: string) => {
      renameSync(from, to);
      if (basename(to) !== 'proof.json' || !to.startsWith(`${storage}/`)) return;
      trace('proof sealed');
      const row = dirname(to);
      if (firstRow) {
        if (plant === 'cache') {
          fs.cpSync(dirname(row), join(fixture, 'sealed-batch'), { recursive: true });
          flipTrailingByte(firstRow, 'producer/compose-run.json');
        }
        return;
      }
      firstRow = row;
      if (plant === 'race' || plant === 'race-digest') {
        const next = join(root, 'concurrent-project.json');
        fs.copyFileSync(join(fixture, 'concurrent-project.json'), next);
        renameSync(next, join(root, 'project.json'));
        trace('pending set replaced');
      }
      const files: Record<string, string> = {
        scene: 'camera-free.scene.json', run: 'producer/compose-run.json', playback: 'package/take.json',
      };
      const rel = files[plant];
      if (rel) flipTrailingByte(row, rel);
    },
  }));

  const spawn = Bun.spawn;
  Bun.spawn = ((...args: Parameters<typeof spawn>) => {
    const command: unknown = args[0];
    if (Array.isArray(command) && basename(String(command[1])) === 'cli.ts' && command[2] === 'compose') {
      trace('Parts compose');
      replayCompose(String(command[command.indexOf('--scene') + 1]), String(command[command.indexOf('--out') + 1]));
      return spawn([process.execPath, '-e', '0'], { stdout: 'pipe', stderr: 'inherit' });
    }
    return spawn(...args);
  }) as typeof spawn;

  const serve = Bun.serve;
  Bun.serve = ((...args: Parameters<typeof serve>) => {
    trace('Review listener opened');
    return serve(...args);
  }) as typeof serve;
}
