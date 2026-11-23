import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInputFiles } from '../scripts/generate-composed-direction-fixture.ts';

test('composed direction input check seals the complete file inventory without a Review job', () => {
  const repo = join(import.meta.dir, '..');
  const script = join(repo, 'scripts/generate-composed-direction-fixture.ts');
  const temp = mkdtempSync(join(tmpdir(), 'rig-create-test-composed-inputs-'));
  try {
    const checked = Bun.spawnSync([process.execPath, script, '--check'], { cwd: temp, timeout: 10_000 });
    expect(checked.stderr.toString()).toBe('');
    expect(checked.exitCode).toBe(0);
    expect(checked.stdout.toString()).toContain('files match byte for byte');

    const copy = join(temp, 'inputs');
    cpSync(join(repo, 'templates/example-composed-direction/inputs'), copy, { recursive: true });
    writeFileSync(join(copy, 'scene.json'), '{}\n');
    rmSync(join(copy, 'approval/rig.txt'));
    writeFileSync(join(copy, 'extra.txt'), 'unexpected');
    expect(() => checkInputFiles(copy)).toThrow(/COMPOSED_INPUT_MISMATCH\nmissing approval\/rig\.txt\nextra extra\.txt\nchanged scene\.json/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
