/** Ingest a Review comment-only act (rig-review/act@10, #982) into project.json `comments[]`. */
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readFileSync } from './check-reads.ts';
import { asArray, isObject } from './check.ts';
import { commentEntry, commentSource, type CommentOnlyAct } from './comment-record.ts';
import { stageReviewMeshDeltaCorrections } from './correction-writers.ts';
import { readProject } from './feedback.ts';
import { jobHash } from './job-outbox.ts';
import { acquireBoundJobWrite, beginJobProgress } from './job-writer.ts';
import { newRefusals } from './refusal-baseline.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { commentMeshAct, decodeReviewAct, fetchReviewActBytes, reviewActBy, reviewActFindings, reviewActTransport, type ReviewActTransport } from './review-act.ts';
import type { JsonObject } from './templates.ts';

export const COMMENT_HELP = `comment:
  rig-create comment --from-review <actId> [<dir>] [--json]
    Records a Review comment-only act (rig-review/act@10) as one comments[] entry: the words and pins,
    the files that were on screen (saw), and the publication's record hash and commit. A mesh-edits
    carrier is applied through Parts like a Request changes mesh edit, with no verdict. A comment pins
    nothing. WARN COMMENT_COMMIT_MISMATCH when the declared commit does not hold the declared record;
    the comment is kept with record.commit null.`;

export interface CommentHooks {
  /** Test adapter for the finalized act fetch; decoding and identity checks still apply. */
  fetch?: (transport: ReviewActTransport) => { bytes: string };
  /** Reads `<commit>:project.json` from the project's repository; null when git cannot. */
  gitShow?: (root: string, commit: string) => Buffer | null;
}

export interface CommentFinding { code: string; path: string; message: string }

