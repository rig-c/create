import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The repository's templates/ folder, read from the source tree. */
export const TEMPLATES_DIR = join(import.meta.dir, '..', 'templates');

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function readTemplate(relPath: string): JsonObject {
  const parsed: unknown = JSON.parse(readFileSync(join(TEMPLATES_DIR, relPath), 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`template ${relPath} is not a JSON object`);
  }
  return parsed as JsonObject;
}
