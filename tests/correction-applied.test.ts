import { syntheticReviewRunner, syntheticReviewOrigin } from './review-read-fixture.ts';
import { Refusal } from '../src/refusal.ts';
/** Synthetic values in review's published applied/2 serializer shape, not producer measurements. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '../src/templates.ts';
import { correctionHash } from '../src/corrections.ts';
import { checkAppliedReview } from '../src/applied-review.ts';
import { readReview, retainedReviewRead, reviewSessionSource, selectedReviewFeedback, type ReviewReadRunner } from '../src/review-read.ts';
import { parseCommentsSession, parseCommentsCompareSession, projectSelectedCommentsFeedback } from '@rig-c/review/job-host';
import { correctionFixture, correctionCommentsFixture, commentsComparison, commentsReviewRunner, COMMENTS_APPLY_ID } from './correction-fixture.ts';
import { checkCorrections, correctionCommand, TEST_NOW, testClock } from './clock.ts';

const roots: string[] = [];
afterEach(() => {
  testClock.reset();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(change: (applied: JsonObject) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'correction-applied-'));
  roots.push(dir);
  correctionFixture(dir, 'rig');
  const file = join(dir, 'evidence/feedback.json');
  const session = JSON.parse(readFileSync(file, 'utf8'));
  const original = session.feedback[0].context.applied;
  // review src/applied-context.ts: applied/2 exact key list with stageInputHash present.
  const applied: JsonObject = {
    stageInputHash: 'a'.repeat(64), buildId: original.buildId, check: original.check,
    compiler: original.compiler, configHash: original.configHash, diff: original.diff,
    line: original.line, modelHash: original.modelHash, patch: original.patch,
    patchSha256: original.patchSha256, producer: original.producer, schema: original.schema,
  };
  change(applied);
  session.feedback[0].context.applied = applied;
  writeFileSync(file, JSON.stringify(session, null, 2) + '\n');
  const projectFile = join(dir, 'project.json');
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  project.versions[1].review_origin.applied = applied;
  project.versions[1].review_origin = syntheticReviewOrigin(dir,1,'synthetic-apply',applied);
  writeFileSync(projectFile, JSON.stringify(project, null, 2) + '\n');
  return dir;
}
function command(dir: string, action: 'record' | 'resolve', runner: ReviewReadRunner = syntheticReviewRunner, item = 'synthetic-apply') {
  const args = action === 'record'
    ? ['record', dir, '--id', 'fix', '--path', 'made', '--stage', 'rig-review', '--by', 'user', '--version', '1', '--feedback-file', 'evidence/feedback.json', '--item', item]
    : ['resolve', 'fix', dir, '--by', 'agent', '--reasoning-file', join(dir, 'reasoning.txt'), '--version', '2'];
  // Capture, the corrected build and closure happen one second apart, in that order.
  testClock.set(TEST_NOW + (action === 'record' ? 0 : 2000));
  let result: {exitCode:number;stdout:Buffer;stderr:Buffer};
  try {
    const value=correctionCommand(args,runner);
    result={exitCode:value.exit,stdout:Buffer.from(value.stdout),stderr:Buffer.from('')};
  } catch(error) {
    if(!(error instanceof Refusal))throw error;
    result={exitCode:error.exitCode,stdout:Buffer.from(''),stderr:Buffer.from(error.code+' '+error.message)};
  }
  if (action === 'record' && result.exitCode === 0) {
    // The synthetic corrected build is declared after the request.
    const file = join(dir, 'project.json');
    const project = JSON.parse(readFileSync(file, 'utf8'));
    testClock.set(TEST_NOW + 1000);
    project.versions[1].at = testClock.iso();
    writeFileSync(file, JSON.stringify(project, null, 2) + '\n');
  }
  return result;
}
function refused(dir: string, action: 'record' | 'resolve', code: string) {
  const before = readFileSync(join(dir, 'project.json'));
  const result = command(dir, action);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}
for (const field of ['stageInputHash', 'check.source']) {
  test(`published ${field} records and resolves through the writer with an injected CLI read`, () => {
    const dir = fixture(applied => {
      if (field === 'check.source') {
        delete applied.stageInputHash;
        (applied.check as JsonObject).source = 'check';
      }
    });
    const record = command(dir, 'record');
    console.log(`${field} record exit=${record.exitCode}`);
    expect(record.exitCode).toBe(0);
    const resolve = command(dir, 'resolve');
    console.log(`${field} resolve exit=${resolve.exitCode} ${resolve.stderr.toString()}`);
    expect(resolve.exitCode).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const ctx = { dir, project, refusals: [], warnings: [] };
    checkCorrections(ctx);
    expect(ctx).toMatchObject({ refusals: [], warnings: [] });
  });
}
for (const value of [null, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 7]) {
  test(`malformed stageInputHash ${JSON.stringify(value)} refuses capture`, () => {
    const dir = fixture(applied => { applied.stageInputHash = value; });
    refused(dir, 'record', 'CORRECTION_APPLIED_INVALID');
  });
}
test('unknown applied field refuses capture', () => {
  const dir = fixture(applied => { delete applied.stageInputHash; applied.unknown = true; });
  refused(dir, 'record', 'CORRECTION_APPLIED_INVALID');
});
for (const field of ['pass', 'exitCode', 'gate', 'bars', 'line', 'absent', 'source']) {
  test(`source check with invalid ${field} refuses closure`, () => {
    const dir = fixture(applied => {
      delete applied.stageInputHash;
      const summary = applied.check as JsonObject;
      summary.source = 'check';
      if (field === 'absent') applied.check = null;
      else summary[field] = ({ pass: false, exitCode: 1, gate: false, bars: { SYNTHETIC: 'FAIL' }, line: '', source: 'unknown' } as JsonObject)[field]!;
    });
    expect(command(dir, 'record').exitCode).toBe(0);
    refused(dir, 'resolve', 'CORRECTION_APPLIED_INVALID');
  });
}
for (const schema of ['rig-review-applied/4', 'rig-review-applied/5']) {
  test(`${schema} stays unsupported`, () => {
    const dir = fixture(applied => { delete applied.stageInputHash; applied.schema = schema; });
    expect(command(dir, 'record').exitCode).toBe(0);
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(project.corrections[0].artifact).toMatchObject({ kind: 'unsupported', operation: 'other', producer_schema: schema });
    refused(dir, 'resolve', 'CORRECTION_UNSUPPORTED_OUTCOME');
  });
}

// Byte-sliced producer summary, deep-equal to the source value at extraction.
// Enclosing session sha256 4ef11e9be13300323e1513575a06b4deedea4433e2b90a0752a116245e404da1.
const realShape: JsonObject = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/correction-path/producer-check-summary.json'), 'utf8'));
test('producer-shaped mixed statuses resolve and retain coverage verbatim', () => {
  const dir = fixture(applied => { applied.check = structuredClone(realShape); });
  const feedback = readFileSync(join(dir, 'evidence/feedback.json'));
  expect(command(dir, 'record').exitCode).toBe(0);
  const result = command(dir, 'resolve');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('3 PASS bar(s) in the summary map');
  expect(result.stdout.toString()).toContain('RECOMPOSITE_HOLES=SKIP');
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  expect(project.corrections[0].closure.reasoning).toContain('PART_SUPPORT_REPORT=UNCLASSIFIED');
  expect(readFileSync(join(dir, 'evidence/feedback.json'))).toEqual(feedback);
  const ctx = { dir, project, refusals: [], warnings: [] };
  checkCorrections(ctx);
  expect(ctx).toMatchObject({ refusals: [], warnings: [] });
});
for (const status of ['WARN', 'CLEAR', 'REPORTED']) {
  test(`producer ${status} is retained through resolution`, () => {
    const summary = structuredClone(realShape);
    (summary.bars as JsonObject).REPORT = status;
    const dir = fixture(applied => { applied.check = summary; });
    expect(command(dir, 'record').exitCode).toBe(0);
    const result = command(dir, 'resolve');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`REPORT=${status}`);
  });
}
for (const [name, bars] of Object.entries({
  fail: { gate: 'PASS', BROKEN: 'FAIL' },
  unknown: { gate: 'PASS', UNKNOWN_BAR: 'NEW_STATUS' },
  noPass: { EMPTY_BAR: 'SKIP', REPORT: 'UNCLASSIFIED' },
  empty: {},
  rewritten: { ...(realShape.bars as JsonObject), BLINK_NO_HOLE: 'PASS' },
})) {
  test(`producer summary ${name} refuses without writing`, () => {
    const dir = fixture(applied => { applied.check = { ...realShape, bars: bars as JsonObject }; });
    expect(command(dir, 'record').exitCode).toBe(0);
    refused(dir, 'resolve', 'CORRECTION_APPLIED_INVALID');
  });
}

const commentsOracles = (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/review-comments-v5-oracles.json'), 'utf8')) as { cases: JsonObject[] }).cases;
const standaloneOracle = commentsOracles.find(row => row.id === 'standalone-new-comment-reader')!;
const wordingOracle = commentsOracles.find(row => row.id === 'later-Apply-stable-wording')!;
function commentsFixture(change?: (session: JsonObject) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'correction-comments-'));
  roots.push(dir);
  return { dir, ...correctionCommentsFixture(dir, change) };
}
function commentsApplied(session: JsonObject): JsonObject {
  const selected = (session.comments as JsonObject[]).find(comment => (comment.anchor as JsonObject | undefined)?.id === COMMENTS_APPLY_ID)!;
  return ((selected.anchor as JsonObject).context as JsonObject).applied as JsonObject;
}
function refusedComments(dir: string, code: string, item = COMMENTS_APPLY_ID, runner = commentsReviewRunner) {
  const before = readFileSync(join(dir, 'project.json'));
  const result = command(dir, 'record', runner, item);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString().split(' ')[0]).toBe(code);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
}

test('session/2 full applied frame anchor matches Review 2.12.0 parser/projector and the signed v5 oracle', () => {
  const f = commentsFixture();
  const before = structuredClone(f.session);
  const parsed = parseCommentsSession(f.session);
  expect<unknown>(parsed).toEqual(f.session);
  expect(f.session.schema).toBe(standaloneOracle.schema);
  expect<unknown>(COMMENTS_APPLY_ID).toBe(standaloneOracle.selected_anchor_id);
  const projected = projectSelectedCommentsFeedback(parsed, COMMENTS_APPLY_ID);
  expect<unknown>(projected.summary).toBe(wordingOracle.expected_old_and_new_projection);
  expect(projected.anchor).toMatchObject({ ...wordingOracle.old_anchor as JsonObject, id: COMMENTS_APPLY_ID, context: { applied: f.applied } });
  // The oracle's old capture ID is incidental; the selected ID is the standalone reader contract.
  expect(projected.anchor.id).toBe(COMMENTS_APPLY_ID);
  expect<unknown>(selectedReviewFeedback(f.read.value, COMMENTS_APPLY_ID)).toEqual([{ ...projected.anchor, summary: projected.summary }]);
  expect(selectedReviewFeedback(f.read.value, 'absent-feedback')).toEqual([]);
  expect<unknown>(reviewSessionSource(f.read.value)).toEqual(f.session.reviewedSource);
  expect(f.session.feedback).toBeUndefined();
  expect(f.session).toEqual(before);
  expect(f.read.receipt.tool).toEqual({ name: '@rig-c/review', version: '2.12.0' });
  expect(f.read.file.sha256).toBe('e5c8d6bce22f4d2d0e71d466127a9b5690d6f7f45a1f090e56e15e8f0c8db0df');
  expect(readFileSync(join(f.dir, String(f.read.file.path)))).toEqual(f.stdout);
  expect(retainedReviewRead(f.dir, f.read.receipt, f.read.file)).toEqual(f.session);
});

test('session/2 feedback-file writer retains selected applied identity and exact stdout through resolution and checks', () => {
  const f = commentsFixture();
  let calls = 0;
  const runner: ReviewReadRunner = (dir, argv) => {
    calls++;
    expect(argv).toEqual(['rig-review', 'feedback', 'evidence/feedback.json', '--format', 'json']);
    return commentsReviewRunner(dir, argv);
  };
  expect(command(f.dir, 'record', runner, COMMENTS_APPLY_ID).exitCode).toBe(0);
  let project = JSON.parse(readFileSync(join(f.dir, 'project.json'), 'utf8')) as JsonObject;
  const record = (project.corrections as JsonObject[])[0]!;
  const source = (project.versions as JsonObject[])[0]!;
  expect(record).toMatchObject({ by: 'user', verbatim: wordingOracle.expected_old_and_new_projection,
    on: { kind: 'rig', n: 1, config: (source.provenance as JsonObject).config,
      model: { path: 'derived/review/v1/out/check/build/skeleton.model.json', sha256: ((source.outputs as JsonObject[])[0] as JsonObject).sha256 } },
    artifact: { kind: 'config-patch', state: 'preview/pending', feedback: { file: f.read.file, item_id: COMMENTS_APPLY_ID }, review_read: f.read.receipt }, outcome: null });
  const open = { dir: f.dir, project, refusals: [], warnings: [] };
  checkCorrections(open);
  expect(open).toMatchObject({ refusals: [], warnings: [{ code: 'CORRECTION_OPEN' }] });
  expect(command(f.dir, 'resolve', runner, COMMENTS_APPLY_ID).exitCode).toBe(0);
  project = JSON.parse(readFileSync(join(f.dir, 'project.json'), 'utf8')) as JsonObject;
  const ctx = { dir: f.dir, project, refusals: [], warnings: [] };
  checkCorrections(ctx);
  checkAppliedReview(ctx);
  expect(ctx).toMatchObject({ refusals: [], warnings: [] });
  expect((project.versions as JsonObject[])[1]!.review_origin).toEqual({ feedback: f.read.file, review_read: f.read.receipt, source_version: 1, feedback_id: COMMENTS_APPLY_ID, applied: f.applied });
  expect((project.corrections as JsonObject[])[0]!).toMatchObject({ artifact: { state: 'applied-and-checked' }, outcome: { n: 2, model: { sha256: f.applied.modelHash } } });
  expect(readFileSync(join(f.dir, String(f.read.file.path)))).toEqual(f.stdout);
  expect<unknown>(correctionHash(readFileSync(join(f.dir, String(f.read.file.path))))).toBe(f.read.file.sha256);
  expect(readFileSync(join(f.dir, 'evidence/feedback.json'))).toEqual(f.stdout);
  expect(calls).toBe(1); // Resolve/check consume retained bytes; they do not rerun Review.
});

test('session/2 retains an opaque producer patchSha256 claim without remeasuring it', () => {
  const f = commentsFixture(session => { commentsApplied(session).patchSha256 = 'f'.repeat(64); });
  expect(command(f.dir, 'record', commentsReviewRunner, COMMENTS_APPLY_ID).exitCode).toBe(0);
  expect(command(f.dir, 'resolve', commentsReviewRunner, COMMENTS_APPLY_ID).exitCode).toBe(0);
  const project = JSON.parse(readFileSync(join(f.dir, 'project.json'), 'utf8')) as JsonObject;
  const ctx = { dir: f.dir, project, refusals: [], warnings: [] };
  checkCorrections(ctx);
  checkAppliedReview(ctx);
  expect(ctx).toMatchObject({ refusals: [], warnings: [] });
  expect(((project.versions as JsonObject[])[1]!.review_origin as JsonObject).applied).toEqual(f.applied);
  expect(f.applied.patchSha256).toBe('f'.repeat(64));
});

for (const [name, change] of [
  ['inspected model', (s: JsonObject) => { ((s.reviewedSource as JsonObject).rig as JsonObject).sha256 = 'c'.repeat(64); }],
  ['handoff config', (s: JsonObject) => { (((s.reviewedSource as JsonObject).handoff as JsonObject).config as JsonObject).sha256 = 'c'.repeat(64); }],
  ['patch config', (s: JsonObject) => { (commentsApplied(s).patch as JsonObject).config_sha256 = 'c'.repeat(64); }],
  ['patch producer', (s: JsonObject) => { ((commentsApplied(s).patch as JsonObject).producer as JsonObject).version = '0.0.0-other'; }],
] as const) {
  test(`session/2 changed ${name} binding refuses capture by code without a project write`, () => {
    const f = commentsFixture(change);
    refusedComments(f.dir, 'CORRECTION_APPLIED_INVALID');
  });
}
for (const field of ['buildId', 'patch', 'patchSha256', 'configHash', 'producer', 'compiler', 'line', 'check', 'diff', 'modelHash']) {
  test(`session/2 incomplete applied identity without ${field} refuses without writing`, () => {
    const f = commentsFixture(session => { delete commentsApplied(session)[field]; });
    refusedComments(f.dir, 'CORRECTION_APPLIED_INVALID');
  });
}
test('session/2 missing selected anchor refuses instead of selecting another applied comment', () => {
  const f = commentsFixture();
  refusedComments(f.dir, 'CORRECTION_APPLIED_INVALID', 'absent-feedback');
});
test('codec-valid compare-session/2 applied frame anchors stay outside correction Apply', () => {
  const f = commentsFixture();
  const comparison = commentsComparison(f.session);
  expect<unknown>(parseCommentsCompareSession(comparison)).toEqual(comparison);
  const stdout = Buffer.from(JSON.stringify(comparison, null, 3) + '\n');
  const runner: ReviewReadRunner = () => ({ stdout, stderr: '', exitCode: 0, tool: { name: '@rig-c/review', version: '2.12.0' } });
  const read = readReview(f.dir, 'synthetic-comparison', runner);
  expect(readFileSync(join(f.dir, String(read.file.path)))).toEqual(stdout);
  expect(read.file.sha256).toBe(correctionHash(stdout));
  expect(reviewSessionSource(read.value)).toBeNull();
  expect(selectedReviewFeedback(read.value, COMMENTS_APPLY_ID)).toEqual([]);
  refusedComments(f.dir, 'CORRECTION_APPLIED_INVALID', COMMENTS_APPLY_ID, runner);
});
