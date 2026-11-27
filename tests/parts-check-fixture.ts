/**
 * The numbered example's assembled parts and producer `rig-parts check-parts` report,
 * for tests and fixtures that record a parts → parts-review move.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EXAMPLE_DRAFT, EXAMPLE_PARTS_CHECK } from './draft-fixture.ts';

const example = join(import.meta.dir, '../templates/example-numbered');

/** The assembled root the example report was run on, project-relative. */
export const PARTS_CHECK_ROOT = `${EXAMPLE_DRAFT}/input`;

export const partsCheckBytes = (): Buffer => readFileSync(join(example, EXAMPLE_PARTS_CHECK));

/** Write the example parts and its report into a project; returns the advance flags that bind them. */
export function withPartsCheck(dir: string, root = PARTS_CHECK_ROOT, report = EXAMPLE_PARTS_CHECK, bytes: Uint8Array = partsCheckBytes()): string[] {
  cpSync(join(example, PARTS_CHECK_ROOT), join(dir, root), { recursive: true });
  mkdirSync(dirname(join(dir, report)), { recursive: true });
  writeFileSync(join(dir, report), bytes);
  return ['--parts-check', report, '--parts', root];
}
