import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Actual synthetic source and prepared bytes shipped with the filled example. */
export function preparedExampleFiles(): Record<string, string> {
  const dir = join(import.meta.dir, '..', 'templates', 'example-prepared');
  return {
    'inputs/preparation-source.svg': readFileSync(join(dir, 'source.svg'), 'utf8'),
    'derived/prepared.svg': readFileSync(join(dir, 'prepared.svg'), 'utf8'),
  };
}
