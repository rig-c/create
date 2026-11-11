import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectComments, type JobComment } from '@rig-c/review/job-host';
import { choiceVerbatim } from '../src/choices.ts';
import { decodePartsRead, partsVerdictNames } from '../src/parts-verdict-record.ts';
import { reviewSessionSource, selectedReviewFeedback } from '../src/review-read.ts';
import type { JsonObject } from '../src/templates.ts';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const cases = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/review-comments-v5-oracles.json'), 'utf8')) as { cases: JsonObject[] }).cases;
const oracle = (id: string): JsonObject => cases.find(item => item.id === id)!;

for (const [path, schema, expectedHash] of [
  ['rig-review-1.5.0/evidence/parts-review.json', 'rig-review-parts-verdict/1', '00a4bafd6a43679ff29c8bbbd410b162a6dddda48ac3539884b13f3d5d7b7819'],
  ['rig-review-parts-verdict-2/evidence/parts-review.json', 'rig-review-parts-verdict/2', 'd8fbb151589f3afe7aa57632b74392cc8e8a3f0b0e5d506a7ae908ad27230ba3'],
  ['rig-review-parts-verdict-2/evidence/parts-review-comments.json', 'rig-review-parts-verdict/2', '36df772c7f7b13b6d2b7d7802bff119b82a4e447db4e224eb3a8da55bb8ad619'],
] as const) {
  test(`legacy ${path} keeps its schema, raw fields and original bytes`, () => {
    const file = join(import.meta.dir, 'fixtures', path);
    const bytes = readFileSync(file);
    expect(sha256(bytes)).toBe(expectedHash);
    const decoded = decodePartsRead(bytes);
    expect(decoded.schema).toBe(schema);
    expect(decoded).toEqual(JSON.parse(bytes.toString('utf8')));
    expect(sha256(readFileSync(file))).toBe(expectedHash);
  });
}

test('legacy selected feedback retains the literal summary and single-build source', () => {
  const file = join(import.meta.dir, 'fixtures/review-read-session.json');
  const bytes = readFileSync(file);
  expect(sha256(bytes)).toBe('bd732ec78bd3f78d99ffee0079fdcb4ae386bac0b5d327db6a4200f194c31958');
  const session = JSON.parse(bytes.toString('utf8')) as JsonObject;
  const original = JSON.parse(bytes.toString('utf8')) as JsonObject;
  for (const item of session.feedback as JsonObject[]) {
    const selected = selectedReviewFeedback(session, String(item.id));
    expect(selected).toEqual([item]);
    expect(selected[0]!.summary).toBe(item.summary);
  }
  expect<unknown>(reviewSessionSource(session)).toEqual(session.reviewedSource);
  expect(session).toEqual(original);
  expect(readFileSync(file)).toEqual(bytes);
});

for (const id of ['legacy-choice-control', 'legacy-empty-note-control']) {
  test(`Create-owned v5 ${id} keeps literal survey assembly`, () => {
    const item = oracle(id);
    expect<unknown>(choiceVerbatim(item.legacy_picks as JsonObject[], item.legacy_note)).toBe(item.expected_legacy_verbatim);
  });
}

for (const id of ['legacy-parts-issues-precedence', 'legacy-parts-note-fallback']) {
  test(`Create-owned v5 ${id} retains the names branch`, () => {
    const item = oracle(id);
    const verdict: JsonObject = { schema: item.legacy_schema, parts: item.parts };
    if ('issues' in item) verdict.issues = item.issues;
    expect<unknown>(partsVerdictNames(verdict)).toEqual(item.expected_names);
  });
}

for (const id of ['ordered-general-and-image', 'empty-comments']) {
  test(`Review facade v5 projection ${id} matches the signed literal`, () => {
    const item = oracle(id);
    expect<unknown>(projectComments(item.comments as unknown as JobComment[])).toBe(item.expected_projection);
  });
}

test('v5 parts same action uses the same projection in each separate record', () => {
  const item = oracle('parts-same-action');
  const text = projectComments(item.comments as unknown as JobComment[]);
  expect<unknown>(text).toBe(item.expected_verdict_projection);
  expect<unknown>(text).toBe(item.expected_signoff_projection);
});

test('v5 later Apply keeps wording stable across capture identities', () => {
  const item = oracle('later-Apply-stable-wording');
  for (const anchor of [item.old_anchor, item.new_anchor]) {
    expect<unknown>(projectComments([{ text: item.text, anchor }] as unknown as JobComment[])).toBe(item.expected_old_and_new_projection);
  }
});

test('Review facade bounds the projected scalar and rejects blank fresh text', () => {
  expect(() => projectComments([{ text: ' ' }])).toThrow('JOB_ACT_INVALID');
  expect(() => projectComments([{ text: 'x'.repeat(10_000) }])).toThrow('JOB_ACT_INVALID');
});
