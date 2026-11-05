/** Reproduce the shipped parts inventory and the inline record through the normal sign-off writer. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { signoffCommand } from '../src/signoff.ts';
import { readTemplate, type JsonObject } from '../src/templates.ts';
import { EXAMPLE_DIFF_REPORT, generateDiffFixture } from '../tests/diff-fixture.ts';
import { EXAMPLE_PARTS_DIR, EXAMPLE_VERDICT, writePartsPackage } from '../tests/parts-package.ts';

export function generateExampleDiff(dir: string): { report: string; stack: Buffer; record: JsonObject } {
  if (existsSync(dir)) throw new Error('generation needs a fresh scratch directory');
  mkdirSync(dir, { recursive: true });
  const report = generateDiffFixture(join(dir, 'inputs'));
  const parsed = JSON.parse(report) as { components: { id: string }[] };
  if (parsed.components.length < 1) throw new Error('synthetic example must list a component');
  const stack = readFileSync(join(dir, 'inputs/recomposite_rig.png'));
  writePartsPackage(dir);
  writeFileSync(join(dir, EXAMPLE_DIFF_REPORT), report);
  writeFileSync(join(dir, EXAMPLE_PARTS_DIR, 'recomposite_rig.png'), stack);
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify(readTemplate('legacy-example-project.json'), null, 2)}\n`);
  writeFileSync(join(dir, 'words.txt'), 'the parts are clean, rig it');
  const flags = parsed.components.flatMap((c) => ['--component', `${c.id}=in-painting:the synthetic painting deliberately differs here`]);
  const signed = signoffCommand(['parts-review', dir, '--by', 'user', '--evidence', EXAMPLE_VERDICT,
    '--diff-report', EXAMPLE_DIFF_REPORT, ...flags, '--verbatim-file', join(dir, 'words.txt'), '--json']);
  const record = (JSON.parse(signed.stdout) as { diff_map: JsonObject }).diff_map;
  return { report, stack, record };
}

if (import.meta.main) {
  const [destination, flag] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check')) throw new Error('usage: bun scripts/generate-example-diff.ts <fresh scratch directory> [--check]');
  const generated = generateExampleDiff(resolve(destination));
  const root = join(import.meta.dir, '../templates');
  const file = join(root, 'example-project.json');
  const before = readFileSync(file, 'utf8');
  const after = before.split('\n').map((line) => {
    if (!/^    \{\s*"stage"\s*:\s*"parts-review"/.test(line)) return line;
    const entry = JSON.parse(line.trim().replace(/,$/, '')) as JsonObject;
    entry.diff_map = generated.record;
    return `    ${JSON.stringify(entry)}${line.endsWith(',') ? ',' : ''}`;
  }).join('\n');
  if (flag === '--check') {
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
