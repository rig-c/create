/**
 * The two reviews and the hand-off between them (rig-c/create#8,
 * docs/PROJECT.md § Stages, § The rig review rests on a still frame,
 * § The hand-off to post-production).
 *
 * The rig is accepted first, on a still frame with a fixed camera; post work
 * (camera, 2.5D depth, timing, composition) runs only on the rig version that
 * acceptance names. What is recorded where:
 *
 * - **Which rig version was accepted** is the human `accepted` verdict with
 *   `review: "rig-review"` on that `versions[]` entry (kind `rig`). The
 *   `{ stage: "rig-review" }` sign-off moves the stage; the verdict names the
 *   version. Both are written in the same turn.
 * - **What the acceptance rested on** is a `kind: "still"` entry in that
 *   version's `evidence[]`: `path`, `sha256`, `camera: "fixed"`, `frame`.
 * - **Which rig the post work is on** is a post version's `rig_version`, and
 *   `rig-create handoff` is what post tooling asks before it runs.
 *
 * `checkReviews` runs inside `interview --check`; `handoff` is the command.
 * Both read the record only: nothing is rendered or signed here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { checkPreInterview } from './pre-interview.ts';
import { refuse, USAGE_EXIT } from './refusal.ts';
import { PAUSED_STAGE, RIG_REVIEW, stageIndex } from './stages.ts';
import type { Json, JsonObject } from './templates.ts';

/** The part of `interview --check`'s context this module reads and writes. */
export interface ReviewCtx {
  readonly project: JsonObject;
  readonly effectiveStage: string;
  readonly refusals: { code: string; path: string; message: string }[];
}

const SHA256 = /^[0-9a-f]{64}$/;

export interface Acceptance {
  readonly verdict: number;
  readonly by: string;
  readonly at: string;
  readonly verbatim: string | null;
  readonly source?: string;
  readonly note?: string;
}

export interface Still {
  readonly evidence: number;
  readonly path: string;
  readonly sha256: string;
  /** Seconds into the motion, or `setup`: the renderer's setup pose, which an idle may pass through rather than start at. */
  readonly frame: number | 'setup';
}

export interface RigVersion {
  readonly preInterview: boolean;
  readonly n: number;
  readonly path: string;
  /** The last human `accepted` verdict at `rig-review`, or `null`. */
  readonly accepted: Acceptance | null;
  /** The well-formed still-frame evidence entries. */
  readonly stills: Still[];
  readonly malformedStills: { index: number; why: string }[];
}

export interface PostVersion {
  readonly n: number;
  readonly path: string;
  readonly at: string | null;
  readonly rigVersion: Json | undefined;
}

export interface Versions {
  readonly rigs: RigVersion[];
  readonly posts: PostVersion[];
  readonly malformed: { path: string; why: string }[];
}

function isObject(v: Json | undefined): v is JsonObject {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}
function asArray(v: Json | undefined): Json[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: Json | undefined): string | null {
  return typeof v === 'string' ? v : null;
}
function isHuman(by: string | null): by is string {
  return by !== null && by.toLowerCase() !== 'agent';
}

function readStill(e: JsonObject): Still | string {
  const missing = ['path', 'sha256'].filter((k) => asString(e[k]) === null);
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  if (!SHA256.test(e.sha256 as string)) return 'sha256 is not 64 lowercase hex digits';
  if (e.camera !== 'fixed') return `camera is ${JSON.stringify(e.camera ?? null)}; the rig review is on a fixed camera ("camera": "fixed")`;
  if (e.frame === 'setup') return { evidence: -1, path: e.path as string, sha256: e.sha256 as string, frame: 'setup' };
  if (typeof e.frame !== 'number' || !Number.isFinite(e.frame) || e.frame < 0) {
    return `frame is ${JSON.stringify(e.frame ?? null)}; it is "setup" for the renderer's setup pose, or the time in seconds into the motion the still is posed at (0 is the motion's start, not necessarily the setup pose)`;
  }
  return { evidence: -1, path: e.path as string, sha256: e.sha256 as string, frame: e.frame };
}

