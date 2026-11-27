import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_NOW } from '../scripts/example-time.ts';
import { interviewAnswerCommand } from '../src/choice-writers.ts';
import { main, RETIRED_NUMBERED_COMMANDS } from '../src/cli.ts';
import { directionCommand } from '../src/direction-writers.ts';
import {
  LAST_NUMBERED_CREATE_RELEASE,
  NUMBERED_WRITER_REMOVED,
  refuseNumberedWriter,
} from '../src/numbered-retirement.ts';
import { Refusal } from '../src/refusal.ts';
import { sceneCommand } from '../src/scene-writers.ts';
import { signoffCommand } from '../src/signoff.ts';
import { repinNumberedCopy } from '../scripts/check-example-numbered.ts';

export const STEP4_RETIRED_CODES = [
  'ASSEMBLY_CONFIG_STALE',
  'DIRECTION_PATCH_FILE_REMOVED',
  'DRAFT_PARTS_INSTALL_BEHIND',
  'DRAFT_RIG_STACK',
  'DRAFT_RIG_USAGE',
  'REVIEW_PACKAGE_BUSY',
  'REVIEW_PACKAGE_EXISTS',
  'REVIEW_PACKAGE_PATH_INVALID',
  'REVIEW_PACKAGE_RECORD_CHANGED',
  'REVIEW_PACKAGE_SOURCE_CHANGED',
  'REVIEW_PACKAGE_USAGE',
  'REVIEW_PACKAGE_VERSION_INVALID',
  'REVIEW_PACKAGE_VERSION_UNKNOWN',
  'RIG_IDLE_MANIFEST_MISSING',
  'RIG_PATH_ADAPTER_OUT_INVALID',
  'RIG_PREFLIGHT_CONFIG_OUTSIDE',
  'RIG_REGISTRATION_BUSY',
  'RIG_REGISTRATION_EXISTS',
  'RIG_REGISTRATION_PATH_INVALID',
  'RIG_REGISTRATION_SOURCE_CHANGED',
  'RIG_REGISTRATION_USAGE',
  'RIG_RUNTIME_PATH_UNRESOLVED',
  'RIG_VERSION_ALREADY_REGISTERED',
] as const;

