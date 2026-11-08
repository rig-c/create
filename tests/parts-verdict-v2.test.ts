/** Stored API responses retain the supported producer schemas verbatim. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePartsRead } from '../src/parts-verdict-record.ts';

for (const [folder, file, schema, comments] of [
  ['rig-review-1.5.0', 'parts-review.json', 'rig-review-parts-verdict/1', undefined],
  ['rig-review-parts-verdict-2', 'parts-review.json', 'rig-review-parts-verdict/2', 0],
  ['rig-review-parts-verdict-2', 'parts-review-comments.json', 'rig-review-parts-verdict/2', 1],
] as const) {
  test(`${schema} ${file} remains an unmodified supported API response`, () => {
    const bytes = readFileSync(join(import.meta.dir, 'fixtures', folder, 'evidence', file));
    const value = decodePartsRead(bytes);
    expect(value.schema).toBe(schema);
    expect(value.status).toBe('approved');
    if (comments === undefined) expect(value.comments).toBeUndefined();
    else expect(value.comments).toHaveLength(comments);
    expect(value).toEqual(JSON.parse(bytes.toString('utf8')));
  });
}
