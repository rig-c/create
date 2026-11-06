/** Retain only the public reopen writer's output; assets use the plain example materializer. */
import { setSystemTime } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { reopenCommand } from '../src/reopen.ts';
import { materializeFixture } from '../tests/fixtures.ts';
import { EXAMPLE_REOPEN_AT } from './example-time.ts';

export function generateExampleReopened(dir: string): Buffer {
  if (existsSync(dir)) throw new Error('reopened example needs a fresh project directory');
  materializeFixture(dir);
  const words = join(dir, 'reopen-words.txt');
  writeFileSync(words, 'Reopen the synthetic parts for correction.\n');
  try {
    setSystemTime(new Date(EXAMPLE_REOPEN_AT));
    reopenCommand(['parts-review', dir, '--by', 'user', '--verbatim-file', words]);
    return readFileSync(join(dir, 'project.json'));
  } finally {
    setSystemTime();
  }
}

export function writeExampleReopened(dir: string, check: boolean): void {
  const bytes = generateExampleReopened(dir);
  const file = join(import.meta.dir, '../templates/example-reopened/project.json');
  if (check) {
    if (!readFileSync(file).equals(bytes)) throw new Error('reopened example differs from writer output');
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

if (import.meta.main) {
  const [destination, flag] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check')) throw new Error('usage: generate-example-reopened.ts <fresh dir> [--check]');
  writeExampleReopened(resolve(destination), flag === '--check');
  console.log('reopened example reproduces through the public reopen writer');
}
