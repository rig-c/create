/**
 * The synthetic drafts' idle must pass parts' own BREATH_VISIBLE bar, or review's Stage 1 refuses the draft
 * as unchecked. create runs the producer's `check` and reads its named result; it never measures heat itself.
 */
import { expect, test } from 'bun:test';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_SOURCE_DATE_EPOCH } from '../scripts/example-time.ts';
import { EXAMPLE_BREATH_AMP } from '../scripts/generate-example-draft.ts';
import { tempDir } from './helpers.ts';

const PARTS = join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs');
const DRAFT = join(import.meta.dir, '../templates/example-remesh/derived/drafts/remesh');

interface PartsCheck { exitCode: number; codes: string[]; breath: string }

/** parts' `check` with review's argv (less `--environment`); the codes are the named `FAIL  CODE:` lines it prints. */
function partsCheck(root: string): PartsCheck {
  const run = Bun.spawnSync([process.execPath, PARTS, 'check', '--rig', 'out', '--out', 'check-run', '--parts', 'input', '--page-edges', 'free', '--pack-shape', 'polygon'],
    { cwd: root, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  const stdout = `${run.stdout}${run.stderr}`;
  const codes = [...stdout.matchAll(/^\s*FAIL\s+([A-Z][A-Z0-9_]*):/gm)].map(match => match[1]!);
  const report = JSON.parse(readFileSync(join(root, 'check-run/check.json'), 'utf8')) as { BREATH_VISIBLE: { status: string } };
  return { exitCode: run.exitCode ?? -1, codes, breath: report.BREATH_VISIBLE.status };
}

test('the shipped mesh draft carries the shared breath amplitude and passes parts check', () => {
  const config = JSON.parse(readFileSync(join(DRAFT, 'config.json'), 'utf8')) as { motion: { tracks: { amp: number }[] } };
  expect(config.motion.tracks.map(track => track.amp)).toEqual([EXAMPLE_BREATH_AMP]);
  const root = tempDir();
  for (const path of ['input', 'out']) cpSync(join(DRAFT, path), join(root, path), { recursive: true });
  expect(partsCheck(root)).toEqual({ exitCode: 0, codes: [], breath: 'PASS' });
}, 120_000);

test('plant: the old amp-0.5 idle fails parts check by CHECK_BREATH_VISIBLE alone', () => {
  const root = tempDir();
  for (const path of ['input', 'interview-requirements.json']) cpSync(join(DRAFT, path), join(root, path), { recursive: true });
  const config = JSON.parse(readFileSync(join(DRAFT, 'config.json'), 'utf8')) as { motion: { tracks: { amp: number }[] } };
  config.motion.tracks[0]!.amp = 0.5;
  writeFileSync(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const rig = Bun.spawnSync([process.execPath, PARTS, 'rig', '--config', 'config.json', '--parts', 'input', '--out', 'out'],
    { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: EXAMPLE_SOURCE_DATE_EPOCH }, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  expect(rig.exitCode).toBe(0);
  expect(partsCheck(root)).toEqual({ exitCode: 1, codes: ['CHECK_BREATH_VISIBLE'], breath: 'FAIL' });
}, 120_000);
