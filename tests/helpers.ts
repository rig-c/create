import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from './clock.ts';

export const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
/** The CLI process at the suite's current instant (tests/cli-at.ts): spawn `[process.execPath, ...clockedCli(), ...args]`. */
export const clockedCli = (): string[] => [join(import.meta.dir, 'cli-at.ts'), testClock.iso()];

/** A fresh folder under the OS temp dir — never inside the repo, whose node_modules would leak in. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rig-create-test-'));
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
