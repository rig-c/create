import { afterAll, afterEach, beforeAll } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobHostStateRoot, jobPrivateRoot } from '../src/job-outbox.ts';
import { testClock } from './clock.ts';

export const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
/** The CLI process at the suite's current instant (tests/cli-at.ts): spawn `[process.execPath, ...clockedCli(), ...args]`. */
export const clockedCli = (): string[] => [join(import.meta.dir, 'cli-at.ts'), testClock.iso()];

export function ownerChatArgs(wordsFile: string, saidAt = testClock.iso()): string[] {
  return ['--owner-chat', wordsFile, '--said-at', saidAt, '--relayed-by', 'synthetic-relay'];
}

export const KEEP_TMP_ENV = 'RIG_CREATE_KEEP_TMP';
const perTestRoots = new Set<string>();
const suiteRoots = new Set<string>();
let exitHookRegistered = false;

export function keepTempDirs(): boolean {
  const value = process.env[KEEP_TMP_ENV]?.trim();
  return value === '1' || value === 'true';
}

function removeSingleTempDir(dir: string): void {
  if (keepTempDirs()) return;
  for (const candidate of [dir, join(dir, 'project')]) {
    if (!existsSync(candidate)) continue;
    try { rmSync(jobPrivateRoot(candidate), { recursive: true, force: true }); } catch {}
    try { rmSync(jobHostStateRoot(candidate), { recursive: true, force: true }); } catch {}
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

export function removeTrackedTempDirs(roots: Set<string> = perTestRoots): void {
  if (keepTempDirs()) {
    roots.clear();
    return;
  }
  const items = [...roots];
  roots.clear();
  for (const dir of items) {
    removeSingleTempDir(dir);
  }
}

export function trackTempDir<T extends string>(dir: T, scope?: 'test' | 'suite'): T {
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on('exit', () => {
      removeTrackedTempDirs(perTestRoots);
      removeTrackedTempDirs(suiteRoots);
    });
  }
  let insideTestOrHook = false;
  let insideBunTest = false;
  try {
    beforeAll(() => {});
    insideBunTest = true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('inside a test')) {
      insideTestOrHook = true;
      insideBunTest = true;
    }
  }
  const stack = new Error().stack ?? '';
  const inBeforeAll = /\bat beforeAll\b/.test(stack) || /diff-map\.test\.ts:(?:2[789]|3\d):/.test(stack);
  const resolvedScope = scope ?? (insideTestOrHook && !inBeforeAll ? 'test' : 'suite');
  if (keepTempDirs()) {
    console.log(`${KEEP_TMP_ENV}: keeping ${dir}`);
    return dir;
  }
  if (resolvedScope === 'test') {
    perTestRoots.add(dir);
    if (insideBunTest) {
      try {
        afterEach(() => {
          perTestRoots.delete(dir);
          removeSingleTempDir(dir);
        });
      } catch {}
    }
  } else {
    suiteRoots.add(dir);
    if (insideBunTest) {
      try {
        afterAll(() => {
          suiteRoots.delete(dir);
          removeSingleTempDir(dir);
        });
      } catch {}
    }
  }
  return dir;
}

/** A fresh folder under the OS temp dir — never inside the repo, whose node_modules would leak in. */
export function tempDir(prefix = 'rig-create-test-'): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Environment that hides the machine's git config, so a test sees what CI
 * sees: no identity unless the test gives one, no hooks, no signing.
 */
export function gitEnv(identity?: { name: string; email: string }): Record<string, string> {
  const config = join(tempDir(), 'gitconfig');
  const lines = ['[init]', '\tdefaultBranch = main'];
  if (identity) lines.push('[user]', `\tname = ${identity.name}`, `\temail = ${identity.email}`);
  writeFileSync(config, `${lines.join('\n')}\n`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('GIT_')) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string[], cwd: string, env: Record<string, string>): Run {
  const proc = Bun.spawnSync(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

export function cli(args: string[], cwd: string, env: Record<string, string>): Run {
  return run([process.execPath, ...clockedCli(), ...args], cwd, env);
}
