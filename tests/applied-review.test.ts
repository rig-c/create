import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkAppliedReview } from '../src/applied-review.ts';
import { checkProject } from '../src/check.ts';
import { type JsonObject } from '../src/templates.ts';
import { fixture, obj, version } from './fixtures.ts';
import { run } from './helpers.ts';

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
  version(project, 2).review_origin = { feedback: { path: 'evidence/applied-feedback.json', sha256: sha(exported.stdout) }, source_version: 1, feedback_id: 'apply-1', applied };
  return { dir, project };
}

test('installed rig-review writes feedback that resolves to the recorded next version', async () => {
  const { dir, project } = await chain();
  expect(checked(dir, project)).toMatchObject({ refusals: [], warnings: [] });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  expect(checkProject(dir).refusals).toEqual([]);
  expect(checkProject(dir).warnings.map(f => f.code)).toEqual(['QUESTION_SET_STALE', 'STAGE_ORDER_LEGACY']);
});

for (const [name, code, mutate] of [
  ['feedback hash', 'APPLIED_REVIEW_HASH', (r: JsonObject) => { obj(r.feedback).sha256 = '0'.repeat(64); }],
  ['missing feedback', 'APPLIED_REVIEW_FILE', (r: JsonObject) => { obj(r.feedback).path = 'evidence/missing.json'; }],
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
  ['export schema', 'APPLIED_REVIEW_FILE', (f: JsonObject) => { f.schema = 'other'; }],
  ['inspected model', 'APPLIED_REVIEW_SOURCE', (f: JsonObject) => { obj(obj(f.reviewedSource).rig).sha256 = 'e'.repeat(64); }],
  ['handoff input', 'APPLIED_REVIEW_SOURCE', (f: JsonObject) => { obj((obj(obj(f.reviewedSource).handoff).files as JsonObject[])[0]).sha256 = 'f'.repeat(64); }],
  ['missing applied context', 'APPLIED_REVIEW_RESULT', (f: JsonObject) => { obj((f.feedback as JsonObject[])[0]).context = {}; }],
  ['duplicate feedback id', 'APPLIED_REVIEW_RESULT', (f: JsonObject) => { (f.feedback as JsonObject[]).push((f.feedback as JsonObject[])[0]!); }],
] as const) {
  test(`refuses changed ${name} even with an updated file hash`, async () => {
    const { dir, project } = await chain();
    const record = obj(version(project, 2).review_origin);
    const file = join(dir, obj(record.feedback).path as string);
    const feedback = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
    mutate(feedback);
    const bytes = JSON.stringify(feedback);
    writeFileSync(file, bytes);
    obj(record.feedback).sha256 = sha(bytes);
    expect(checked(dir, project).refusals.map((f) => f.code)).toContain(code);
  });
}


test('the new-order rig-review hand pass uses the existing applied-review chain', async () => {
  const { dir, project } = await chain('example-project.json');
  expect(checked(dir, project)).toMatchObject({ refusals: [], warnings: [] });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
  const report = checkProject(dir);
  expect(report.refusals).toEqual([]);
  expect(report.warnings).toEqual([]);
});