function runMainCaptured(argv: string[], now = Date.UTC(2026, 10, 27)): { exit: number; stdout: string; stderr: string } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const exit = main(argv, now);
    return { exit, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}

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
  RETIRED_NUMBERED_COMMANDS['retired-writer'] = 'use rig-create record <kind> --from <dir>';
  try {
    const { exit, stdout, stderr } = runMainCaptured(['retired-writer', emptyDir]);
    expect(exit).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(`${NUMBERED_WRITER_REMOVED}:`);
    expect(stderr).toContain('retired-writer');
    expect(stderr).toContain(`stay on Create ${LAST_NUMBERED_CREATE_RELEASE}`);
    expect(stderr).toContain('docs/PROJECT.md#adopting-existing-numbered-outputs');
    expect(existsSync(join(emptyDir, 'project.json'))).toBe(false);
    expect(readdirSync(emptyDir)).toEqual([]);
  } finally {
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

test('removed build and seal commands and numbered flags refuse before reading or writing and never emit retired codes', () => {
  expect(Object.keys(RETIRED_NUMBERED_COMMANDS)).toEqual(expect.arrayContaining([
    'review',
    'parts-review',
    'draft-rig',
    'review-package',
    'rig-version',
  ]));

  const emptyDir = mkdtempSync(join(tmpdir(), 'create-step4-empty-'));
  const numberedClone = mkdtempSync(join(tmpdir(), 'create-step4-numbered-'));
  try {
    cpSync(join(import.meta.dir, '../templates/example-numbered'), numberedClone, { recursive: true });
    writeFileSync(join(numberedClone, 'project.json'), readFileSync(join(numberedClone, 'example-project.json')));
    repinNumberedCopy(numberedClone);
    const cloneProjectBefore = readFileSync(join(numberedClone, 'project.json'));
    const cloneFilesBefore = readdirSync(numberedClone, { recursive: true });

    const invocations: { label: string; argv: (dir: string) => string[]; expectedToken: string }[] = [
      {
        label: 'rig-version',
        argv: dir => ['rig-version', '5', dir, '--parts', 'p', '--rig', 'r', '--build', 'b', '--idle', 'i'],
        expectedToken: 'rig-create record rig',
      },
      {
        label: 'rig-version --preflight',
        argv: dir => ['rig-version', '5', dir, '--preflight', '--config', 'elsewhere.json'],
        expectedToken: 'rig-create record rig',
      },
      {
        label: 'rig-version adapter',
        argv: dir => ['rig-version', 'adapter', dir, '--config', 'c.json', '--out', 'a.json'],
        expectedToken: 'rig-create record rig',
      },
      {
        label: 'review-package',
        argv: dir => ['review-package', '2', dir, '--config', 'evidence/v2/review-config.json', '--from', 'outputs/v2/out'],
        expectedToken: 'rig-create record rig',
      },
      {
        label: 'draft-rig',
        argv: dir => ['draft-rig', 'next', dir, '--config', 'c.json', '--from', 'out'],
        expectedToken: 'rig-create record parts',
      },
      {
        label: 'scene write --rig',
        argv: dir => ['scene', 'write', '--rig', '2', '--background', 'evidence/scene-background.png', '--citations-file', 'evidence/scene-citations.json', dir],
        expectedToken: 'rig-create scene write',
      },
      {
        label: 'direction write <n> --rig',
        argv: dir => ['direction', 'write', '5', dir, '--file', 'evidence/direction-input-v4.json', '--rig', '2'],
        expectedToken: 'rig-create direction write',
      },
      {
        label: 'direction patch',
        argv: dir => ['direction', 'patch', '5', dir, '--patch-file', 'evidence/patch.json'],
        expectedToken: 'rig-create direction write',
      },
      {
        label: 'direction write --patch-file',
        argv: dir => ['direction', 'write', '5', dir, '--file', 'evidence/direction-input-v4.json', '--rig', '2', '--patch-file', 'evidence/patch.json'],
        expectedToken: 'rig-create direction write',
      },
    ];

    for (const { label, argv, expectedToken } of invocations) {
      // Empty directory without project.json proves refusal happens before reading or writing.
      const emptyRun = runMainCaptured(argv(emptyDir));
      expect(emptyRun.exit, label).toBe(2);
      expect(emptyRun.stdout, label).toBe('');
      expect(emptyRun.stderr, label).toContain(`${NUMBERED_WRITER_REMOVED}:`);
      expect(emptyRun.stderr, label).toContain(expectedToken);
      expect(emptyRun.stderr, label).toContain(`Create ${LAST_NUMBERED_CREATE_RELEASE}`);
      expect(emptyRun.stderr, label).toContain('docs/PROJECT.md#adopting-existing-numbered-outputs');
      for (const retired of STEP4_RETIRED_CODES) {
        expect(emptyRun.stderr, `${label} must not emit ${retired}`).not.toContain(retired);
      }
      expect(readdirSync(emptyDir), label).toEqual([]);

      // Frozen numbered clone proves existing project bytes and tree stay byte-identical.
      const cloneRun = runMainCaptured(argv(numberedClone));
      expect(cloneRun.exit, label).toBe(2);
      expect(cloneRun.stdout, label).toBe('');
      expect(cloneRun.stderr, label).toContain(`${NUMBERED_WRITER_REMOVED}:`);
      for (const retired of STEP4_RETIRED_CODES) {
        expect(cloneRun.stderr, `${label} on clone must not emit ${retired}`).not.toContain(retired);
      }
      expect(readFileSync(join(numberedClone, 'project.json')), label).toEqual(cloneProjectBefore);
      expect(readdirSync(numberedClone, { recursive: true }), label).toEqual(cloneFilesBefore);
    }

    // Direct function entry points for surviving commands also refuse --rig before reading project.json.
    expect(() => sceneCommand(['write', '--rig=2', '--background', 'bg.png', '--citations-file', 'c.json', emptyDir]))
      .toThrow(expect.objectContaining({ code: NUMBERED_WRITER_REMOVED, exitCode: 2 }));
    expect(() => directionCommand(['write', '5', emptyDir, '--file', 'd.json', '--rig=2'], Date.UTC(2026, 10, 27)))
      .toThrow(expect.objectContaining({ code: NUMBERED_WRITER_REMOVED, exitCode: 2 }));

    // Surviving reader command `direction check <n>` continues reading the frozen numbered clone cleanly.
    const checkRun = runMainCaptured(['direction', 'check', '4', numberedClone, '--json']);
    expect(checkRun.exit).toBe(0);
    expect(checkRun.stderr).toBe('');
    expect(JSON.parse(checkRun.stdout)).toMatchObject({ schema: 'rig-create/direction-check@1', post: 4 });
    expect(readFileSync(join(numberedClone, 'project.json'))).toEqual(cloneProjectBefore);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
    rmSync(numberedClone, { recursive: true, force: true });
  }
});
