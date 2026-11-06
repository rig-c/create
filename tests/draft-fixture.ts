import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Synthetic draft artifacts use the same canonical inputs as the frozen review packages. */
import { exampleReviewBytes } from './review-fixture.ts';

export const EXAMPLE_DRAFT = 'derived/drafts/example';
export function exampleDraftFiles(input?: Record<string, Uint8Array>): Record<string, string | Uint8Array> {
  const bytes = exampleReviewBytes();
  const files: Record<string, string | Uint8Array> = { [`${EXAMPLE_DRAFT}/config.json`]: bytes['config.json'] as string };
  const root = join(import.meta.dir, '../templates/example-draft/input');
  const parts = input ?? Object.fromEntries(['parts.json', ...readdirSync(join(root, 'parts')).map(name => `parts/${name}`)].map(path => [path, readFileSync(join(root, path))]));
  for (const [path, content] of Object.entries(parts)) files[`${EXAMPLE_DRAFT}/input/${path}`] = content;
  for (const [path, content] of Object.entries(bytes)) if (path.startsWith('out/rig/')) files[`${EXAMPLE_DRAFT}/out/${path.slice('out/rig/'.length)}`] = content;
  return files;
}


export function newOrderExampleFiles(): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {...exampleDraftFiles()};
  const collect = (root: string, prefix: string): void => {
    for (const entry of readdirSync(root,{withFileTypes:true})) {
      const path = join(root,entry.name); const dest = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) collect(path,dest); else files[dest] = entry.name.endsWith('.png') ? readFileSync(path) : readFileSync(path,'utf8');
    }
  };
  collect(join(import.meta.dir,'../templates/example-draft/evidence'),'evidence');
  collect(join(import.meta.dir,'../templates/example-draft/derived/parts'),'derived/parts');
  collect(join(import.meta.dir,'../templates/example-interview-options'),'evidence/interview');
  return files;
}
