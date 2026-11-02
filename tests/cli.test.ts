import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cli, gitEnv, tempDir } from './helpers.ts';

test('an unknown command is refused by name', () => {
  const result = cli(['rig'], tempDir(), gitEnv());
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('rig-create: UNKNOWN_COMMAND: no command named rig (see rig-create --help)\n');
});

test('--help lists init', () => {
  const result = cli(['--help'], tempDir(), gitEnv());
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('rig-create init <dir> [--no-install]');
});

test('--version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
  const result = cli(['--version'], tempDir(), gitEnv());
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${pkg.version}\n`);
});