/** Reads `versions[]` into rig and post versions, in record order. Paths name a version by its number: `versions[v2]`. */
export function readVersions(project: JsonObject): Versions {
  const rigs: RigVersion[] = [];
  const posts: PostVersion[] = [];
  const malformed: { path: string; why: string }[] = [];
  asArray(project.versions).forEach((v, index) => {
    if (!isObject(v) || typeof v.n !== 'number' || !Number.isInteger(v.n)) {
      malformed.push({ path: `versions[${index}]`, why: 'a version is an object with an integer n' });
      return;
    }
    const path = `versions[v${v.n}]`;
    if (v.kind === 'post') {
      posts.push({ n: v.n, path, at: asString(v.at), rigVersion: v.rig_version });
      return;
    }
    if (v.kind !== 'rig') {
      malformed.push({ path, why: `kind is 'rig' or 'post', got ${JSON.stringify(v.kind ?? null)}` });
      return;
    }
    if (v.rig_version !== null && v.rig_version !== undefined) {
      malformed.push({ path: `${path}.rig_version`, why: 'a rig version has rig_version null; only a post version names the rig it is built on' });
    }
    // The LAST human rig-review verdict decides: a later bounce withdraws an
    // earlier acceptance. An acceptance must be dated, or the post-before-
    // acceptance order cannot be checked.
    let accepted: Acceptance | null = null;
    for (const [verdict, d] of asArray(v.verdicts).entries()) {
      if (!isObject(d) || d.review !== RIG_REVIEW || !isHuman(asString(d.by)) || d.verdict === 'provisional') continue;
      if (d.verdict !== 'accepted') {
        accepted = null;
        continue;
      }
      const at = asString(d.at);
      if (at === null || !Number.isFinite(Date.parse(at))) {
        malformed.push({ path: `${path}.verdicts[${verdict}].at`, why: 'an acceptance carries a valid `at`; an undated acceptance authorises nothing' });
        accepted = null;
        continue;
      }
      accepted = { verdict, by: d.by as string, at, verbatim: asString(d.verbatim) ?? '' };
      if (v.pre_interview === true) {
        accepted = { ...accepted, verbatim: asString(d.verbatim), source: asString(d.source) ?? '', note: asString(d.note) ?? undefined };
      }
    }
    const stills: Still[] = [];
    const malformedStills: { index: number; why: string }[] = [];
    asArray(v.evidence).forEach((e, i) => {
      if (!isObject(e) || e.kind !== 'still') return;
      const read = readStill(e);
      if (typeof read === 'string') malformedStills.push({ index: i, why: read });
      else stills.push({ ...read, evidence: i });
    });
    rigs.push({ n: v.n, path, preInterview: v.pre_interview === true, accepted, stills, malformedStills });
  });
  return { rigs, posts, malformed };
}

/** The rig version with the highest number, accepted or not. */
function latestRig(versions: Versions): RigVersion | null {
  return versions.rigs.reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
}
/** The accepted rig version with the highest number. */
export function latestAccepted(versions: Versions): RigVersion | null {
  return versions.rigs.filter((r) => r.accepted !== null).reduce<RigVersion | null>((a, r) => (a === null || r.n > a.n ? r : a), null);
}

/** Why a post version's `rig_version` is not an accepted rig, or `null` when it is. */
function postBasisProblem(post: PostVersion, versions: Versions): string | null {
  const rv = post.rigVersion;
  if (typeof rv !== 'number' || !Number.isInteger(rv)) {
    return `${post.path}.rig_version is ${JSON.stringify(rv ?? null)}; a post version names the n of the accepted rig version it is built on`;
  }
  const rig = versions.rigs.find((r) => r.n === rv);
  if (rig === undefined) return `${post.path}.rig_version=v${rv} names no rig version`;
  if (rig.accepted === null) {
    return `${post.path}.rig_version=v${rv}: rig v${rv} has no accepted rig-review verdict; post work runs only on a rig version the user accepted at rig-review`;
  }
  const builtAt = post.at === null ? Number.NaN : Date.parse(post.at);
  const acceptedAt = Date.parse(rig.accepted.at);
  if (!Number.isFinite(builtAt)) {
    return `${post.path}.at is ${JSON.stringify(post.at)}; a post version is dated, or it cannot be shown to follow rig v${rv}'s acceptance`;
  }
  if (builtAt < acceptedAt) {
    return `${post.path}.rig_version=v${rv}: v${post.n} was built at ${post.at}, before rig v${rv} was accepted at ${rig.accepted.at}`;
  }
  return null;
}

