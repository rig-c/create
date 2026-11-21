/**
 * #681: one record walks seethrough and assemble to done and advances into parts-review by running
 * only the commands `next` prints, with no refused command in between.
 */
import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { nextProject } from '../src/next.ts';
import type { JsonObject } from '../src/templates.ts';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { checkProject, testClock } from './clock.ts';
import { arr, obj } from './fixtures.ts';
import { tempDir } from './helpers.ts';

const CHAIN = join(import.meta.dir, '../templates/example-chain');
const NOW = EXAMPLE_NOW;

afterEach(() => testClock.reset());

function run(argv: string[]): { code: number; stderr: string } {
  let stderr = '';
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try { return { code: main(argv, NOW), stderr }; } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Split a printed command the way a shell would for the quoting `next` uses. */
function words(command: string): string[] {
  const out: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) { if (char === quote) quote = ''; else word += char; started = true; }
    else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\') { word += command[++i]!; started = true; }
    else if (/\s/.test(char)) { if (started) { out.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (started) out.push(word);
  return out;
}

test('#681 seethrough and assemble walk to done and advance into parts-review with no refused command', () => {
  const dir = join(tempDir(), 'parts-walk');
  cpSync(join(CHAIN, 'checkpoints/1-parts-verdict'), dir, { recursive: true });
  // The walk starts with both parts steps pending and no parts-stage report or diff evidence.
  const file = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  for (const raw of arr(obj(project.plan).steps)) {
    const step = obj(raw);
    if (step.id !== 'seethrough' && step.id !== 'assemble') continue;
    step.status = 'pending';
    delete step.status_history;
  }
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);
  for (const path of ['evidence/parts-check.json', 'evidence/diff-components.json', 'evidence/diff-triage.json']) rmSync(join(dir, path), { force: true });

  const bin = join(createRequire(import.meta.url).resolve('@rig-c/parts/package.json'), '..', 'cli.ts');
  const ran: { command: string; exit: number }[] = [];
  for (let turn = 0; turn < 20; turn++) {
    const next = nextProject(dir, NOW);
    expect(next.refusals).toEqual([]);
    if (next.stage === 'parts-review') break;
    const move = next.moves.find(m => m.command !== null && (m.role === 'agent' || m.role === 'producer'));
    expect({ turn, moves: next.moves, move }).toMatchObject({ move: expect.anything() });
    const argv = words(move!.command!);
    let exit: number;
    if (argv[0] === 'rig-parts') {
      if (argv[1] === 'check-parts') expect(argv[argv.indexOf('--out') + 1]).toBe(join(dir, 'evidence'));
      const result = Bun.spawnSync([process.execPath, bin, ...argv.slice(1)], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
      exit = result.exitCode;
      expect({ command: move!.command, exit, stderr: result.stderr.toString() }).toMatchObject({ exit: 0 });
    } else {
      expect(argv[0]).toBe('rig-create');
      const result = run(argv.slice(1));
      exit = result.code;
      expect({ command: move!.command, exit, stderr: result.stderr }).toEqual({ command: move!.command, exit: 0, stderr: '' });
    }
    ran.push({ command: move!.command!, exit });
  }

  const after = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  expect(after.stage).toBe('parts-review');
  expect(ran.every(r => r.exit === 0)).toBe(true);
  const stepped = ran.map(r => words(r.command)).filter(w => w[1] === 'step-status').map(w => `${w[2]} ${w[3]}`);
  expect(stepped).toEqual(expect.arrayContaining(['seethrough in-progress', 'seethrough done', 'assemble in-progress', 'assemble at-checkpoint', 'assemble done']));
  expect(stepped).not.toContain('seethrough at-checkpoint');
  expect(ran.some(r => r.command.startsWith('rig-parts check-parts'))).toBe(true);
  expect(existsSync(join(dir, 'evidence/parts-check.json'))).toBe(true);
  expect(obj(arr(after.advances).at(-1)).parts_check).toMatchObject({ path: 'evidence/parts-check.json' });
  expect(checkProject(dir).refusals).toEqual([]);
});
