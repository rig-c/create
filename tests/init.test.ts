import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FALLBACK_IDENTITY, GITIGNORE, IGNORED_DIRS, TRACKED_EMPTY_DIRS, packageNameFor } from '../src/init.ts';
import { PINNED_PACKAGES } from '../src/pins.ts';
import { readTemplate } from '../src/templates.ts';
import { cli, gitEnv, run, tempDir } from './helpers.ts';

function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (prefix === '' && entry === '.git') continue;
    const rel = prefix + entry;
    if (statSync(join(dir, entry)).isDirectory()) {
      out.push(`${rel}/`, ...listTree(join(dir, entry), `${rel}/`));
    } else {
      out.push(rel);
    }
  }
  return out;
}

describe('init --no-install into an empty folder', () => {
  const root = tempDir();
  const env = gitEnv();
  const dir = join(root, 'demo-project');
  const result = cli(['init', dir, '--no-install'], root, env);

  test('exits 0 and prints the path and the next step', () => {
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(dir);
    expect(result.stdout).toContain('put the painting in inputs/, then start the interview');
    expect(result.stdout).toContain('https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md');
    expect(result.stdout).toContain('bun install');
  });

  test('writes the layout of docs/PROJECT.md and nothing else', () => {
    expect(listTree(dir)).toEqual([
      '.gitignore',
      'AGENT-REFERENCE.md',
      'AGENTS.md',
      'CLAUDE.md',
      'derived/',
      'evidence/',
      'evidence/.gitkeep',
      'inputs/',
      'inputs/references/',
      'inputs/references/.gitkeep',
      'outputs/',
      'package.json',
      'project.json',
      'scratch/',
    ]);
    for (const sub of IGNORED_DIRS) expect(readdirSync(join(dir, sub))).toEqual([]);
    for (const sub of TRACKED_EMPTY_DIRS) expect(readdirSync(join(dir, sub))).toContain('.gitkeep');
  });

  test('project.json fills the name and explicit order adoption time', () => {
    const written = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const template = readTemplate('project.json');
    expect(written.name).toBe('demo-project');
    const order = (written.interview as Record<string, unknown>).order as Record<string, unknown>;
    expect(order.spec).toBe('rig-create/stage-order@2');
    expect(Number.isFinite(Date.parse(order.choices_adopted_at as string))).toBe(true);
    expect(Number.isFinite(Date.parse(order.adopted_at as string))).toBe(true);
    (template.interview as Record<string, unknown>).order = order;
    expect(written.corrections_contract.schema).toBe('rig-create/corrections@1');
    expect(Number.isFinite(Date.parse(written.corrections_contract.adopted_at))).toBe(true);
    template.corrections_contract = written.corrections_contract;
    expect({ ...written, name: null }).toEqual({ ...template, name: null });
    expect(template.name).toBeNull();
  });

  test('.gitignore drops derived/, outputs/, scratch/ and node_modules/', () => {
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(GITIGNORE);
    expect(GITIGNORE.split('\n')).toEqual(['/derived/', '/outputs/', '/scratch/', 'node_modules/', '/.rig-create-review-binding.json', '/.rig-create-review/', '']);
  });

  test('package.json pins the rig-c packages exactly', () => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual(PINNED_PACKAGES);
    expect(pkg.private).toBe(true);
  });

  test('git status is clean after exactly one commit, with the fallback identity', () => {
    expect(run(['git', 'status', '--porcelain', '--ignored=no'], dir, env).stdout).toBe('');
    const log = run(['git', 'log', '--format=%an <%ae>|%s'], dir, env).stdout.trim().split('\n');
    expect(log).toEqual([`${FALLBACK_IDENTITY.name} <${FALLBACK_IDENTITY.email}>|Create project demo-project`]);
    expect(result.stdout).toContain('no git identity is configured');
    // The fallback is for that commit only: nothing was written to the project's git config.
    expect(run(['git', 'config', '--local', 'user.name'], dir, env).code).not.toBe(0);
  });

  test('every written file is committed', () => {
    const tracked = run(['git', 'ls-files'], dir, env).stdout.trim().split('\n').sort();
    expect(tracked).toEqual([
      '.gitignore',
      'AGENT-REFERENCE.md',
      'AGENTS.md',
      'CLAUDE.md',
      'evidence/.gitkeep',
      'inputs/references/.gitkeep',
      'package.json',
      'project.json',
    ]);
  });
});

test('init uses the configured git identity when there is one', () => {
  const root = tempDir();
  const env = gitEnv({ name: 'Test User', email: 'test@example.com' });
  const dir = join(root, 'with-identity');
  const result = cli(['init', dir, '--no-install'], root, env);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain('no git identity is configured');
  expect(run(['git', 'log', '--format=%an <%ae>'], dir, env).stdout.trim()).toBe('Test User <test@example.com>');
});

