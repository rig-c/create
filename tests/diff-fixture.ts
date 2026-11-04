/** Synthetic PNG inputs and inventories generated only by the installed parts CLI. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const EXAMPLE_DIFF_REPORT = 'evidence/diff-components.json';
const shipped = join(import.meta.dir, '../templates/example-diff');

export function exampleDiffFiles(partsDir = 'derived/parts/rig'): Record<string, string | Uint8Array> {
  return {
    [EXAMPLE_DIFF_REPORT]: readFileSync(join(shipped, 'diff-components.json'), 'utf8'),
    [`${partsDir}/recomposite_rig.png`]: readFileSync(join(shipped, 'recomposite_rig.png')),
  };
}

/** Generate a report on fresh synthetic bytes. Paths in the report are stable, relative to dir. */
export function generateDiffFixture(dir: string, floor = 2, threshold = 40, otherStack = false, identical = false): string {
  mkdirSync(join(dir, 'parts'), { recursive: true });
  const load = createRequire(import.meta.url);
  const { encodePng } = load('@rig-c/core/plate') as { encodePng: (w: number, h: number, rgba: Uint8Array) => Uint8Array };
  const W = 512, H = 768;
  const painting = new Uint8Array(W * H * 4);
  for (let p = 0; p < W * H; p++) painting[p * 4 + 3] = 255;
  const stack = painting.slice();
  if (!identical) for (const p of [10, 11, 12, 1000, 1001, 1002]) stack.fill(otherStack ? 200 : 255, p * 4, p * 4 + 3);
  writeFileSync(join(dir, 'painting.png'), encodePng(W, H, painting));
  writeFileSync(join(dir, 'recomposite_rig.png'), encodePng(W, H, stack));
  writeFileSync(join(dir, 'parts/sample.png'), encodePng(W, H, stack));
  writeFileSync(join(dir, 'parts.json'), JSON.stringify({
    rig_size: [W, H], scale_rig_per_source: 1, ghost_px: {},
    parts: [{ name: 'sample', from: 'full:author:sample', x: 0, y: 0, w: W, h: H, opaque_px: W * H,
      projected_core_px: 0, source_px_taken: 0, refused_drift_px: 0, merged_px: 0, seam_override_px: 0 }],
  }));
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../node_modules/@rig-c/parts/bin/rig-parts.cjs'),
    'diff-components', '--stack', 'recomposite_rig.png', '--painting', 'painting.png', '--parts', 'parts.json',
    '--floor', String(floor), '--threshold', String(threshold), '--out', 'diff-components.json'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString());
  return readFileSync(join(dir, 'diff-components.json'), 'utf8');
}