// ------------------------------------------------------- interview --check

/** The review-order refusals, appended to `ctx.refusals` (codes in docs/CHECKS.md § Refusals). */
export function checkReviews(ctx: ReviewCtx): void {
  const versions = readVersions(ctx.project);
  const push = (code: string, path: string, message: string): void => {
    ctx.refusals.push({ code, path, message });
  };
  for (const m of versions.malformed) push('VERSION_MALFORMED', m.path, `${m.path}: ${m.why}`);

  for (const rig of versions.rigs) {
    for (const m of rig.malformedStills) {
      const path = `${rig.path}.evidence[${m.index}]`;
      push('STILL_MALFORMED', path, `${path}: a still-frame record is { kind: "still", path, sha256, camera: "fixed", frame }; ${m.why}`);
    }
    if (rig.accepted !== null && rig.stills.length === 0) {
      const path = `${rig.path}.verdicts[${rig.accepted.verdict}]`;
      push(
        'RIG_ACCEPTED_WITHOUT_STILL',
        path,
        `${path}: rig v${rig.n} is accepted at rig-review, but its evidence[] has no still-frame record ({ kind: "still", path, sha256, camera: "fixed", frame }); the rig review rests on a still frame`,
      );
    }
  }

  for (const post of versions.posts) {
    const problem = postBasisProblem(post, versions);
    if (problem !== null) push('POST_ON_UNACCEPTED_RIG', `${post.path}.rig_version`, problem);
  }

  // Past rig-review, the rig the project stands on is the latest one, and it is accepted.
  const reviewIdx = stageIndex(RIG_REVIEW);
  const cur = stageIndex(ctx.effectiveStage);
  if (ctx.effectiveStage !== PAUSED_STAGE && cur > reviewIdx) {
    const latest = latestRig(versions);
    if (latest === null) {
      push('RIG_VERSION_UNACCEPTED', 'versions', `stage is past rig-review, but versions[] has no rig version for the review to have accepted`);
    } else if (latest.accepted === null) {
      push(
        'RIG_VERSION_UNACCEPTED',
        latest.path,
        `rig v${latest.n} is the latest rig version and has no accepted rig-review verdict, but the stage is past rig-review; a rig change after rig-review is a new first review — the stage goes back to rig-review`,
      );
    }
  }

  // The current post version is on the current accepted rig; older post versions are history.
  const accepted = latestAccepted(versions);
  const currentPost = versions.posts.reduce<PostVersion | null>((a, p) => (a === null || p.n > a.n ? p : a), null);
  if (accepted !== null && currentPost !== null && postBasisProblem(currentPost, versions) === null && currentPost.rigVersion !== accepted.n) {
    push(
      'POST_ON_SUPERSEDED_RIG',
      `${currentPost.path}.rig_version`,
      `${currentPost.path}.rig_version=v${String(currentPost.rigVersion)}: rig v${accepted.n} was accepted since; the post work built on the old rig is redone on v${accepted.n}`,
    );
  }
}

// ------------------------------------------------------------------ handoff

export interface Handoff {
  readonly ok: true;
  readonly project_dir: string;
  readonly rig_version: number;
  readonly pre_interview: boolean;
  readonly accepted: Acceptance;
  readonly still: Still;
}

/**
 * The hand-off: the one rig version post work may run on, or a named refusal.
 * With `rig`, also refuses when that is not the version.
 */
