import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOUND_WRITE_HELP } from '../src/cli.ts';
import { PLAN_HELP } from '../src/plan-writers.ts';

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
  expect(result.stdout).toContain('rig-create job withdraw-act <actId> [<dir>] --by <owner> --owner-chat <file> --said-at <ISO> --relayed-by <operator>');
  expect(result.stdout).toContain(`job open:\n  --rig <n>      selects a registered rig OR post version; the flag name is shared\n  ${BOUND_WRITE_HELP}`);
  expect(result.stdout).toContain(`job reconcile:\n  ${BOUND_WRITE_HELP}`);
  expect(result.stdout).toContain(`bound writers:\n  ${BOUND_WRITE_HELP}`);
  expect(result.stdout).toContain('move to any stage and record advances[]; no sign-off is required');
  expect(result.stdout).not.toContain('authorized by a live signoff');
  expect(result.stdout).toContain(PLAN_HELP);
});

for (const args of [
  ['help'],
  ['--help'],
  ['add', '--help'],
  ['revise', '--help'],
  ['remove', '--help'],
  ['checkpoint-withdraw', '--help'],
  ['bar-amend', '--help'],
]) test(`plan ${args.join(' ')} prints the existing help without reading a project`, () => {
  const result = cli(['plan', ...args], tempDir(), gitEnv());
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${PLAN_HELP}\n`);
  expect(result.stderr).toBe('');
});

test('a bad plan option retains its refusal code and usage exit', () => {
  const result = cli(['plan', 'bar-amend', '--unknown'], tempDir(), gitEnv());
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('PLAN_OPTION_INVALID:');
});

test('--version prints the package version', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'));
  const result = cli(['--version'], tempDir(), gitEnv());
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${pkg.version}\n`);
});
