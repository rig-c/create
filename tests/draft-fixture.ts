import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Materialize the retained synthetic draft separately from the review controls. */

export const EXAMPLE_DRAFT = 'derived/drafts/example';
/** The retained parts-stage check report the example's parts → parts-review move binds. */
export const EXAMPLE_PARTS_CHECK = 'evidence/parts-check.json';

/** parts.json, parts/* and the painting parts.json declares under painting_in_rig; nothing undeclared. */
export function retainedPartsFiles(root: string): Record<string, Uint8Array> {
  const manifest = JSON.parse(readFileSync(join(root, 'parts.json'), 'utf8')) as { painting_in_rig?: { path?: unknown } };
  const painting = typeof manifest.painting_in_rig?.path === 'string' ? [manifest.painting_in_rig.path] : [];
  return Object.fromEntries(['parts.json', ...painting, ...readdirSync(join(root, 'parts')).map(name => `parts/${name}`)].map(path => [path, readFileSync(join(root, path))]));
}
export function exampleDraftFiles(input?: Record<string, Uint8Array>, output?: Record<string, Uint8Array>): Record<string, string | Uint8Array> {
  const files: Record<string, string | Uint8Array> = {};
  const root = join(import.meta.dir, '../templates/example-draft/input');
  const parts = input ?? retainedPartsFiles(root);
  for (const [path, content] of Object.entries(parts)) files[`${EXAMPLE_DRAFT}/input/${path}`] = content;
  const collect = (path: string): void => {
    for (const entry of readdirSync(join(root, '..', path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) collect(child);
      else files[`${EXAMPLE_DRAFT}/${child}`] = readFileSync(join(root, '..', child));
    }
  };
  if (output) {
    for (const [path, content] of Object.entries(output)) files[`${EXAMPLE_DRAFT}/${path}`] = content;
  } else {
    files[`${EXAMPLE_DRAFT}/config.json`] = readFileSync(join(root, '../config.json'));
    files[`${EXAMPLE_DRAFT}/interview-requirements.json`] = readFileSync(join(root, '../interview-requirements.json'));
    collect('out');
  }
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
  collect(join(import.meta.dir,'../templates/example-draft/inputs'),'inputs');
  collect(join(import.meta.dir,'../templates/example-draft/evidence'),'evidence');
  collect(join(import.meta.dir,'../templates/example-draft/derived'),'derived');
  collect(join(import.meta.dir,'../templates/example-draft/outputs'),'outputs');
  collect(join(import.meta.dir,'../templates/example-interview-options'),'evidence/interview');
  return files;
}
