/** Stored API responses retain the supported producer schemas verbatim. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePartsRead, partsVerdictNames } from '../src/parts-verdict-record.ts';

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

test('rig-review-parts-verdict/4 decodes and partsVerdictNames returns deduplicated issue parts in encounter order', () => {
  const sha = 'a'.repeat(64);
  const baseV4 = {
    schema: 'rig-review-parts-verdict/4',
    mode: 'parts',
    tool: { name: '@rig-c/review', version: '2.8.0' },
    source: { sha256: sha, files: [{ path: 'parts.json', sha256: sha }] },
    updatedAt: '2026-11-10T00:00:00.000Z',
  };

  const approved = decodePartsRead(Buffer.from(JSON.stringify({ ...baseV4, status: 'approved', issues: [] })));
  expect(approved.schema).toBe('rig-review-parts-verdict/4');
  expect(partsVerdictNames(approved)).toEqual({ flagged: [], noted: [] });

  const changesRequested = decodePartsRead(
    Buffer.from(
      JSON.stringify({
        ...baseV4,
        status: 'changes-requested',
        issues: [
          {
            id: 'issue-1',
            summary: 'Shoulder seam gap',
            parts: [
              { name: 'arm_r', imageHash: sha },
              { name: 'torso', imageHash: sha },
            ],
            sourceHash: sha,
            rigRegion: { x: 0, y: 0, width: 10, height: 10 },
            imageRegion: null,
            view: { background: 'checker' },
            crop: { path: `comment-crops/${sha}.png`, sha256: sha, width: 10, height: 10 },
            nativeCrop: null,
          },
          {
            id: 'issue-2',
            summary: 'Torso and head fringe',
            parts: [
              { name: 'torso', imageHash: sha },
              { name: 'head', imageHash: sha },
            ],
            sourceHash: sha,
            rigRegion: { x: 5, y: 5, width: 8, height: 8 },
            imageRegion: { x: 1, y: 1, width: 8, height: 8 },
            view: { background: 'checker' },
            crop: { path: `comment-crops/${sha}.png`, sha256: sha, width: 8, height: 8 },
            nativeCrop: null,
          },
        ],
      }),
    ),
  );
  expect(partsVerdictNames(changesRequested)).toEqual({
    flagged: ['arm_r', 'torso', 'head'],
    noted: ['arm_r', 'torso', 'head'],
  });

  expect(() =>
    decodePartsRead(Buffer.from(JSON.stringify({ ...baseV4, status: 'approved', issues: changesRequested.issues }))),
  ).toThrow(expect.objectContaining({ code: 'PARTS_REVIEW_CLI_INVALID' }));
  expect(() =>
    decodePartsRead(Buffer.from(JSON.stringify({ ...baseV4, status: 'changes-requested', issues: [] }))),
  ).toThrow(expect.objectContaining({ code: 'PARTS_REVIEW_CLI_INVALID' }));
});
