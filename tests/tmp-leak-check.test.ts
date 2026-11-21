import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countMatchingTmpEntries, runTmpLeakCheck } from '../scripts/tmp-leak-check.ts';
import { KEEP_TMP_ENV, tempDir } from './helpers.ts';

test('tempDir removes folders after each test, including after failure, unless KEEP_TMP_ENV is set', () => {
  const isolatedTmp = realpathSync(mkdtempSync(join(tmpdir(), 'tmp-leak-control-')));
  try {
    const childFile = join(isolatedTmp, 'sample.test.ts');
    writeFileSync(
      childFile,
      [
        "import { describe, expect, test } from 'bun:test';",
        "import { existsSync } from 'node:fs';",
        `import { tempDir } from ${JSON.stringify(join(import.meta.dir, 'helpers.ts'))};`,
        "describe('suite scope', () => {",
        "  const suiteDir = tempDir('rig-create-test-', { scope: 'suite' });",
        "  test('passing test creates tempDir', () => {",
        '    const dir = tempDir();',
        '    expect(dir.length).toBeGreaterThan(0);',
        '    expect(existsSync(suiteDir)).toBe(true);',
        '  });',
        "  test('failing test creates tempDir and still sees suite-scoped tempDir', () => {",
        '    const dir = tempDir();',
        '    expect(dir.length).toBeGreaterThan(0);',
        '    expect(existsSync(suiteDir)).toBe(true);',
        '    if (process.env.PLANT_TEST_FAILURE === "1") throw new Error("planted failure");',
        '  });',
        '});',
      ].join('\n'),
    );

    const clean = runTmpLeakCheck([process.execPath, 'test', childFile], {
      tmpDir: isolatedTmp,
      env: { TMPDIR: isolatedTmp, [KEEP_TMP_ENV]: undefined, PLANT_TEST_FAILURE: undefined },
    });
    expect(clean.exitCode).toBe(0);
    expect(clean.before).toBe(0);
    expect(clean.after).toBe(0);

    const failed = runTmpLeakCheck([process.execPath, 'test', childFile], {
      tmpDir: isolatedTmp,
      env: { TMPDIR: isolatedTmp, [KEEP_TMP_ENV]: undefined, PLANT_TEST_FAILURE: '1' },
    });
    expect(failed.exitCode).not.toBe(0);
    expect(failed.after).toBe(0);
    expect(countMatchingTmpEntries(isolatedTmp)).toBe(0);

    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== KEEP_TMP_ENV && key !== 'PLANT_TEST_FAILURE') cleanEnv[key] = value;
    }
    const keptProc = Bun.spawnSync([process.execPath, 'test', childFile], {
      env: { ...cleanEnv, TMPDIR: isolatedTmp, [KEEP_TMP_ENV]: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(keptProc.exitCode).toBe(0);
    const stdout = keptProc.stdout.toString();
    expect(stdout).toContain(`${KEEP_TMP_ENV}: keeping `);
    expect(countMatchingTmpEntries(isolatedTmp)).toBe(3);

    // Planted leak: runTmpLeakCheck exits 1 when count grows even if the command exits 0.
    const leakCheck = runTmpLeakCheck(
      [process.execPath, '-e', 'import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path"; mkdtempSync(join(tmpdir(), "rig-create-test-"));'],
      { tmpDir: isolatedTmp, env: { TMPDIR: isolatedTmp } },
    );
    expect(leakCheck.exitCode).toBe(1);
    expect(leakCheck.after).toBe(leakCheck.before + 1);
  } finally {
    rmSync(isolatedTmp, { recursive: true, force: true });
  }
}, 20_000);

test('tempDir tracks current test folder for cleanup', () => {
  const dir = tempDir();
  expect(existsSync(dir)).toBe(true);
});
