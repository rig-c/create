/** Reproduce the current worked example, never a historical answer. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { translateInvariants } from '../src/invariants.ts';
import { readTemplate } from '../src/templates.ts';

export function generateInvariantsExample(dir: string): string {
  if (existsSync(dir)) throw new Error('invariants generation needs a fresh directory');
  mkdirSync(dir, { recursive: true });
  const bytes = `${JSON.stringify(translateInvariants(readTemplate('example-project.json')), null, 2)}\n`;
  writeFileSync(join(dir, 'invariants.json'), bytes);
  return bytes;
}
if (import.meta.main) {
  const [destination, flag, extra] = process.argv.slice(2);
  if (!destination || (flag !== undefined && flag !== '--check') || extra !== undefined) throw new Error('usage: generate-invariants-example.ts <fresh dir> [--check]');
  const bytes = generateInvariantsExample(resolve(destination));
  const root = join(import.meta.dir, '../templates/example-invariants');
  const file = join(root, 'invariants.json');
  if (flag === '--check') {
    if (readFileSync(file, 'utf8') !== bytes) throw new Error('example-invariants/invariants.json differs');
  } else {
    mkdirSync(root, { recursive: true });
    writeFileSync(file, bytes);
  }
  console.log('current guide invariants reproduce byte for byte');
}
