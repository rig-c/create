import { testClock } from './clock.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReview, retainedReviewRead, ReviewReadError, type ReviewReadRunner } from '../src/review-read.ts';
import { correctionCommand } from '../src/correction-writers.ts';
import { checkCorrections } from '../src/corrections.ts';
import { checkAppliedReview } from '../src/applied-review.ts';
import { Refusal } from '../src/refusal.ts';
import { correctionFixture } from './correction-fixture.ts';
import { capturedReviewSession, syntheticReviewRunner } from './review-read-fixture.ts';
import type { JsonObject } from '../src/templates.ts';
const roots: string[] = [];
afterEach(() => { testClock.reset(); for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true }); });
function fixture() { const dir = mkdtempSync(join(tmpdir(), 'review-read-')); roots.push(dir); correctionFixture(dir, 'rig'); return dir; }
const now = Date.parse('2026-11-08T12:00:00Z');
const capture = (dir: string, runner: ReviewReadRunner = syntheticReviewRunner, extra: string[] = []) => correctionCommand(['record', dir, '--id', 'api-change', '--path', 'made', '--stage', 'rig-review', '--version', '1', '--by', 'user', '--feedback-file', 'opaque-review-package', '--item', 'synthetic-apply', ...extra], now, runner);
function refused(dir: string, code: string, run: () => unknown) {
    const before = readFileSync(join(dir, 'project.json'));
    let caught = '';
    try {
        run();
    }
    catch (error) {
        if (!(error instanceof Refusal))
            throw error;
        caught = error.code;
    }
    expect(caught).toBe(code);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
test('captured browserless PUT response has all six applied fields', () => {
    const row = (capturedReviewSession.feedback as JsonObject[])[0]!;
    const applied = (row.context as JsonObject).applied as JsonObject;
    for (const field of ['patch', 'patchSha256', 'configHash', 'modelHash', 'check', 'files'])
        expect(applied[field]).toBeDefined();
});
test('opaque CLI argv and exact stdout are retained and checked without rerunning Review', () => {
    const dir = fixture();
    let calls = 0;
    const input = 'review package/--opaque';
    const result = readReview(dir, input, (cwd, argv) => { calls++; expect(cwd).toBe(dir); expect(argv).toEqual(['rig-review', 'feedback', input, '--format', 'json']); return syntheticReviewRunner(cwd, argv); });
    expect(retainedReviewRead(dir, result.receipt, result.file)).toEqual(result.value);
    expect(readFileSync(join(dir, String(result.file.path)))).toEqual(readFileSync(join(dir, 'evidence/feedback.json')));
    expect(calls).toBe(1);
});
for (const [name, runner] of [
    ['CLI failure', ((dir, argv) => ({ ...syntheticReviewRunner(dir, argv), exitCode: 1, stderr: 'synthetic refusal' })) as ReviewReadRunner],
    ['malformed JSON', ((dir, argv) => ({ ...syntheticReviewRunner(dir, argv), stdout: Buffer.from('{') })) as ReviewReadRunner],
    ['wrong schema', ((dir, argv) => ({ ...syntheticReviewRunner(dir, argv), stdout: Buffer.from('{"schema":"other","feedback":[]}') })) as ReviewReadRunner],
] as const)
    test(`${name} refuses without changing project bytes`, () => { const dir = fixture(); refused(dir, 'REVIEW_READ_INVALID', () => capture(dir, runner)); });
test('missing selected item refuses byte-identically', () => { const dir = fixture(); refused(dir, 'CORRECTION_APPLIED_INVALID', () => capture(dir, (cwd, argv) => { const result = syntheticReviewRunner(cwd, argv); const value = JSON.parse(result.stdout.toString()); value.feedback[0].id = 'other'; return { ...result, stdout: Buffer.from(JSON.stringify(value)) }; })); });
test('unapplied patch file has no capture route', () => { const dir = fixture(); refused(dir, 'CORRECTION_USAGE', () => correctionCommand(['record', dir, '--id', 'preview', '--path', 'made', '--stage', 'rig-review', '--version', '1', '--by', 'user', '--patch-file', 'evidence/preview.json', '--verbatim-file', join(dir, 'words.txt')], now, syntheticReviewRunner)); });
test('changed stored stdout and invalid receipt bindings refuse', () => {
    const dir = fixture();
    const read = readReview(dir, 'synthetic-review', syntheticReviewRunner);
    for (const receipt of [{ ...read.receipt, route: 'file' }, { ...read.receipt, argv: ['cat', 'saved-session.json'] }])
        expect(() => retainedReviewRead(dir, receipt)).toThrow(ReviewReadError);
    writeFileSync(join(dir, String(read.file.path)), '{}');
    expect(() => retainedReviewRead(dir, read.receipt)).toThrow(ReviewReadError);
});
test('symlinked response store refuses byte-identically', () => {
    const dir = fixture();
    rmSync(join(dir, 'evidence/review-reads'), { recursive: true });
    symlinkSync(join(dir, 'evidence'), join(dir, 'evidence/review-reads'));
    refused(dir, 'REVIEW_READ_INVALID', () => capture(dir));
});
test('legacy saved session and patch paths are never opened', () => {
    const dir = fixture();
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const on = { kind: 'rig', n: 1, config: ((project.versions as JsonObject[])[0]!.provenance as JsonObject).config, model: ((project.versions as JsonObject[])[0]!.outputs as JsonObject[])[0] };
    project.corrections = [{ schema: 'rig-create/correction@1', id: 'legacy', path: 'made', by: 'user', at: '2026-11-04T09:10:00Z', verbatim: 'Historical', stage: 'rig-review', on, artifact: { kind: 'config-patch', state: 'preview/pending', feedback: { file: { path: 'missing-saved-session.json', sha256: 'a'.repeat(64) }, item_id: 'missing' }, patch: { path: 'missing-saved-patch.json', sha256: 'b'.repeat(64) } }, outcome: null, resolves: null }];
    const origin = ((project.versions as JsonObject[])[1]!.review_origin as JsonObject);
    delete origin.review_read;
    origin.feedback = { path: 'missing-saved-session.json', sha256: 'a'.repeat(64) };
    const ctx = { dir, project, refusals: [] as {
            code: string;
            path: string;
            message: string;
        }[], warnings: [] as {
            code: string;
            path: string;
            message: string;
        }[] };
    checkCorrections(ctx, now);
    checkAppliedReview(ctx);
    expect(ctx.refusals).toEqual([]);
    expect(ctx.warnings.filter(row => row.code === 'REVIEW_READ_LEGACY')).toHaveLength(2);
});
test('current-day correction and applied-review records require their receipts', () => {
    const dir = fixture();
    capture(dir);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
    const artifact = ((project.corrections as JsonObject[])[0]!.artifact as JsonObject);
    delete artifact.review_read;
    const target = (project.versions as JsonObject[])[1]!;
    target.at = '2026-11-08T00:00:00Z';
    delete (target.review_origin as JsonObject).review_read;
    const ctx = { dir, project, refusals: [] as {
            code: string;
            path: string;
            message: string;
        }[], warnings: [] as {
            code: string;
            path: string;
            message: string;
        }[] };
    const before = readFileSync(join(dir, 'project.json'));
    checkCorrections(ctx, now);
    checkAppliedReview(ctx);
    expect(ctx.refusals.filter(row => row.code === 'REVIEW_READ_INVALID')).toHaveLength(2);
    expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('repeated reads reuse immutable stdout and remove staging files', () => {
    const dir = fixture();
    const first = readReview(dir, 'synthetic-review', syntheticReviewRunner);
    const second = readReview(dir, 'synthetic-review', syntheticReviewRunner);
    expect(second.file).toEqual(first.file);
    expect(readdirSync(join(dir, 'evidence/review-reads'))).toEqual([`${String(first.file.sha256)}.json`]);
});