export function handoff(projectDirArg: string, rig: number | null): Handoff {
  const dir = resolve(projectDirArg);
  const file = join(dir, 'project.json');
  if (!existsSync(file)) refuse('PROJECT_JSON_MISSING', `${file} does not exist; run in a project folder or name one`);
  let project: unknown;
  try {
    project = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    refuse('PROJECT_JSON_INVALID', `${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(project as Json)) refuse('PROJECT_JSON_INVALID', `${file}: not a JSON object`);
  const record = project as JsonObject;
  const historyRefusals: ReviewCtx['refusals'] = [];
  checkPreInterview({ dir, project: record, refusals: historyRefusals });
  const first = historyRefusals[0];
  if (first !== undefined) refuse(first.code, first.message);

  const signed = asArray(record.signoffs).some(
    (s) => isObject(s) && s.stage === RIG_REVIEW && (s.checkpoint ?? null) === null && isHuman(asString(s.by)) && asString(s.verbatim) !== null,
  );
  if (!signed) refuse('RIG_REVIEW_UNSIGNED', `no human { "stage": "rig-review" } sign-off: no rig version has been handed to post-production`);

  const versions = readVersions(record);
  const accepted = latestAccepted(versions);
  const latest = latestRig(versions);
  if (accepted === null || accepted.accepted === null) {
    refuse('RIG_VERSION_UNACCEPTED', `rig-review is signed, but no rig version has an accepted rig-review verdict naming it`);
  }
  if (latest !== null && latest.n !== accepted.n) {
    refuse(
      'RIG_VERSION_UNACCEPTED',
      `${latest.path}: rig v${latest.n} was built after rig v${accepted.n} was accepted and has no rig-review acceptance of its own; review it on its still frame before post work runs`,
    );
  }
  const still = accepted.stills[0];
  if (still === undefined) {
    refuse('RIG_ACCEPTED_WITHOUT_STILL', `${accepted.path}: rig v${accepted.n} is accepted with no still-frame record in its evidence[]`);
  }
  if (rig !== null && rig !== accepted.n) {
    const named = versions.rigs.find((r) => r.n === rig);
    if (named !== undefined && named.accepted !== null) {
      refuse('POST_ON_SUPERSEDED_RIG', `versions[v${rig}]: rig v${rig} was accepted, but rig v${accepted.n} was accepted since; post work runs on v${accepted.n}`);
    }
    refuse('POST_ON_UNACCEPTED_RIG', `versions[v${rig}]: ${named === undefined ? 'no rig version has that number' : `rig v${rig} has no accepted rig-review verdict`}; post work runs on rig v${accepted.n}`);
  }
  return { ok: true, project_dir: dir, rig_version: accepted.n, pre_interview: accepted.preInterview, accepted: accepted.accepted, still };
}

export const HANDOFF_HELP = `handoff:
  [<project dir>]  the project folder (default: the current directory)
  --rig <n>        refuse unless rig version <n> is the one post work may run on
  --json           print the hand-off as JSON (rig_version, accepted, still)
  Post-production tooling runs this first. Exit 0 prints the accepted rig version; exit 1 is a named refusal
  (RIG_REVIEW_UNSIGNED, RIG_VERSION_UNACCEPTED, RIG_ACCEPTED_WITHOUT_STILL, POST_ON_UNACCEPTED_RIG, POST_ON_SUPERSEDED_RIG).`;

export function handoffCommand(args: string[]): { stdout: string; exit: number } {
  let json = false;
  let rig: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (arg === '--rig') {
      const value = args[++i];
      const n = value === undefined ? Number.NaN : Number(value.replace(/^v/, ''));
      if (!Number.isInteger(n) || n < 1) refuse('HANDOFF_RIG_INVALID', `--rig takes a rig version number, got ${value ?? 'nothing'}`, USAGE_EXIT);
      rig = n;
    } else if (arg.startsWith('-')) refuse('UNKNOWN_OPTION', `handoff does not take ${arg}`, USAGE_EXIT);
    else positional.push(arg);
  }
  if (positional.length > 1) refuse('HANDOFF_TOO_MANY_ARGUMENTS', `handoff takes one folder, got ${positional.join(' ')}`, USAGE_EXIT);
  const h = handoff(positional[0] ?? process.cwd(), rig);
  if (json) return { stdout: JSON.stringify(h, null, 2), exit: 0 };
  return {
    stdout: [
      `handoff: post work is on rig v${h.rig_version}${h.pre_interview ? ' (pre-interview)' : ''}`,
      `  accepted at rig-review by ${h.accepted.by} at ${h.accepted.at}: ${h.accepted.verbatim === null ? `record of the user: ${h.accepted.note}` : `"${h.accepted.verbatim}"`}`,
      ...(h.pre_interview ? [`  source: ${h.accepted.source}`] : []),
      `  still frame ${h.still.path} (sha256 ${h.still.sha256}, fixed camera, ${h.still.frame === 'setup' ? 'setup pose' : `${h.still.frame} s`})`,
    ].join('\n'),
    exit: 0,
  };
}
