import { test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jobRuntimeExecArgv } from '../src/job-writer.ts';

export interface SourceOnlyTestEntry {
  readonly file: string;
  readonly name: string;
  readonly displayName?: string;
  readonly reason: string;
}

export function validateSourceOnlyList(entries: readonly SourceOnlyTestEntry[]): Map<string, SourceOnlyTestEntry> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('scripts/source-only-tests.json must be a non-empty list');
  }
  const byName = new Map<string, SourceOnlyTestEntry>();
  const seenDisplay = new Set<string>();
  for (const entry of entries) {
    const file = entry?.file?.trim();
    const name = entry?.name?.trim();
    const reason = entry?.reason?.trim();
    const display = (entry?.displayName ?? entry?.name)?.trim();
    if (!file || !name || !reason || !display) {
      throw new Error(`Invalid source-only test entry: ${JSON.stringify(entry)}`);
    }
    if (byName.has(name) || seenDisplay.has(display)) {
      throw new Error(`Duplicate source-only test entry: "${display}"`);
    }
    byName.set(name, entry);
    seenDisplay.add(display);
  }
  return byName;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const PASS_LINE_RE = /^(?:\(pass\)|✓) (.+?)(?: \[\d+(?:\.\d+)?m?s\])?$/;

export function parsePassedTestNames(rawOutput: string): Set<string> {
  const passed = new Set<string>();
  const stripped = rawOutput.replace(ANSI_ESCAPE, '');
  for (const line of stripped.split(/\r?\n/)) {
    const match = PASS_LINE_RE.exec(line);
    if (match?.[1]) {
      passed.add(match[1]);
    }
  }
  return passed;
}

export const SOURCE_ONLY_TESTS = JSON.parse(
  readFileSync(join(import.meta.dir, '../scripts/source-only-tests.json'), 'utf8'),
) as readonly SourceOnlyTestEntry[];

const BY_NAME = validateSourceOnlyList(SOURCE_ONLY_TESTS);

export function isSourceLinkedRun(): boolean {
  return process.env.RIG_CREATE_SOURCE_CI === '1' || jobRuntimeExecArgv().length > 0;
}

/**
 * Registers a test that requires sibling `@rig-c/review` source newer than registry 3.7.0.
 * Every test passed to `sourceOnlyTest` MUST be declared in `scripts/source-only-tests.json`.
 */
export function sourceOnlyTest(
  name: string,
  fn: () => void | Promise<unknown>,
  timeout?: number,
): void {
  const entry = BY_NAME.get(name);
  if (!entry || !entry.reason.trim()) {
    throw new Error(`Unlisted source-only test "${name}"; add it with a reason to scripts/source-only-tests.json`);
  }
  const register = isSourceLinkedRun() ? test : test.skip;
  if (timeout !== undefined) {
    register(name, fn, timeout);
  } else {
    register(name, fn);
  }
}
