/** CLI injection uses synthetic response bytes, never Review's private state. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReview, type ReviewReadRunner } from '../src/review-read.ts';
import type { JsonObject } from '../src/templates.ts';
export const capturedReviewSession = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/review-read-session.json'), 'utf8')) as JsonObject;
export const syntheticReviewRunner: ReviewReadRunner = (dir) => ({
    stdout: readFileSync(join(dir, 'evidence/feedback.json')),
    stderr: '', exitCode: 0, tool: { name: '@rig-c/review', version: '2.5.0' },
});
export function syntheticReviewOrigin(dir: string, sourceVersion: number, item: string, applied: JsonObject): JsonObject {
    const read = readReview(dir, 'synthetic-review', syntheticReviewRunner);
    return { feedback: read.file, review_read: read.receipt, source_version: sourceVersion, feedback_id: item, applied };
}
