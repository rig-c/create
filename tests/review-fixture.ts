import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Synthetic producer bytes shipped with the filled example, relative to a review package. */
export function exampleReviewBytes(): Record<string, string> {
  const root = join(import.meta.dir, '..', 'templates', 'example-review');
  const files: Record<string, string> = {};
  const read = (path: string): void => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) read(child);
      else files[child] = readFileSync(join(root, child), 'utf8');
    }
  };
  read('');
  return files;
}

/** Materialize both declared frozen sources and their package copies for the two example rigs. */
export function reviewExampleFiles(): Record<string, string> {
  const bytes = exampleReviewBytes();
  const files: Record<string, string> = {};
  for (const n of [1, 2]) {
    for (const [path, content] of Object.entries(bytes)) {
      files[`derived/review/v${n}/${path}`] = content;
      files[path === 'config.json' ? `evidence/v${n}/review-config.json` : `outputs/v${n}/${path}`] = content;
    }
  }
  return files;
}