test('init into a non-empty folder is refused by name and writes nothing', () => {
  const root = tempDir();
  const dir = join(root, 'taken');
  mkdirSync(dir);
  writeFileSync(join(dir, 'painting.png'), 'x');
  const result = cli(['init', dir, '--no-install'], root, gitEnv());
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toStartWith('rig-create: INIT_DIR_NOT_EMPTY: ');
  expect(result.stderr).toContain(dir);
  expect(readdirSync(dir)).toEqual(['painting.png']);
});

test('init onto a file is refused by name', () => {
  const root = tempDir();
  const file = join(root, 'a-file');
  writeFileSync(file, 'x');
  const result = cli(['init', file, '--no-install'], root, gitEnv());
  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith('rig-create: INIT_NOT_A_DIRECTORY: ');
  expect(readFileSync(file, 'utf8')).toBe('x');
});

test('init into an existing empty folder works', () => {
  const root = tempDir();
  const dir = join(root, 'empty');
  mkdirSync(dir);
  const env = gitEnv();
  expect(cli(['init', dir, '--no-install'], root, env).code).toBe(0);
  expect(existsSync(join(dir, 'project.json'))).toBe(true);
});

test('init usage errors are refused by name', () => {
  const root = tempDir();
  const env = gitEnv();
  expect(cli(['init'], root, env).stderr).toStartWith('rig-create: INIT_DIR_MISSING: ');
  expect(cli(['init', 'a', 'b'], root, env).stderr).toStartWith('rig-create: INIT_TOO_MANY_ARGUMENTS: ');
  const bad = cli(['init', join(root, 'x'), '--offline'], root, env);
  expect(bad.code).toBe(2);
  expect(bad.stderr).toStartWith('rig-create: UNKNOWN_OPTION: init does not take --offline');
  expect(readdirSync(root)).toEqual([]);
});

test('packageNameFor makes a name npm accepts', () => {
  expect(packageNameFor('demo-project')).toBe('demo-project');
  expect(packageNameFor('My Rig #2')).toBe('my-rig-2');
  expect(packageNameFor('.hidden')).toBe('hidden');
  expect(packageNameFor('***')).toBe('rig-project');
});

// The issue's bar: install, then a reinstall resolves from the lockfile with no network.
// Bun's `--offline` ("never touch the network: resolve and install only from the local cache")
// is used with `--frozen-lockfile`, against a cache dir this test owns, so the cache holds only
// what this init downloaded. Needs the network for the first install, so it runs on request.
test.skipIf(process.env.RIG_CREATE_NETWORK !== '1')(
  'init with install writes a lockfile that reinstalls offline',
  () => {
    const root = tempDir();
    const cache = join(root, 'bun-cache');
    const env = { ...gitEnv(), BUN_INSTALL_CACHE_DIR: cache };
    const dir = join(root, 'installed');

    const result = cli(['init', dir], root, env);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('(bun.lock written)');
    expect(run(['git', 'ls-files', 'bun.lock'], dir, env).stdout.trim()).toBe('bun.lock');
    expect(run(['git', 'status', '--porcelain'], dir, env).stdout).toBe('');
    expect(run(['git', 'rev-list', '--count', 'HEAD'], dir, env).stdout.trim()).toBe('1');

    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    const reinstall = run([process.execPath, 'install', '--frozen-lockfile', '--offline'], dir, env);
    expect(reinstall.code).toBe(0);
    for (const [pkg, version] of Object.entries(PINNED_PACKAGES)) {
      const installed = JSON.parse(readFileSync(join(dir, 'node_modules', pkg, 'package.json'), 'utf8'));
      expect(installed.version).toBe(version);
    }
    // One copy of core: the pin is the version parts itself depends on.
    const parts = JSON.parse(readFileSync(join(dir, 'node_modules', '@rig-c', 'parts', 'package.json'), 'utf8'));
    expect(parts.dependencies['@rig-c/core']).toBe(PINNED_PACKAGES['@rig-c/core']);
    expect(existsSync(join(dir, 'node_modules', 'rig-c'))).toBe(false);
    expect(run(['git', 'status', '--porcelain'], dir, env).stdout).toBe('');
  },
  300_000,
);

test('a failed install still leaves the project created and committed, refused by name', () => {
  const root = tempDir();
  // An unreachable registry and an empty cache make bun install fail without the network.
  const env = { ...gitEnv(), BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/', BUN_INSTALL_CACHE_DIR: join(tempDir(), 'cache') };
  const dir = join(root, 'demo-project');
  const result = cli(['init', dir], root, env);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('INIT_INSTALL_FAILED');
  expect(result.stderr).toContain('Run bun install there, then commit bun.lock');
  expect(result.stdout).toContain('bun install FAILED');
  expect(run(['git', 'status', '--porcelain', '--untracked-files=no'], dir, env).stdout).toBe('');
  const files = run(['git', 'ls-files'], dir, env).stdout.split('\n');
  expect(files).toContain('project.json');
  expect(files).not.toContain('bun.lock');
  expect(run(['git', 'rev-list', '--count', 'HEAD'], dir, env).stdout.trim()).toBe('1');
});
