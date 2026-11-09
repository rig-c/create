import { preparePartsApproval } from '../tests/parts-receipt-fixture.ts';
import { generatorArgs } from './generator-args.ts';
/** Reproduce the shipped parts inventory and the inline record through the normal sign-off writer. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { diffClassesCommand } from '../src/diff-classes.ts';
import { signoffCommand } from '../src/signoff.ts';
import { type JsonObject } from '../src/templates.ts';
import { materializeFixture } from '../tests/fixtures.ts';
import { EXAMPLE_DIFF_REPORT, generateDiffFixture } from '../tests/diff-fixture.ts';
import { EXAMPLE_PARTS_DIR, writePartsPackage } from '../tests/parts-package.ts';
import { EXAMPLE_NOW, exampleTime } from './example-time.ts';
import { replaceValue } from './generate-example-order.ts';

export function generateExampleDiff(dir: string): { report: string; stack: Buffer; record: JsonObject } {
  if (existsSync(dir)) throw new Error('generation needs a fresh scratch directory');
  materializeFixture(dir, () => {}, 'legacy-example-project.json');
  const report = generateDiffFixture(join(dir, 'inputs'));
  const parsed = JSON.parse(report) as { components: { id: string }[] };
  if (parsed.components.length < 1) throw new Error('synthetic example must list a component');
  const stack = readFileSync(join(dir, 'inputs/recomposite_rig.png'));
  writePartsPackage(dir);
  writeFileSync(join(dir, EXAMPLE_DIFF_REPORT), report);
  writeFileSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png'), stack);
  writeFileSync(join(dir, 'words.txt'), 'the parts are clean, rig it');
  const flags = parsed.components.flatMap((c) => ['--component', `${c.id}=in-painting:the synthetic painting deliberately differs here`]);
  const approvalFlags = preparePartsApproval(dir, EXAMPLE_NOW);
  const diffAt = Date.parse(exampleTime('2026-11-11T10:20:00Z'));
  const classified = diffClassesCommand([dir, '--diff-report', EXAMPLE_DIFF_REPORT, ...flags, '--by', 'agent', '--json'], diffAt);
  signoffCommand(['parts-review', dir, '--by', 'user', ...approvalFlags,
    '--verbatim-file', join(dir, 'words.txt'), '--json'], diffAt);
  const record = (JSON.parse(classified.stdout) as { diff_map: JsonObject }).diff_map;
  return { report, stack, record };
}

if (import.meta.main) {
  const { destination, check } = generatorArgs(import.meta.file, 'usage: bun scripts/generate-example-diff.ts <fresh scratch directory> [--check]');
  const generated = generateExampleDiff(resolve(destination));
  const root = join(import.meta.dir, '../templates');
  const file = join(root, 'example-project.json');
  const before = readFileSync(file, 'utf8');
  const after = replaceValue(before, 'diff_map', generated.record);
  if (check) {
    if (after !== before || generated.report !== readFileSync(join(root, 'example-diff/diff-components.json'), 'utf8')
      || !generated.stack.equals(readFileSync(join(root, 'example-diff/recomposite_rig.png')))) throw new Error('generated diff evidence differs from the shipped example');
    console.log('example diff report, stack and writer record reproduce byte for byte');
  } else {
    writeFileSync(join(root, 'example-diff/diff-components.json'), generated.report);
    writeFileSync(join(root, 'example-diff/recomposite_rig.png'), generated.stack);
    writeFileSync(file, after);
    console.log('generated example diff evidence through installed parts and signoff');
  }
}
