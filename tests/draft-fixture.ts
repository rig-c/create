import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** Synthetic draft artifacts use the same canonical inputs as the frozen review packages. */
import { exampleReviewBytes } from './review-fixture.ts';
import { partImage, partsJson, PART_NAMES } from './parts-package.ts';

export const EXAMPLE_DRAFT = 'derived/drafts/example';
export function exampleDraftFiles(): Record<string, string> {
  const bytes = exampleReviewBytes();
  const files: Record<string, string> = { [`${EXAMPLE_DRAFT}/config.json`]: bytes['config.json'] as string, [`${EXAMPLE_DRAFT}/input/parts.json`]: partsJson() };
  for (const name of PART_NAMES) files[`${EXAMPLE_DRAFT}/input/parts/${name}.png`] = partImage(name);
  for (const [path, content] of Object.entries(bytes)) if (path.startsWith('out/rig/')) files[`${EXAMPLE_DRAFT}/out/${path.slice('out/rig/'.length)}`] = content;
  return files;
}


export function newOrderExampleFiles(): Record<string, string> {
  return { ...exampleDraftFiles(), 'evidence/structure-decisions.json': readFileSync(join(import.meta.dir, '../templates/example-draft/evidence/structure-decisions.json'), 'utf8') };
}
