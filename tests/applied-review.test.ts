import { readReview, retainedReviewRead } from '../src/review-read.ts';
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkAppliedReview } from '../src/applied-review.ts';
import { type JsonObject } from '../src/templates.ts';
import { fixture, obj, version } from './fixtures.ts';
import { run } from './helpers.ts';
import { checkProject } from './clock.ts';
import { commentsComparison, correctionCommentsFixture, COMMENTS_APPLY_ID } from './correction-fixture.ts';
import { parseCommentsSession, parseCommentsCompareSession, projectSelectedCommentsFeedback } from '@rig-c/review/job-host';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
function checked(dir: string, project: JsonObject) {
  const ctx = { dir, project, refusals: [] as { code: string; path: string; message: string }[], warnings: [] as { code: string; path: string; message: string }[] };
  checkAppliedReview(ctx);
  return ctx;
}

async function chain(template = 'legacy-example-project.json'): Promise<{ dir: string; project: JsonObject }> {
  const root = mkdtempSync(join(tmpdir(), 'applied-'));
  roots.push(root);
  const dir = fixture(() => {}, template);
  // The shared example fixture owns its own temporary project root.
  roots.push(join(dir, '..'));
  const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
  const applied = {
    schema: 'rig-review-applied/1', buildId: 'a'.repeat(64), part: 'piece', regions: [],
    configHash: obj(obj(version(project, 1).review_package).config).sha256 as string,
    entrySha256: sha('[]'), modelHash: 'b'.repeat(64),
    producer: { package: '@rig-c/parts', version: '2.4.1' },
    compiler: { package: '@rig-c/core', version: '0.0.0' }, line: null,
  };
  const state = join(root, 'state');
  const seeded = run([process.execPath, '-e', `
    import { loadReview } from ${JSON.stringify(join(import.meta.dir, '../node_modules/@rig-c/review/src/manifest.ts'))};
    import { freshSession, saveSession } from ${JSON.stringify(join(import.meta.dir, '../node_modules/@rig-c/review/src/session.ts'))};
    const pkg = await loadReview(${JSON.stringify(join(dir, 'derived/review/v1/out'))});
    const session = freshSession(pkg);
    session.feedback = [{ id: 'apply-1', frameStart: 0, frameEnd: 0,
      target: { kind: 'rig', name: pkg.feedbackCatalog.rig }, category: 'quality',
      summary: 'Keep the applied regions.', context: { applied: ${JSON.stringify(applied)} } }];
    await saveSession(pkg, session, ${JSON.stringify(state)});
  `], dir, { ...process.env } as Record<string, string>);
  expect(seeded.stderr).toBe('');
  expect(seeded.code).toBe(0);
  const exported = run([process.execPath, join(import.meta.dir, '../node_modules/.bin/rig-review'), 'feedback', join(dir, 'derived/review/v1/out')], dir, { ...process.env, RIG_REVIEW_STATE_DIR: state } as Record<string, string>);
  expect(exported.stderr).toBe('');
  expect(exported.code).toBe(0);
  const feedback = JSON.parse(exported.stdout);
  expect(feedback.feedback[0].context.applied).toEqual(applied);
  writeFileSync(join(dir, 'evidence/applied-feedback.json'), exported.stdout);
  const read=readReview(dir,'synthetic-review',()=>({stdout:Buffer.from(exported.stdout),stderr:'',exitCode:0,tool:{name:'@rig-c/review',version:'2.5.0'}}));
  version(project, 2).review_origin = { feedback: read.file, review_read: read.receipt, source_version: 1, feedback_id: 'apply-1', applied };
  return { dir, project };
}

test('installed rig-review writes feedback that resolves to the recorded next version', async () => {
  const { dir, project } = await chain();
  expect(checked(dir, project)).toMatchObject({ refusals: [], warnings: [] });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'PARTS_VERDICT_FILE_LEGACY', 'STAGE_ORDER_LEGACY', 'INPUT_WRITER_MISSING', 'CHOICE_ANSWERS_LEGACY', 'CORRECTION_PATH_LEGACY']);
});

for (const [name, code, mutate] of [
  ['feedback hash', 'REVIEW_READ_INVALID', (r: JsonObject) => { obj(r.feedback).sha256 = '0'.repeat(64); }],
  ['missing feedback', 'REVIEW_READ_INVALID', (r: JsonObject) => { obj(r.feedback).path = 'evidence/missing.json'; }],
  ['unknown source', 'APPLIED_REVIEW_SOURCE', (r: JsonObject) => { r.source_version = 99; }],
  ['self source', 'APPLIED_REVIEW_SOURCE', (r: JsonObject) => { r.source_version = 2; }],
  ['missing applied item', 'APPLIED_REVIEW_RESULT', (r: JsonObject) => { r.feedback_id = 'missing'; }],
  ['changed applied result', 'APPLIED_REVIEW_RESULT', (r: JsonObject) => { obj(r.applied).modelHash = 'c'.repeat(64); }],
  ['wrong config source', 'APPLIED_REVIEW_SOURCE', (r: JsonObject) => { obj(r.applied).configHash = 'd'.repeat(64); }],
  ['null applied result', 'APPLIED_REVIEW_MALFORMED', (r: JsonObject) => { r.applied = null; }],
  ['escaping feedback path', 'APPLIED_REVIEW_MALFORMED', (r: JsonObject) => { obj(r.feedback).path = '../feedback.json'; }],
] as const) {
  test(`refuses a broken ${name} link`, async () => {
    const { dir, project } = await chain();
    mutate(obj(version(project, 2).review_origin));
    expect(checked(dir, project).refusals.map((f) => f.code)).toContain(code);
  });
}

