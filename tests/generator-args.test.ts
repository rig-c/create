import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generatorArgs } from '../scripts/generator-args.ts';

const scripts = readdirSync(resolve(import.meta.dir, '../scripts'))
  .filter(name => name.startsWith('generate-') && name.endsWith('.ts'));

describe.each(scripts)('%s argument refusals', script => {
  const composed = script === 'generate-composed-direction-fixture.ts';
  test.each([
    { args: composed ? ['output', '--check'] : ['--check'], bad: '--check' },
    ...(composed ? [
      { args: ['--clip'], bad: '(missing destination)' },
      { args: ['--clip', '--clip', '--check'], bad: '--clip' },
      { args: ['--clip', '--check', 'extra'], bad: 'extra' },
    ] : []),
    { args: ['--x'], bad: '--x' },
    { args: ['-check'], bad: '-check' },
    { args: ['output', '--unknown'], bad: '--unknown' },
    { args: composed ? ['--check', 'extra'] : ['output', '--check', 'extra'], bad: 'extra' },
    { args: [], bad: '(missing destination)' },
  ])('$args refuses before writing', ({ args, bad }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'generator-args-'));
    try {
      const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, '../scripts', script), ...args], { cwd });
      const stderr = result.stderr.toString();
      expect(result.exitCode).not.toBe(0);
      expect(stderr).toContain('GENERATOR_ARGS_INVALID');
      expect(stderr).toContain(script);
      expect(stderr).toContain(JSON.stringify(bad));
      expect(stderr).toContain('usage:');
      expect(readdirSync(cwd)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test('all fifteen generators are covered', () => {
  expect(scripts).toHaveLength(15);
});

test('valid write and check arguments retain their meaning', () => {
  expect(generatorArgs('example.ts', 'usage', ['output'])).toEqual({ destination: 'output', check: false });
  expect(generatorArgs('example.ts', 'usage', ['output', '--check'])).toEqual({ destination: 'output', check: true });
});
