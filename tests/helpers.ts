import { afterAll, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { jobHostStateRoot, jobPrivateRoot } from '../src/job-outbox.ts';
import { runningCreateVersion } from '../src/pins.ts';
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

export type TempDirScope = 'test' | 'suite';

export function trackTempDir<T extends string>(dir: T, scope: TempDirScope = 'test'): T {
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on('exit', () => {
      removeTrackedTempDirs(perTestRoots);
      removeTrackedTempDirs(suiteRoots);
    });
  }
  if (keepTempDirs()) {
    console.log(`${KEEP_TMP_ENV}: keeping ${dir}`);
    return dir;
  }
  if (scope === 'test') {
    perTestRoots.add(dir);
    try {
      afterEach(() => {
        perTestRoots.delete(dir);
        removeSingleTempDir(dir);
      });
    } catch {}
  } else {
    suiteRoots.add(dir);
    try {
      afterAll(() => {
        suiteRoots.delete(dir);
        removeSingleTempDir(dir);
      });
    } catch {}
  }
  return dir;
}

/** Every directory and file under root, files by SHA-256: equal digests mean an unchanged tree. */
export function treeDigest(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const rel = relative(root, full).split('\\').join('/');
      if (statSync(full).isDirectory()) {
        out.set(`${rel}/`, 'dir');
        walk(full);
      } else {
        out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * A --preload file that plays a concurrent writer: once the writer under test has created a file
 * whose path ends with suffix, it appends a newline to project.json, so the writer's last record
 * comparison refuses. Return the original bytes to restore the record after the refusal.
 */
export function staleRecordPlant(dir: string, project: string, suffix: string): string {
  const path = join(dir, 'stale-record-plant.ts');
  writeFileSync(path, `import fs from 'node:fs';
import { mock } from 'bun:test';
const project = ${JSON.stringify(project)};
const suffix = ${JSON.stringify(suffix)};
let planted = false;
const plant = (target: unknown) => {
  if (planted || !String(target).endsWith(suffix)) return;
  planted = true;
  fs.appendFileSync(project, '\\n');
};
const { openSync, writeFileSync } = fs;
const wrappers = {
  openSync: (...args: Parameters<typeof openSync>) => { const fd = openSync(...args); plant(args[0]); return fd; },
  writeFileSync: (...args: Parameters<typeof writeFileSync>) => { writeFileSync(...args); plant(args[0]); },
};
Object.assign(fs, wrappers);
mock.module('node:fs', () => ({ ...fs, ...wrappers }));
`);
  return path;
}

/** A fresh folder under the OS temp dir — never inside the repo, whose node_modules would leak in. */
export function tempDir(prefix = 'rig-create-test-', options?: { scope?: TempDirScope }): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), prefix)), options?.scope);
}

/**
 * Environment that hides the machine's git config, so a test sees what CI
 * sees: no identity unless the test gives one, no hooks, no signing.
 */
export function gitEnv(identity?: { name: string; email: string }, options?: { scope?: TempDirScope }): Record<string, string> {
  const config = join(tempDir('rig-create-test-', options), 'gitconfig');
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

/**
 * Whether a test that runs `init` with its install should skip. `init` pins
 * `@rig-c/create` at the running version (#1078), so before that version is
 * published (a release candidate) the install cannot resolve it. Those tests
 * need the network (RIG_CREATE_NETWORK=1) and a published running version;
 * the release's registry smoke covers the unpublished case after publishing.
 */
let initInstallSkip: boolean | undefined;
export function skipInitInstall(): boolean {
  if (process.env.RIG_CREATE_NETWORK !== '1') return true;
  if (initInstallSkip !== undefined) return initInstallSkip;
  const version = runningCreateVersion();
  const view = Bun.spawnSync(['npm', 'view', `@rig-c/create@${version}`, 'version'], { stdout: 'pipe', stderr: 'pipe' });
  const published = view.exitCode === 0 && view.stdout.toString().trim() === version;
  if (!published) console.warn(`skipping init-with-install tests: @rig-c/create@${version} is not published yet`);
  initInstallSkip = !published;
  return initInstallSkip;
}