test('refuses skipping an intermediate rig version', async () => {
  const { dir, project } = await chain();
  const next = version(project, 2);
  next.n = 4;
  (project.versions as JsonObject[]).push({ n: 2, kind: 'rig', review_origin: null });
  expect(checked(dir, project).refusals.map((f) => f.code)).toContain('APPLIED_REVIEW_SOURCE');
});

test('manual builds declare null, old missing declarations only warn', () => {
  const project: JsonObject = { versions: [{ n: 1, kind: 'rig', at: '2026-11-05', review_origin: null }] };
  expect(checked('.', project)).toMatchObject({ refusals: [], warnings: [] });
  const v = (project.versions as JsonObject[])[0]!;
  delete v.review_origin;
  expect(checked('.', project).warnings[0]?.code).toBe('APPLIED_REVIEW_LEGACY');
  v.at = '2026-11-06T00:00:00Z';
  expect(checked('.', project).refusals[0]?.code).toBe('APPLIED_REVIEW_MISSING');
  v.pre_interview = true;
  expect(checked('.', project)).toMatchObject({ refusals: [], warnings: [] });
});

for (const [name, code, mutate] of [
  ['export schema', 'REVIEW_READ_INVALID', (f: JsonObject) => { f.schema = 'other'; }],
  ['inspected model', 'APPLIED_REVIEW_SOURCE', (f: JsonObject) => { obj(obj(f.reviewedSource).rig).sha256 = 'e'.repeat(64); }],
  ['handoff input', 'APPLIED_REVIEW_SOURCE', (f: JsonObject) => { obj((obj(obj(f.reviewedSource).handoff).files as JsonObject[])[0]).sha256 = 'f'.repeat(64); }],
  ['omitted handoff input', 'APPLIED_REVIEW_SOURCE', (f: JsonObject) => { const h = obj(obj(f.reviewedSource).handoff); h.files = (h.files as JsonObject[]).filter((e) => !String(e.path).endsWith('interview-requirements.json')); }],
  ['missing applied context', 'APPLIED_REVIEW_RESULT', (f: JsonObject) => { obj((f.feedback as JsonObject[])[0]).context = {}; }],
  ['duplicate feedback id', 'APPLIED_REVIEW_RESULT', (f: JsonObject) => { (f.feedback as JsonObject[]).push((f.feedback as JsonObject[])[0]!); }],
] as const) {
  test(`refuses changed ${name} even with an updated file hash`, async () => {
    const { dir, project } = await chain(name === 'omitted handoff input' ? 'example-project.json' : undefined);
    const record = obj(version(project, 2).review_origin);
    const file = join(dir, obj(record.feedback).path as string);
    const feedback = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    mutate(feedback);
    const bytes = JSON.stringify(feedback);
    const binding={path:`evidence/review-reads/${sha(bytes)}.json`,sha256:sha(bytes)};
    writeFileSync(join(dir,binding.path),bytes);
    record.feedback=binding;
    obj(record.review_read).stdout=binding;
    const refusals = checked(dir, project).refusals;
    expect(refusals.map((f) => f.code)).toContain(code);
    if (name === 'omitted handoff input') expect(refusals[0]?.message).toContain('interview-requirements.json');
  });
}


test('installed review hashes every named input for the current signed example', async () => {
  const { dir, project } = await chain('example-project.json');
  expect(checked(dir, project)).toMatchObject({ refusals: [], warnings: [] });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test('edited live config leaves the frozen legacy applied-review findings unchanged', async () => {
  const { dir, project } = await chain();
  const before = checked(dir, project);
  const config = obj(obj(version(project, 1).review_package).config);
  writeFileSync(join(dir, String(config.path)), '{"note":"edited live config"}');
  const after = checked(dir, project);
  console.log('frozen-config-control', JSON.stringify({ before: before.refusals, after: after.refusals }));
  expect(after).toEqual(before);
});

function commentsChain(change?: (session: JsonObject) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'applied-comments-'));
  roots.push(dir);
  return { dir, ...correctionCommentsFixture(dir, change) };
}

