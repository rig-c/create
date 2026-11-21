import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const DEFAULT_PREFIX = 'rig-create-test-';

export function listMatchingTmpEntries(dir = tmpdir(), prefix = DEFAULT_PREFIX): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort();
}

export function countMatchingTmpEntries(dir = tmpdir(), prefix = DEFAULT_PREFIX): number {
  return listMatchingTmpEntries(dir, prefix).length;
}

export function runTmpLeakCheck(
  command: string[] = [process.execPath, 'test'],
  options: { cwd?: string; env?: Record<string, string | undefined>; tmpDir?: string; prefix?: string } = {},
): { before: number; after: number; leaked: string[]; exitCode: number } {
  const dir = options.tmpDir ?? tmpdir();
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const beforeEntries = listMatchingTmpEntries(dir, prefix);
  const beforeSet = new Set(beforeEntries);
  const before = beforeEntries.length;

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
    if (value !== undefined) env[key] = value;
  }

  const proc = Bun.spawnSync(command, {
    cwd: options.cwd ?? resolve(import.meta.dir, '..'),
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const afterEntries = listMatchingTmpEntries(dir, prefix);
  const after = afterEntries.length;
  const leaked = afterEntries.filter((name) => !beforeSet.has(name));

  console.log(`tmp-leak-check: ${prefix}* in ${dir}: before=${before}, after=${after}, delta=${after - before}`);
  if (proc.exitCode !== 0) {
    return { before, after, leaked, exitCode: proc.exitCode ?? 1 };
  }
  if (after > before) {
    console.error(
      `tmp-leak-check: FAIL — ${prefix}* count grew from ${before} to ${after} (+${after - before}): ${leaked.slice(0, 20).join(', ')}`,
    );
    return { before, after, leaked, exitCode: 1 };
  }
  return { before, after, leaked, exitCode: 0 };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args.length > 0 ? args : [process.execPath, 'test'];
  const result = runTmpLeakCheck(command);
  process.exit(result.exitCode);
}
