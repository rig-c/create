/** Generate example review_package records through the public command, using synthetic frozen inputs. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readTemplate, type JsonObject } from '../src/templates.ts';
import { exampleReviewBytes } from '../tests/review-fixture.ts';
import { asArray, isObject } from '../src/check.ts';
import { sha256 } from '../src/choices.ts';
import { generateExampleOrder } from './generate-example-order.ts';

export function generateExampleReview(dir: string): JsonObject[] {
  if (existsSync(dir)) throw new Error('generation needs a fresh project directory');
  mkdirSync(dir, { recursive: true });
  const project = readTemplate('legacy-example-project.json');
  project.signoffs = [];
  const records: JsonObject[] = [];
  for (const n of [1, 2]) {
    for (const [path, bytes] of Object.entries(exampleReviewBytes())) {
      const source = path === 'config.json' ? `evidence/v${n}/review-config.json` : `outputs/v${n}/${path}`;
      mkdirSync(dirname(join(dir, source)), { recursive: true });
      writeFileSync(join(dir, source), bytes);
    }
    const version = asArray(project.versions).find(v => isObject(v) && v.n === n) as JsonObject;
    (version.provenance as JsonObject).config = { path: `evidence/v${n}/review-config.json`, sha256: sha256(readFileSync(join(dir, `evidence/v${n}/review-config.json`))) };
    writeFileSync(join(dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
    const command = Bun.spawnSync([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'review-package', String(n), dir,
      '--config', `evidence/v${n}/review-config.json`, '--from', `outputs/v${n}/out`, '--json'], { stdout: 'pipe', stderr: 'pipe' });
    if (command.exitCode !== 0) throw new Error(command.stderr.toString());
    records.push(JSON.parse(command.stdout.toString()) as JsonObject);
  }
  return records;
}

if (import.meta.main) {
  const [destination, flag] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check')) throw new Error('usage: bun scripts/generate-example-review.ts <fresh scratch project> [--check]');
  const generated = generateExampleOrder(resolve(destination));
  const records = asArray(generated.project.versions).filter(v => isObject(v) && v.kind === 'rig').map(v => (v as JsonObject).review_package);
  const file = join(import.meta.dir, '../templates/example-project.json');
  const before = readFileSync(file, 'utf8');
  const after = before.split(/(?=    \{\n      "n": \d+,\n      "kind":)/).map((block) => {
    const n = Number(/^    \{\n      "n": (\d+),\n      "kind": "rig"/.exec(block)?.[1]);
    if (n !== 1 && n !== 2) return block;
    const record = JSON.stringify(records[n - 1], null, 2).replaceAll('\n', '\n      ');
    return block.replace(/      "review_package": \{[\s\S]*?\n      \},\n(?=      "outputs")/, '')
      .replace('      "outputs": [', `      "review_package": ${record},\n      "outputs": [`);
  }).join('');
  if (flag === '--check') {
    if (after !== before) throw new Error('generated review records differ from the shipped example');
    console.log('example review records reproduce byte for byte');
  } else {
    writeFileSync(file, after);
    console.log('generated example review records through rig-create review-package');
  }
}