function gitShowProject(root: string, commit: string): Buffer | null {
  // `./` resolves the path against the project folder, so a collection member reads its own record.
  const child = Bun.spawnSync(['git', 'show', `${commit}:./project.json`], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return child.exitCode === 0 ? Buffer.from(child.stdout) : null;
}

/**
 * The commit a comment keeps. Absent commit or absent record hash: null, no WARN.
 * A commit whose project.json does not hash to `source.projectHash`: null, WARN COMMENT_COMMIT_MISMATCH.
 */
export function checkedCommentCommit(root: string, act: CommentOnlyAct, path: string,
  gitShow: CommentHooks['gitShow'] = gitShowProject): { commit: string | null; warning?: CommentFinding } {
  const commit = act.source.commit;
  const projectHash = act.source.projectHash;
  if (commit === undefined || typeof projectHash !== 'string') return { commit: null };
  const bytes = gitShow(root, commit);
  if (bytes !== null && jobHash(bytes) === projectHash) return { commit };
  return { commit: null, warning: { code: 'COMMENT_COMMIT_MISMATCH', path,
    message: `project.json.${path}.record.commit: commit ${commit} ${bytes === null ? 'has no project.json in this repository' : 'holds a project.json that does not hash to the publication\'s projectHash'}; the comment is kept with commit null and stays bound by saw and record.sha256. Commit the record before publishing so later comments carry a commit` } };
}

export function commentCommand(args: string[], now: number, hooks: CommentHooks = {}): { stdout: string; exit: number } {
  let actId: string | undefined;
  let json = false;
  const positional: string[] = [];
  const usage = (): never => refuse('COMMENT_OPTION_INVALID', `project.json.comments: usage: rig-create comment --from-review <actId> [<dir>] [--json]`, USAGE_EXIT);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { if (json) usage(); json = true; }
    else if (arg === '--from-review') { if (actId !== undefined) usage(); actId = args[++i]; if (!actId || actId.startsWith('-')) usage(); }
    else if (arg.startsWith('-')) usage();
    else positional.push(arg);
  }
  if (actId === undefined || positional.length > 1) usage();
  const root = resolve(positional[0] ?? process.cwd());
  const release = acquireBoundJobWrite(root);
  const progress = beginJobProgress(root, 'ingest', 'Reading the Review comment');
  const temporary = join(root, `.rig-create-comment-${randomUUID()}.tmp`);
  let discardMesh: (() => void) | undefined;
  let committed = false;
  try {
    const transport = { ...reviewActTransport(root, actId!), kind: 'comments' as const };
    const bytes = hooks.fetch ? hooks.fetch(transport).bytes : fetchReviewActBytes(transport);
    const act = decodeReviewAct(bytes, 'comments');
    if (act.jobId !== transport.jobId || act.actId !== transport.actId) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: fetched comment act differs from the requested identity; fetch the correct act');
    if (Date.parse(act.at) > now) refuse('REVIEW_ACT_INVALID', 'project.json.review_acts: act is dated in the future; restore the clock before recording');
    const { file } = readProject(root);
    const original = readFileSync(file);
    const project = JSON.parse(original.toString('utf8')) as JsonObject;
    const invalid = reviewActFindings(project)[0];
    if (invalid) refuse(invalid.code, invalid.message);
    const receipts = asArray(project.review_acts);
    const existing = receipts.findIndex(row => isObject(row) && row.jobId === act.jobId && row.actId === act.actId);
    if (existing >= 0) {
      const receipt = receipts[existing] as JsonObject;
      if (receipt.kind !== 'comments' || receipt.bytes !== bytes) refuse('REVIEW_ACT_REPLAY_CONFLICT', `project.json.review_acts[${existing}]: act ${act.jobId}/${act.actId} is already recorded with other bytes; restore the original receipt`);
      const result = { comment: `comments[${String(receipt.comment)}]`, replayed: true };
      return { stdout: json ? JSON.stringify(result, null, 2) : `comment: ${act.actId} already recorded at ${result.comment}`, exit: 0 };
    }
    if (act.value.carriers?.some(carrier => carrier.kind === 'chest-landmarks')) {
      refuse('COMMENT_CARRIER_UNSUPPORTED', `project.json.comments: act ${act.actId} carries chest landmarks; rig-parts bust-landmarks reads only a rig-review/act@9 verdict, so this carrier cannot be applied yet. Withdraw the act with rig-create job withdraw-act ${act.actId} and the owner's relayed words, or wait for a Parts release that reads act@10 carriers`);
    }
    const index = asArray(project.comments).length;
    const path = `comments[${index}]`;
    const checked = checkedCommentCommit(root, act, path, hooks.gitShow);
    const by = reviewActBy(act);
    const entry = commentEntry(act, by, checked.commit);
    const next: JsonObject = { ...structuredClone(project),
      comments: [...asArray(project.comments), entry],
      review_acts: [...receipts, { schema: 'rig-create/review-act@1', kind: 'comments', jobId: act.jobId, actId: act.actId,
        bytes, sha256: jobHash(bytes), comment: index }] };
    const mesh = commentMeshAct(act);
    if (mesh) discardMesh = stageReviewMeshDeltaCorrections(root, project, next, mesh, now);
    const problem = reviewActFindings(next)[0] ?? newRefusals(root, project, next, { now })[0];
    if (problem) refuse(problem.code, problem.message);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    if (!readFileSync(file).equals(original)) refuse('REVIEW_ACT_SOURCE_STALE', 'project.json: record changed during comment validation; retry against the current record');
    renameSync(temporary, file);
    committed = true;
    const corrections = asArray(next.corrections).filter(row => isObject(row) && row.source === commentSource(act)).length;
    const warnings = checked.warning ? [checked.warning] : [];
    progress?.('Review comment recorded');
    const result = { comment: path, entry, corrections, ...(warnings.length ? { warnings } : {}) };
    return { stdout: json ? JSON.stringify(result, null, 2)
      : [...warnings.map(w => `WARN ${w.code}: ${w.message}`),
        `comment: ${act.actId} recorded at ${path} (${act.value.comments.length} comment(s), ${corrections} mesh correction(s), commit ${checked.commit ?? 'null'})`].join('\n'), exit: 0 };
  } finally {
    if (!committed) discardMesh?.();
    rmSync(temporary, { force: true });
    release();
  }
}
