/**
 * The filled example's assembled parts and the passing `rig-parts check-parts` report the example
 * generator made on them (templates/example-draft/input and evidence/parts-check.json), for tests and
 * fixtures that record a parts → parts-review move. Nothing here is written by hand.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXAMPLE_DRAFT, EXAMPLE_PARTS_CHECK } from './draft-fixture.ts';

const example = join(import.meta.dir, '../templates/example-draft');

/** The assembled root the example report was run on, project-relative. */
export const PARTS_CHECK_ROOT = `${EXAMPLE_DRAFT}/input`;

export const partsCheckBytes = (): Buffer => readFileSync(join(example, EXAMPLE_PARTS_CHECK));

/** Write the example parts and its report into a project; returns the advance flags that bind them. */
export function withPartsCheck(dir: string, root = PARTS_CHECK_ROOT, report = EXAMPLE_PARTS_CHECK, bytes: Uint8Array = partsCheckBytes()): string[] {
  cpSync(join(example, 'input'), join(dir, root), { recursive: true });
  mkdirSync(dirname(join(dir, report)), { recursive: true });
  writeFileSync(join(dir, report), bytes);
  return ['--parts-check', report, '--parts', root];
}
