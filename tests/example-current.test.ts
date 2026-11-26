import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXAMPLE_ANCHOR } from '../scripts/example-time.ts';
import { checkProject } from '../src/check.ts';
import { nextProject } from '../src/next.ts';
import { consumerOnlyTest } from './consumer-only.ts';

const retained = join(import.meta.dir, '../templates/example-current');

test('the current-path example checks at acceptance', () => {
  const now = EXAMPLE_ANCHOR + 60 * 60 * 1000;
  const report = checkProject(retained, undefined, { now });
  expect(report.refusals.map(finding => finding.code)).toEqual([]);
  expect(report.warnings.map(finding => finding.code)).toEqual([]);
  expect(nextProject(retained, now)).toMatchObject({
    stage: 'accepted', effective_stage: 'accepted', accepted: true, moves: [],
  });
});

consumerOnlyTest('tests/example-current.test.ts', 'the current-path example reproduces from the release-pinned producers', () => {
  const root = mkdtempSync(join(tmpdir(), 'create-example-current-'));
  const generator = join(import.meta.dir, '../scripts/generate-example-current.ts');
  try {
    const run = Bun.spawnSync([process.execPath, generator, join(root, 'generated'), '--check'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 120_000,
    });
    expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 130_000);
