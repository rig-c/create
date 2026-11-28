import { afterEach, expect, test } from 'bun:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_COMMENT_ONLY_ACT_SCHEMA, type ActV3 } from '@rig-c/review/job-host';
import { commentCommand, type CommentHooks } from '../src/comment-act.ts';
import { commentSaw } from '../src/comment-record.ts';
import { actionablePendingAct, pendingJobActs } from '../src/job-acts.ts';
import { currentJobIdentity } from '../src/job-publication.ts';
import { JOB_BINDING_FILE, jobHash, writePrivateJson } from '../src/job-outbox.ts';
import { Refusal } from '../src/refusal.ts';
import { decodeReviewAct, reviewActFindings } from '../src/review-act.ts';
import type { JsonObject } from '../src/templates.ts';
import { checkProject, testClock } from './clock.ts';
import { fixture } from './fixtures.ts';
import { gitEnv } from './helpers.ts';

afterEach(() => testClock.reset());
const JOB = 'synthetic-comment-job';
const ORIGIN = 'http://127.0.0.1:43125';
const load = (dir: string): JsonObject => JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as JsonObject;
const save = (dir: string, p: JsonObject): void => writeFileSync(join(dir, 'project.json'), `${JSON.stringify(p, null, 2)}\n`);

/** A project bound to a synthetic live job, and optionally a git repository holding its record. */
function bound(git = false): { dir: string; commit?: string; recordHash: string } {
  const dir = realpathSync(fixture());
  const identity = currentJobIdentity({ root: dir, stateDir: 'unused-private-state', fingerprint: 'synthetic', reviewer: { id: 'synthetic-owner', role: 'owner' } }, dir);
  writePrivateJson(join(dir, JOB_BINDING_FILE), { schema: 'rig-create/job-binding@1', identity, jobId: JOB, origin: ORIGIN, fetchCapability: 'synthetic-read-grant' }, true);
  const p = load(dir);
  p.review_job = { jobId: JOB, origin: ORIGIN };
  save(dir, p);
  const recordHash = jobHash(readFileSync(join(dir, 'project.json')));
  if (!git) return { dir, recordHash };
  const env = gitEnv({ name: 'Synthetic', email: 'synthetic@example.invalid' });
  const run = (...args: string[]) => {
    const child = Bun.spawnSync(['git', ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  run('init', '-q');
  run('config', 'user.name', 'Synthetic');
  run('config', 'user.email', 'synthetic@example.invalid');
  run('add', '--', 'project.json');
  run('commit', '-q', '-m', 'record', '--', 'project.json');
  return { dir, commit: run('rev-parse', 'HEAD'), recordHash };
}

/** A finalized act@10 the way Review's daemon builds it: no ask, no verdict, the publication's source. */
function commentAct(recordHash: string, extra: { commit?: string; comments?: JsonObject[]; actId?: string } = {}): JsonObject {
  return { schema: JOB_COMMENT_ONLY_ACT_SCHEMA, actId: extra.actId ?? 'comment-act-1', jobId: JOB, publicationId: 'synthetic-publication',
    kind: 'comments', at: testClock.iso(),
    authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
    source: { sourceHash: '1'.repeat(64), projectHash: recordHash, package: { id: 'synthetic-package', revision: 'one' },
      selector: null, model: { path: 'outputs/rig/check/build/skeleton.model.json', sha256: '3'.repeat(64) },
      direction: null, optionSet: null, appliedResult: null, plan: null, parts: null,
      ...(extra.commit === undefined ? {} : { commit: extra.commit }) },
    value: { comments: extra.comments ?? [{ text: 'The left sleeve folds too early.' }, { text: '  좋아요.\r\n' }] } };
}

function served(act: JsonObject): CommentHooks {
  return { fetch: (transport) => {
    expect(transport).toMatchObject({ jobId: JOB, kind: 'comments', fetchCapability: 'synthetic-read-grant' });
    return { bytes: JSON.stringify(act) };
  } };
}

function ingest(dir: string, act: JsonObject, hooks: CommentHooks = served(act)) {
  const result = commentCommand(['--from-review', String(act.actId), dir, '--json'], testClock.now(), hooks);
  return JSON.parse(result.stdout) as JsonObject;
}

function refused(dir: string, action: () => unknown): Refusal {
  const before = readFileSync(join(dir, 'project.json'));
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Refusal);
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
  return caught as Refusal;
}

test('#982 a comment act whose commit holds the declared record keeps the commit, checks clean and replays', () => {
  const { dir, commit, recordHash } = bound(true);
  const act = commentAct(recordHash, { commit });
  const result = ingest(dir, act);
  expect(result.warnings).toBeUndefined();
  expect(result.comment).toBe('comments[0]');
  const project = load(dir);
  const entry = (project.comments as JsonObject[])[0]!;
  expect(entry).toEqual({ source: `review act ${JOB}/comment-act-1`, at: act.at, by: 'user',
    comments: [{ text: 'The left sleeve folds too early.' }, { text: '  좋아요.\r\n' }],
    saw: [{ path: 'outputs/rig/check/build/skeleton.model.json', sha256: '3'.repeat(64) }],
    record: { sha256: recordHash, commit: commit! } });
  expect((project.review_acts as JsonObject[]).at(-1)).toMatchObject({ kind: 'comments', jobId: JOB, actId: 'comment-act-1', comment: 0 });
  expect(reviewActFindings(project)).toEqual([]);
  const before = readFileSync(join(dir, 'project.json'));
  expect(ingest(dir, act)).toEqual({ comment: 'comments[0]', replayed: true });
  expect(readFileSync(join(dir, 'project.json'))).toEqual(before);
});

test('#982 a comment act without a commit records commit null with no WARN', () => {
  const { dir, recordHash } = bound();
  const result = ingest(dir, commentAct(recordHash));
  expect(result.warnings).toBeUndefined();
  expect(((load(dir).comments as JsonObject[])[0]!.record)).toEqual({ sha256: recordHash, commit: null });
  expect(reviewActFindings(load(dir)).map(f => f.code)).toEqual([]);
});

test('#982 a commit that does not hash to projectHash raises WARN COMMENT_COMMIT_MISMATCH and keeps the comment with commit null', () => {
  const { dir, commit } = bound(true);
  // The publication declared another record than the one this commit holds.
  const act = commentAct('4'.repeat(64), { commit });
  const result = ingest(dir, act);
  expect((result.warnings as JsonObject[]).map(w => w.code)).toEqual(['COMMENT_COMMIT_MISMATCH']);
  const entry = (load(dir).comments as JsonObject[])[0]!;
  expect(entry.record).toEqual({ sha256: '4'.repeat(64), commit: null });
  expect(entry.comments).toEqual((act.value as JsonObject).comments);
  expect(reviewActFindings(load(dir))).toEqual([]);
  // A commit unknown to the repository is the same WARN.
  const other = commentAct('4'.repeat(64), { commit: 'f'.repeat(40), actId: 'comment-act-2' });
  expect((ingest(dir, other).warnings as JsonObject[]).map(w => w.code)).toEqual(['COMMENT_COMMIT_MISMATCH']);
});

test('#982 no projectHash: no record hash, no commit check and no WARN', () => {
  const { dir } = bound();
  const act = commentAct('0'.repeat(64), { commit: 'a'.repeat(40) });
  (act.source as JsonObject).projectHash = null;
  let asked = false;
  const result = ingest(dir, act, { ...served(act), gitShow: () => { asked = true; return null; } });
  expect(result.warnings).toBeUndefined();
  expect(asked).toBe(false);
  expect((load(dir).comments as JsonObject[])[0]!.record).toBeNull();
});

test('#982 an empty comment act refuses REVIEW_ACT_INVALID and writes nothing', () => {
  const { dir, recordHash } = bound();
  const act = commentAct(recordHash, { comments: [] });
  expect(() => decodeReviewAct(JSON.stringify(act), 'comments')).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_INVALID' }));
  expect(refused(dir, () => ingest(dir, act)).code).toBe('REVIEW_ACT_INVALID');
});

test('#982 act@10 reaches only the comments route; older writers refuse it and the comments route refuses older acts', () => {
  const { recordHash } = bound();
  const bytes = JSON.stringify(commentAct(recordHash));
  for (const kind of ['review-verdict', 'parts-verdict', 'interview-picks', 'checkpoint', 'signoff'] as const) {
    expect(() => decodeReviewAct(bytes, kind as 'review-verdict')).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_KIND_MISMATCH' }));
  }
  const legacy = { ...JSON.parse(bytes), schema: 'rig-review/act@7' };
  expect(() => decodeReviewAct(JSON.stringify(legacy), 'comments')).toThrow(expect.objectContaining({ code: 'REVIEW_ACT_SCHEMA_UNSUPPORTED' }));
});

test('#982 job acts lists a comment act as actionable on its own, with its comment command', () => {
  const { dir, recordHash } = bound();
  const act = decodeReviewAct(JSON.stringify(commentAct(recordHash)), 'comments') as unknown as ActV3;
  const [row] = pendingJobActs(load(dir), [act], dir);
  expect(row).toMatchObject({ kind: 'comments', subject: '2 comment(s)', command: `rig-create comment ${dir} --from-review comment-act-1` });
  expect(row!.unavailable).toBeUndefined();
  expect(actionablePendingAct(row!)).toBe(true);
  ingest(dir, commentAct(recordHash));
  expect(pendingJobActs(load(dir), [act], dir)).toEqual([]);
});

test('#982 check refuses a tampered comment or an orphan comment', () => {
  const { dir, recordHash } = bound();
  ingest(dir, commentAct(recordHash));
  const project = load(dir);
  const tampered = structuredClone(project);
  ((tampered.comments as JsonObject[])[0]!.comments as JsonObject[])[0]!.text = 'Edited later.';
  expect(reviewActFindings(tampered).map(f => f.code)).toEqual(['REVIEW_ACT_LEDGER_INVALID']);
  const orphan = { ...project, comments: [...(project.comments as JsonObject[]), (project.comments as JsonObject[])[0]!] };
  expect(reviewActFindings(orphan).map(f => f.path)).toContain('comments[1]');
  expect(checkProject(dir, project).refusals.filter(f => f.path.startsWith('comments') || f.path.startsWith('review_acts'))).toEqual([]);
});

test('#982 saw projects the publication file rows, parts images beside the manifest', () => {
  const { recordHash } = bound();
  const act = decodeReviewAct(JSON.stringify(commentAct(recordHash)), 'comments');
  expect(commentSaw(act)).toEqual([{ path: 'outputs/rig/check/build/skeleton.model.json', sha256: '3'.repeat(64) }]);
});
