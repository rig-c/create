import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { main, RETIRED_NUMBERED_COMMANDS } from '../src/cli.ts';
import {
  LAST_NUMBERED_CREATE_RELEASE,
  NUMBERED_WRITER_REMOVED,
  refuseNumberedWriter,
} from '../src/numbered-retirement.ts';
import { Refusal } from '../src/refusal.ts';
import { signoffCommand } from '../src/signoff.ts';

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

test('retired review, parts-review, numbered signoff, and --from-review flags exit 2 without mutating example-numbered', () => {
  const clone = mkdtempSync(join(tmpdir(), 'create-retired-clone-'));
  cpSync(join(import.meta.dir, '../templates/example-numbered'), clone, { recursive: true });
  cpSync(join(clone, 'example-project.json'), join(clone, 'project.json'));
  const recordPath = join(clone, 'project.json');
  const before = readFileSync(recordPath);

  function runCli(argv: string[]): { exit: number; stderr: string } {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      return { exit: main(argv, EXAMPLE_NOW), stderr: chunks.join('') };
    } finally {
      process.stderr.write = orig;
    }
  }

  try {
    for (const argv of [
      ['review', '2', clone, '--from-review', 'act-1'],
      ['review', '--draft', 'example', clone, '--from-review', 'act-1'],
      ['parts-review', clone, '--from-review', 'act-1'],
      ['parts-review', clone, '--draft', 'example', '--from-review-cli', '--by', 'user', '--', 'derived/parts/rig'],
      ['signoff', 'rig-review', clone, '--version', '2', '--by', 'user', '--verbatim-file', join(clone, 'example-project.json')],
      ['signoff', 'parts-review', clone, '--draft', 'example', '--by', 'user', '--verbatim-file', join(clone, 'example-project.json')],
      ['signoff', 'parts-review', clone, '--by', 'user', '--verbatim-file', join(clone, 'example-project.json')],
      ['signoff', 'rig-review', clone, '--by', 'user', '--verbatim-file', join(clone, 'example-project.json')],
      ['signoff', 'direction-review', clone, '--by', 'user', '--verbatim-file', join(clone, 'example-project.json')],
    ]) {
      const { exit, stderr } = runCli(argv);
      expect(exit, argv.join(' ')).toBe(2);
      expect(stderr, argv.join(' ')).toContain(`${NUMBERED_WRITER_REMOVED}:`);
      expect(readFileSync(recordPath).equals(before)).toBe(true);
    }

    for (const argv of [
      ['signoff', 'rig-review', clone, '--from-review', 'act-1'],
      ['signoff', 'interview', clone, '--from-review', 'act-1'],
      ['signoff', 'parts', clone, '--checkpoint', 'assemble', '--from-review', 'act-1'],
      ['interview-answer', 'rig_type', clone, '--from-review', 'act-1'],
      ['interview-answer', '--batch', clone, '--from-review', 'act-1'],
    ]) {
      const { exit, stderr } = runCli(argv);
      expect(exit, argv.join(' ')).toBe(2);
      expect(stderr, argv.join(' ')).toContain('SIGNOFF_FROM_REVIEW_REMOVED:');
      expect(readFileSync(recordPath).equals(before)).toBe(true);
    }

    expect(() => signoffCommand(['interview', clone, '--from-review', 'act-1'], EXAMPLE_NOW))
      .toThrow(expect.objectContaining({ code: 'SIGNOFF_FROM_REVIEW_REMOVED', exitCode: 2 }));
    expect(() => interviewAnswerCommand(['rig_type', clone, '--from-review', 'act-1'], EXAMPLE_NOW))
      .toThrow(expect.objectContaining({ code: 'SIGNOFF_FROM_REVIEW_REMOVED', exitCode: 2 }));
    expect(readFileSync(recordPath).equals(before)).toBe(true);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});
