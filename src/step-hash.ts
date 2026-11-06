import { createHash } from 'node:crypto';

import type { Json, JsonObject } from './templates.ts';

const FIELDS = ['id', 'phase', 'order', 'does', 'produces', 'rests_on', 'bar', 'checkpoint_proposed', 'checkpoint'] as const;

export function sorted(value: Json): Json {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

/** SHA-256 of the present approval fields, recursively key-sorted JSON, encoded as UTF-8. */
export function stepHash(step: JsonObject): string {
  const fields = Object.fromEntries(FIELDS.filter((key) => key in step).map((key) => [key, step[key]]));
  return createHash('sha256').update(JSON.stringify(sorted(fields))).digest('hex');
}
