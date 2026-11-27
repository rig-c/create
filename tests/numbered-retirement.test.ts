import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, RETIRED_NUMBERED_COMMANDS } from '../src/cli.ts';
import {
  LAST_NUMBERED_CREATE_RELEASE,
  NUMBERED_WRITER_REMOVED,
  refuseNumberedWriter,
} from '../src/numbered-retirement.ts';
import { Refusal } from '../src/refusal.ts';

test('numbered writer retirement helper refuses with NUMBERED_WRITER_REMOVED and exit 2 before reading or writing', () => {
  expect(LAST_NUMBERED_CREATE_RELEASE).toBe('1.27.0');

  let caught: unknown;
  try {
    refuseNumberedWriter('retired-writer', 'use rig-create record <kind> --from <dir>');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Refusal);
  const refusal = caught as Refusal;
  expect(refusal.code).toBe(NUMBERED_WRITER_REMOVED);
  expect(refusal.exitCode).toBe(2);
  expect(refusal.message).toContain('retired-writer');
  expect(refusal.message).toContain('use rig-create record <kind> --from <dir>');
  expect(refusal.message).toContain(`Create ${LAST_NUMBERED_CREATE_RELEASE}`);
  expect(refusal.message).toContain('docs/PROJECT.md#adopting-existing-numbered-outputs');

  const emptyDir = mkdtempSync(join(tmpdir(), 'create-numbered-retirement-'));
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  RETIRED_NUMBERED_COMMANDS['retired-writer'] = 'use rig-create record <kind> --from <dir>';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = main(['retired-writer', emptyDir], Date.UTC(2026, 10, 27));
    expect(exit).toBe(2);
    const stderr = stderrChunks.join('');
    expect(stderr).toContain(`${NUMBERED_WRITER_REMOVED}:`);
    expect(stderr).toContain('retired-writer');
    expect(stderr).toContain(`stay on Create ${LAST_NUMBERED_CREATE_RELEASE}`);
    expect(stderr).toContain('docs/PROJECT.md#adopting-existing-numbered-outputs');
    expect(existsSync(join(emptyDir, 'project.json'))).toBe(false);
    expect(readdirSync(emptyDir)).toEqual([]);
  } finally {
    process.stderr.write = originalWrite;
    delete RETIRED_NUMBERED_COMMANDS['retired-writer'];
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
