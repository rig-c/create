import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInputFiles } from '../scripts/generate-composed-direction-fixture.ts';

test('composed direction input check seals the complete file inventory without a Review job', () => {
  const repo = join(import.meta.dir, '..');
  const script = join(repo, 'scripts/generate-composed-direction-fixture.ts');
  const temp = mkdtempSync(join(tmpdir(), 'rig-create-test-composed-inputs-'));
  try {
    for (const [args, dir, variant] of [
      [['--check'], 'templates/example-composed-direction/inputs', 'default'],
      [['--clip', '--check'], 'templates/example-composed-clip/inputs', 'clip'],
    ] as const) {
      const checked = Bun.spawnSync([process.execPath, script, ...args], { cwd: temp, timeout: 10_000 });
      expect(checked.stderr.toString()).toBe('');
      expect(checked.exitCode).toBe(0);
      expect(checked.stdout.toString()).toContain('files match byte for byte');

      const copy = join(temp, `inputs-${variant}`);
      cpSync(join(repo, dir), copy, { recursive: true });
      writeFileSync(join(copy, 'scene.json'), '{}\n');
      rmSync(join(copy, 'approval/rig.txt'));
      writeFileSync(join(copy, 'extra.txt'), 'unexpected');
      expect(() => checkInputFiles(copy, variant)).toThrow(/COMPOSED_INPUT_MISMATCH\nmissing approval\/rig\.txt\nextra extra\.txt\nchanged scene\.json/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('clipped composed direction scene without canvas_clip is refused by the pinned Parts CLI with SCENE_CHARACTER_INSIDE_CANVAS', () => {
  const repo = join(import.meta.dir, '..');
  const temp = mkdtempSync(join(tmpdir(), 'rig-create-test-composed-clip-negative-'));
  try {
    const clipInputs = join(repo, 'templates/example-composed-clip/inputs');
    mkdirSync(join(temp, 'inputs'), { recursive: true });
    cpSync(join(clipInputs, 'plates/background.png'), join(temp, 'inputs/background.png'));
    cpSync(join(clipInputs, 'plates/foreground.png'), join(temp, 'inputs/foreground.png'));
    const build = join(temp, 'evidence/compose-character');
    cpSync(join(repo, 'templates/example-remesh/outputs/v1/out'), build, { recursive: true });
    mkdirSync(join(build, 'check'), { recursive: true });
    cpSync(join(repo, 'templates/example-remesh/evidence/v1/registration/check.json'), join(build, 'check/check.json'));

    const scene = JSON.parse(readFileSync(join(clipInputs, 'scene.json'), 'utf8')) as {
      characters: Record<string, unknown>[];
    };
    expect(scene.characters[0]?.canvas_clip).toBe(true);
    delete scene.characters[0]!.canvas_clip;
    writeFileSync(join(temp, 'compose.scene.json'), `${JSON.stringify(scene, null, 2)}\n`);

    const partsCli = join(repo, 'node_modules/@rig-c/parts/bin/rig-parts.cjs');
    const result = Bun.spawnSync([process.execPath, partsCli, 'compose', '--scene', 'compose.scene.json', '--out', 'scratch/compose'], {
      cwd: temp, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString() + result.stdout.toString()).toContain('SCENE_CHARACTER_INSIDE_CANVAS');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