test('session/2 applied-review accepts the selected full applied/2 context with unchanged stdout', () => {
  const f = commentsChain();
  const before = readFileSync(join(f.dir, 'project.json'));
  const selected = projectSelectedCommentsFeedback(parseCommentsSession(f.session), COMMENTS_APPLY_ID);
  expect(version(f.project, 2).review_origin).toEqual({
    feedback: f.read.file, review_read: f.read.receipt, source_version: 1,
    feedback_id: COMMENTS_APPLY_ID, applied: obj(selected.anchor.context).applied,
  });
  expect(checked(f.dir, f.project)).toMatchObject({ refusals: [], warnings: [] });
  expect(retainedReviewRead(f.dir, f.read.receipt, f.read.file)).toEqual(f.session);
  expect(readFileSync(join(f.dir, String(f.read.file.path)))).toEqual(f.stdout);
  expect<unknown>(sha(f.stdout.toString('utf8'))).toBe(f.read.file.sha256);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
});

for (const [name, change] of [
  ['inspected model', (s: JsonObject) => { obj(obj(s.reviewedSource).rig).sha256 = 'c'.repeat(64); }],
  ['model path', (s: JsonObject) => { obj(obj(s.reviewedSource).rig).path = 'other.model.json'; }],
  ['handoff config', (s: JsonObject) => { obj(obj(obj(s.reviewedSource).handoff).config).sha256 = 'c'.repeat(64); }],
  ['handoff input', (s: JsonObject) => { (obj(obj(s.reviewedSource).handoff).files as JsonObject[])[0]!.sha256 = 'c'.repeat(64); }],
] as const) {
  test(`session/2 applied-review refuses changed ${name} source binding despite a fresh valid stdout hash`, () => {
    const f = commentsChain(change);
    const before = readFileSync(join(f.dir, 'project.json'));
    expect(checked(f.dir, f.project).refusals.map(finding => finding.code)).toEqual(['APPLIED_REVIEW_SOURCE']);
    expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
    expect(readFileSync(join(f.dir, String(f.read.file.path)))).toEqual(f.stdout);
  });
}

for (const [name, change] of [
  ['selected anchor ID', (r: JsonObject) => { r.feedback_id = 'other-feedback-id'; }],
  ['absent anchor ID', (r: JsonObject) => { r.feedback_id = 'absent-feedback'; }],
  ['build ID', (r: JsonObject) => { obj(r.applied).buildId = 'c'.repeat(64); }],
  ['stage input hash', (r: JsonObject) => { obj(r.applied).stageInputHash = 'c'.repeat(64); }],
  ['patch bytes', (r: JsonObject) => { (obj(obj(r.applied).patch).ops as JsonObject[])[0]!.value = 'other'; }],
  ['patch hash identity', (r: JsonObject) => { obj(r.applied).patchSha256 = 'c'.repeat(64); }],
  ['model hash', (r: JsonObject) => { obj(r.applied).modelHash = 'c'.repeat(64); }],
  ['producer', (r: JsonObject) => { obj(obj(r.applied).producer).version = '0.0.0-other'; }],
  ['compiler', (r: JsonObject) => { obj(obj(r.applied).compiler).version = '0.0.0-other'; }],
  ['producer line', (r: JsonObject) => { obj(r.applied).line = 'other line'; }],
  ['check summary', (r: JsonObject) => { obj(obj(r.applied).check).gate = false; }],
  ['diff', (r: JsonObject) => { obj(obj(r.applied).diff).paths = ['/other']; }],
  ['files report', (r: JsonObject) => { obj(obj(obj(r.applied).files).images).unchanged = 2; }],
  ['executed op', (r: JsonObject) => { obj(r.applied).op = 'retune'; }],
  ['environment', (r: JsonObject) => { obj(obj(r.applied).environment).steps = 2; }],
  ['omitted files report', (r: JsonObject) => { delete obj(r.applied).files; }],
] as const) {
  test(`session/2 applied-review compares entire retained applied identity: ${name}`, () => {
    const f = commentsChain();
    const before = readFileSync(join(f.dir, 'project.json'));
    change(obj(version(f.project, 2).review_origin));
    expect(checked(f.dir, f.project).refusals.map(finding => finding.code)).toEqual(['APPLIED_REVIEW_RESULT']);
    expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
    expect(readFileSync(join(f.dir, String(f.read.file.path)))).toEqual(f.stdout);
  });
}

test('codec-valid compare-session/2 applied context is not a single-build applied-review origin', () => {
  const f = commentsChain();
  const comparison = commentsComparison(f.session);
  expect<unknown>(parseCommentsCompareSession(comparison)).toEqual(comparison);
  const stdout = Buffer.from(JSON.stringify(comparison, null, 3) + '\n');
  const read = readReview(f.dir, 'synthetic-comparison', () => ({ stdout, stderr: '', exitCode: 0, tool: { name: '@rig-c/review', version: '2.12.0' } }));
  const before = readFileSync(join(f.dir, 'project.json'));
  const origin = obj(version(f.project, 2).review_origin);
  origin.feedback = read.file;
  origin.review_read = read.receipt;
  expect(checked(f.dir, f.project).refusals.map(finding => finding.code)).toEqual(['APPLIED_REVIEW_FILE']);
  expect(readFileSync(join(f.dir, 'project.json'))).toEqual(before);
  expect(readFileSync(join(f.dir, String(read.file.path)))).toEqual(stdout);
});
